#!/usr/bin/env bash
# GamePingBooster - One-Click VPS Relay Setup Script
# Works on Ubuntu 20.04 / 22.04 / 24.04 and Debian 11 / 12

set -euo pipefail

say()  { echo -e "\033[1;32m[GPB-RELAY]\033[0m $*"; }
warn() { echo -e "\033[1;33m[WARNING]\033[0m $*" >&2; }
die()  { echo -e "\033[1;31m[ERROR]\033[0m $*" >&2; exit 1; }

if [ "$EUID" -ne 0 ]; then
    die "This script must be run as root. Try: sudo $0"
fi

PORT=51820
MODE="token"
NAME="Auto Relay"
LOCATION="Singapore"
LICENCE_KEY="/etc/relayd/licence.pub"
PSK=""
BACKEND_URL="https://gameapi.anikenji.tech"
SUBNET="10.77.0.0/16"
RELAY_IP="10.77.0.1"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --name) NAME="$2"; shift 2 ;;
        --location) LOCATION="$2"; shift 2 ;;
        --port) PORT="$2"; shift 2 ;;
        --mode) MODE="$2"; shift 2 ;;
        --licence-key) LICENCE_KEY="$2"; shift 2 ;;
        --psk) PSK="$2"; shift 2 ;;
        --backend-url) BACKEND_URL="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: sudo $0 [--name <name>] [--location <loc>] [--port <port>] [--mode token|psk] [--backend-url <url>]"
            exit 0
            ;;
        *) die "Unknown parameter: $1" ;;
    esac
done

say "Starting GamePingBooster Relay setup for $NAME ($LOCATION)..."

# Auto-fetch licence.pub from backend if requested
if [ "$MODE" = "token" ] && [ -n "$BACKEND_URL" ] && [ ! -f "$LICENCE_KEY" ]; then
    say "Fetching licence public key from $BACKEND_URL/api/v1/licence.pub..."
    mkdir -p "$(dirname "$LICENCE_KEY")"
    curl -sSL "$BACKEND_URL/api/v1/licence.pub" -o "$LICENCE_KEY" 2>/dev/null || \
    warn "Could not download licence.pub automatically. Please place it at $LICENCE_KEY"
fi

# 1. Detect primary network interface
WAN_IFACE=$(ip route get 8.8.8.8 2>/dev/null | awk '{for(i=1;i<=NF;i++)if($i=="dev")print $(i+1)}' | head -n1)
if [ -z "$WAN_IFACE" ]; then
    WAN_IFACE=$(ip route | grep default | awk '{print $5}' | head -n1)
fi
say "Detected WAN network interface: $WAN_IFACE"

# 2. Kernel sysctl optimizations for ultra-low latency gaming
say "Configuring kernel optimizations (fq + bbr + large UDP socket buffers)..."
cat << 'EOF' > /etc/sysctl.d/99-gamepingbooster-relay.conf
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 0
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.core.rmem_default = 16777216
net.core.wmem_default = 16777216
net.core.somaxconn = 65535
net.core.netdev_max_backlog = 100000
net.netfilter.nf_conntrack_max = 1048576
net.ipv4.udp_rmem_min = 16384
net.ipv4.udp_wmem_min = 16384
EOF

sysctl --system >/dev/null 2>&1 || true

# 3. Setup NAT Masquerade
say "Setting up NAT / MASQUERADE for TUN subnet $SUBNET on $WAN_IFACE..."
which iptables >/dev/null 2>&1 || (apt-get update -y && apt-get install -y iptables iptables-persistent)

iptables -t nat -C POSTROUTING -s "$SUBNET" -o "$WAN_IFACE" -j MASQUERADE 2>/dev/null || \
iptables -t nat -A POSTROUTING -s "$SUBNET" -o "$WAN_IFACE" -j MASQUERADE

iptables -C FORWARD -s "$SUBNET" -j ACCEPT 2>/dev/null || \
iptables -A FORWARD -s "$SUBNET" -j ACCEPT

iptables -C FORWARD -d "$SUBNET" -m state --state RELATED,ESTABLISHED 2>/dev/null || \
iptables -A FORWARD -d "$SUBNET" -m state --state RELATED,ESTABLISHED

if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
fi

# 4. Download relayd binary
say "Downloading relayd binary from $BACKEND_URL/bin/relayd..."
curl -sSL "$BACKEND_URL/bin/relayd" -o /usr/local/bin/relayd || curl -sSL "$BACKEND_URL/relayd" -o /usr/local/bin/relayd
chmod +x /usr/local/bin/relayd

# 5. Prepare /etc/relayd
mkdir -p /etc/relayd
mkdir -p /var/log/relayd

if [ "$MODE" = "psk" ] && [ -n "$PSK" ]; then
    echo -n "$PSK" > /etc/relayd/psk.key
    chmod 600 /etc/relayd/psk.key
fi

# 5. Create systemd service
say "Installing systemd service /etc/systemd/system/relayd.service..."
cat << EOF > /etc/systemd/system/relayd.service
[Unit]
Description=GamePingBooster UDP Relay Daemon
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/etc/relayd
LimitNOFILE=1048576
LimitNPROC=524288
Restart=always
RestartSec=3s
ExecStart=/usr/local/bin/relayd -listen 0.0.0.0:${PORT} -tun gpb0 -tun-ip ${RELAY_IP} -subnet ${SUBNET} $( [ "$MODE" = "psk" ] && echo "-psk-file /etc/relayd/psk.key" || echo "-licence-key ${LICENCE_KEY}" )

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
say "Relay setup completed successfully!"

PUBLIC_IP=$(curl -s4 ifconfig.me || curl -s4 icanhazip.com || echo "UNKNOWN")
say "Public IP: $PUBLIC_IP:$PORT"

if [ -n "$BACKEND_URL" ]; then
    say "Registering relay to Backend Server: $BACKEND_URL..."
    curl -s -X POST "$BACKEND_URL/api/v1/relays/register" \
         -H "Content-Type: application/json" \
         -d "{\"id\":\"relay-$(echo "$PUBLIC_IP" | tr '.' '-')\",\"name\":\"$NAME\",\"location\":\"$LOCATION\",\"endpoint\":\"$PUBLIC_IP:$PORT\",\"minTier\":0}" || warn "Could not reach backend server."
fi

say "=========================================================="
say "GamePingBooster Relay is configured for: $NAME"
say "Endpoint: $PUBLIC_IP:$PORT"
say "To start: sudo systemctl start relayd"
say "To enable at boot: sudo systemctl enable relayd"
say "=========================================================="
