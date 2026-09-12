# GSP - GameStablePing: Relay Server Setup & Testing Guide (For AI Agents / DevOps)

> **Mục tiêu**: Hướng dẫn kỹ thuật chuẩn xác để AI Agent hoặc Kỹ sư DevOps thiết lập, cấu hình tường lửa, khắc phục sự cố và kiểm thử hoạt động của máy chủ **Relay Server (Data Plane)** cho hệ thống **GSP - GameStablePing**.

---

## 1. TỔNG QUAN DỰ ÁN & VAI TRÒ CỦA RELAY SERVER

* **Dự án**: **GSP - GameStablePing** (Phần mềm giảm ping và ổn định độ trễ game không can thiệp bộ nhớ).
* **Mô hình 2 mặt phẳng (Split-Plane Architecture)**:
  1. **Control Plane (Backend Web & Licence Server)**: Đang chạy tại `https://gameapi.anikenji.tech` (cấp phép token, phân phối profile dải IP, quản trị danh sách VPS).
  2. **Data Plane (Relay Server trên VPS Linux)**: Chạy daemon `relayd` (viết bằng Go), mở card mạng ảo TUN (`gpb0`), lắng nghe UDP trên cổng `51820`, bóc tách header gói tin và chuyển tiếp lưu lượng game ra internet thông qua NAT/MASQUERADE.
* **Giao thức mạng**: **UDP Wire Protocol v3**.
  * Chế độ xác thực: **Token Mode** (`-licence-key`).
  * Khách hàng kết nối bắt buộc phải mang **150-byte Token** có chữ ký số ECDSA P-256 từ Master Licence Server.
  * Relay ký trả lời bằng cặp khóa riêng của nó (`/etc/gpb/relay.key`).

---

## 2. THÔNG SỐ MẬT MÃ & KHÓA BẮT BUỘC (CRITICAL SECRETS)

Để Relay hoạt động được với ứng dụng và Backend hiện tại, máy chủ Relay **phải cấu hình chính xác 2 khóa**:

### 2.1. Master Licence Public Key (Dùng để xác minh Token người dùng)
* **File lưu trên VPS**: `/etc/relayd/licence.hex`
* **Định dạng**: Chuỗi Hex 130 ký tự (tương ứng 65 bytes uncompressed P-256 point `0x04 || X || Y`).
* **Giá trị chuẩn của hệ thống**:
```text
042acbb1f004e7914f0923f6fadb7b9945301dfdcdc610707c2527a8d6e2a4eb3e183be3c1237267e84cea0a53b7214a9e329265403033bd190aa3e2efbc6e65cf
```

### 2.2. Relay Keypair (Cặp khóa riêng của từng Relay VPS)
* **File lưu trên VPS**: `/etc/gpb/relay.key` (Quyền `0600`).
* Do `relayd` tự động sinh ra khi chạy lần đầu nếu chưa có.
* **Lấy Public Key của Relay để khai báo lên hệ thống**:
  ```bash
  sudo /usr/local/bin/relayd -print-relay-key
  ```
  *(Lệnh này in ra chuỗi Hex 130 ký tự của Relay, chuỗi này BẮT BUỘC phải được đăng ký vào Backend Server).*

---

## 3. CÁC NGUYÊN NHÂN GÂY LỖI PHỔ BIẾN & CÁCH KHẮC PHỤC TRIỆT ĐỂ

Khi app báo: *"The relay at IP:51820 did not answer after 4 attempts..."*

### Nguyên nhân 1: Tường lửa phần cứng Cloud (Ví dụ: Oracle Cloud VCN Security List)
* **Triệu chứng**: Gói UDP bị drop ở router bên ngoài, `tcpdump` trên VPS không thấy bất kỳ gói tin nào tới.
* **Cách sửa trên Cloud Console**:
  * Vào **VCN Security Lists** $\to$ **Default Security List** $\to$ **Add Ingress Rules**.
  * **Source CIDR**: `0.0.0.0/0`
  * **IP Protocol**: `UDP`
  * **Source Port Range**: **ĐỂ TRỐNG HOÀN TOÀN (BLANK)** *(Tuyệt đối không điền 51820 vào Source Port, vì máy người chơi gửi từ cổng ngẫu nhiên)*.
  * **Destination Port Range**: `51820`

### Nguyên nhân 2: Tường lửa hệ điều hành Ubuntu/Debian chặn UDP (REJECT icmp-host-prohibited)
* **Triệu chứng**: Khi gửi UDP từ ngoài vào, terminal trả về lỗi `read: no route to host`.
* **Cách sửa trên VPS**:
  ```bash
  # Chèn rule ACCEPT lên ĐẦU TIÊN của bảng INPUT (tránh bị rule REJECT ở cuối chặn):
  sudo iptables -I INPUT 1 -p udp --dport 51820 -j ACCEPT
  sudo iptables -I FORWARD 1 -s 10.77.0.0/16 -j ACCEPT
  sudo iptables -I FORWARD 1 -d 10.77.0.0/16 -j ACCEPT
  sudo netfilter-persistent save 2>/dev/null || true
  ```

### Nguyên nhân 3: Cờ tham số `relayd` không hợp lệ
* **Lưu ý**: `relayd` **KHÔNG CÓ CỜ `-tun-ip`**.
* Cờ hợp lệ duy nhất:
  ```bash
  /usr/local/bin/relayd -listen 0.0.0.0:51820 -tun gpb0 -subnet 10.77.0.0/16 -licence-key /etc/relayd/licence.hex
  ```

---

## 4. QUY TRÌNH SETUP TỰ ĐỘNG CHUẨN XÁC (STEP-BY-STEP)

Agent thực thi các lệnh sau với quyền `root` trên VPS:

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "=== 1. TẢI FILE BINARY RELAYD CHUẨN ==="
mkdir -p /usr/local/bin
curl -sSL "https://gameapi.anikenji.tech/bin/relayd" -o /usr/local/bin/relayd
chmod +x /usr/local/bin/relayd

echo "=== 2. TỐI ƯU KERNEL SYSCTL CHO GAMING (FQ + BBR + 64MB UDP BUFFER) ==="
cat << 'EOF' > /etc/sysctl.d/99-gsp-relay.conf
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

echo "=== 3. CẤU HÌNH NAT MASQUERADE VÀ MỞ TƯỜNG LỬA ==="
WAN_IFACE=$(ip route get 8.8.8.8 | awk '{for(i=1;i<=NF;i++)if($i=="dev")print $(i+1)}' | head -n1)
which iptables >/dev/null 2>&1 || (apt-get update -y && apt-get install -y iptables iptables-persistent)

# Mở cổng UDP 51820 lên đầu chuỗi
iptables -I INPUT 1 -p udp --dport 51820 -j ACCEPT
iptables -t nat -A POSTROUTING -s 10.77.0.0/16 -o "$WAN_IFACE" -j MASQUERADE
iptables -I FORWARD 1 -s 10.77.0.0/16 -j ACCEPT
iptables -I FORWARD 1 -d 10.77.0.0/16 -m state --state RELATED,ESTABLISHED -j ACCEPT

netfilter-persistent save >/dev/null 2>&1 || true

echo "=== 4. TẠO THƯ MỤC CẤU HÌNH & GHI MASTER LICENCE KEY ==="
mkdir -p /etc/relayd
mkdir -p /etc/gpb
chmod 700 /etc/gpb

# Ghi chính xác 130 ký tự hex của Master Licence Public Key
echo -n "042acbb1f004e7914f0923f6fadb7b9945301dfdcdc610707c2527a8d6e2a4eb3e183be3c1237267e84cea0a53b7214a9e329265403033bd190aa3e2efbc6e65cf" > /etc/relayd/licence.hex
chmod 644 /etc/relayd/licence.hex

echo "=== 5. CÀI ĐẶT DỊCH VỤ SYSTEMD (relayd.service) ==="
cat << 'EOF' > /etc/systemd/system/relayd.service
[Unit]
Description=GSP GameStablePing UDP Relay Daemon
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
ExecStart=/usr/local/bin/relayd -listen 0.0.0.0:51820 -tun gpb0 -subnet 10.77.0.0/16 -licence-key /etc/relayd/licence.hex

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable relayd
systemctl restart relayd
```

---

## 5. BƯỚC KHAI BÁO PUBLIC KEY CỦA RELAY VỀ BACKEND

Sau khi dịch vụ khởi động, Agent **BẮT BUỘC** lấy Public Key của máy chủ này và gọi API đăng ký:

```bash
# 1. Lấy Public Key của Relay (130 ký tự Hex)
RELAY_PUB_KEY=$(/usr/local/bin/relayd -print-relay-key)
echo "Relay Public Key: $RELAY_PUB_KEY"

# 2. Lấy Public IP của VPS
PUBLIC_IP=$(curl -s4 ifconfig.me || curl -s4 icanhazip.com)
echo "Public IP: $PUBLIC_IP"

# 3. Đăng ký tự động vào Backend Server
curl -s -X POST "https://gameapi.anikenji.tech/api/v1/relays/register" \
  -H "Content-Type: application/json" \
  -d "{
    "id": "relay-$(echo "$PUBLIC_IP" | tr '.' '-')",
    "name": "Tokyo Relay 1 (Japan)",
    "location": "Tokyo, Japan",
    "endpoint": "$PUBLIC_IP:51820",
    "publicKey": "$RELAY_PUB_KEY",
    "minTier": 0
  }"
```

---

## 6. BỘ LỆNH KIỂM THỬ TẠI CHỖ CHO AGENT (VERIFICATION CHECKLIST)

Agent chạy lần lượt các lệnh sau để tự đánh giá:

1. **Kiểm tra tiến trình và card mạng TUN**:
   ```bash
   systemctl is-active relayd    # Phải trả về 'active'
   ip addr show gpb0            # Phải có interface gpb0 mang IP 10.77.0.1/16
   ss -tulpn | grep 51820       # Phải thấy relayd đang LISTEN trên 0.0.0.0:51820
   ```

2. **Kiểm tra nhật ký xem đã tải key thành công chưa**:
   ```bash
   journalctl -u relayd -n 20 --no-pager | grep -i "public_key"
   ```
   *(Phải thấy dòng: `level=INFO msg="relay identity loaded" public_key=...`)*

3. **Kiểm tra bắt gói tin trực tiếp khi app Windows kết nối**:
   ```bash
   sudo tcpdump -n -i any port 51820 -c 5
   ```
   *(Bấm Connect trên app Windows: `tcpdump` phải in ra các gói tin UDP đến và đi, chứng tỏ tường lửa đã thông).*

---

> 🎯 **Hoàn tất**: Khi checklist trên đều đạt, ứng dụng Windows sẽ ngay lập tức kết nối thành công, nhận IP ảo `10.77.0.x` và hiển thị trạng thái kết nối màu xanh lá cây!
