# GamePingBooster - Tổng Quan Hệ Thống & Kế Hoạch Nâng Cấp Toàn Diện

> **Tài liệu bàn giao & Định hướng phát triển (Context Document for AI Agents / Developers)**  
> **Repository gốc**: [https://github.com/VietNguyenR/GamePingBooster](https://github.com/VietNguyenR/GamePingBooster)  
> **Thư mục làm việc trên VPS**: `/home/ubuntu/GamePingBooster`  
> **Thời gian cập nhật**: 12/09/2026  

---

## MỤC LỤC
1. [Giới Thiệu & Bài Toán Giải Quyết](#1-giới-thiệu--bài-toán-giải-quyết)
2. [Kiến Trúc Kỹ Thuật Chi Tiết](#2-kiến-trúc-kỹ-thuật-chi-tiết)
   - [2.1 Luồng Đi Của Gói Tin (Packet Flow)](#21-luồng-đi-của-gói-tin-packet-flow)
   - [2.2 Cấu Trúc Các Tiến Trình (Three-Tier Architecture)](#22-cấu-trúc-các-tiến-trình-three-tier-architecture)
   - [2.3 Giao Thức Mạng Dây (Wire Protocol v2 / v3)](#23-giao-thức-mạng-dây-wire-protocol-v2--v3)
3. [Hiện Trạng Hệ Thống Đã Thiết Lập Trên VPS](#3-hiện-trạng-hệ-thống-đã-thiết-lập-trên-vps)
4. [Các Module Đã Bổ Sung / Cải Tiến](#4-các-module-đã-bổ-sung--cải-tiến)
   - [4.1 Tự Động Quét Socket Game (DynamicGameDetector.cs)](#41-tự-động-quét-socket-game-dynamicgamedetectorcs)
   - [4.2 Tự Động Nạp Định Tuyến /32 (TunnelEngine.cs)](#42-tự-động-nạp-định-tuyến-32-tunnelenginecs)
5. [Kế Hoạch Nâng Cấp Chi Tiết (Roadmap Cho Agent Mới)](#5-kế-hoạch-nâng-cấp-chi-tiết-roadmap-cho-agent-mới)
   - [Pha 1: Mở Rộng Đa Game (Multi-Game Support)](#pha-1-mở-rộng-đa-game-multi-game-support)
   - [Pha 2: Tự Động Kết Nối Khi Mở App (Auto-Connect on Launch)](#pha-2-tự-động-kết-nối-khi-mở-app-auto-connect-on-launch)
   - [Pha 3: Xây Dựng Licence & Subscription Server Độc Lập](#pha-3-xây-dựng-licence--subscription-server-độc-lập)
   - [Pha 4: Đóng Gói Bộ Cài Thương Mại (Installer Pipeline)](#pha-4-đóng-gói-bộ-cài-thương-mại-installer-pipeline)
6. [Tài Liệu Tham Khảo File & API](#6-tài-liệu-tham-khảo-file--api)

---

## 1. Giới Thiệu & Bài Toán Giải Quyết

### Bài toán
Người chơi game tại Việt Nam (CS2, PUBG, Valorant, Dota 2, Apex Legends...) kết nối tới các server game quốc tế (Singapore, Tokyo, Hong Kong, Seoul) thường xuyên gặp các sự cố:
- Định tuyến quốc tế của ISP nội địa (Viettel, VNPT, FPT) bị vòng vèo, ping cao (70ms - 100ms+).
- Đứt cáp quang biển (AAG, APG, IA, AAE-1) gây mất gói tin (packet loss) và giật lag (jitter).

### Giải pháp
Dự án **GamePingBooster (GPB)** chuyển hướng (route) dữ liệu mạng của game thông qua một VPS Relay trung gian (đặt tại Singapore/Tokyo) có peering băng thông quốc tế cực tốt tới máy chủ của game (AWS, Azure, Valve SDR).
- **Không hook DLL, không đọc RAM, không can thiệp game**: Hoàn toàn an toàn trước các hệ thống Anti-Cheat khắt khe (BattlEye, Easy Anti-Cheat, Valve Anti-Cheat, Riot Vanguard).
- **Cơ chế định tuyến Layer 3 (Routing-based)**: Sử dụng driver card mạng ảo **Wintun** (công nghệ của WireGuard do Microsoft WHQL ký số) kết hợp thao tác bảng định tuyến Windows Routing Table. Chỉ gói tin game đi qua tunnel, các ứng dụng khác (trình duyệt, Discord, Windows Update) vẫn dùng mạng thường.

---

## 2. Kiến Trúc Kỹ Thuật Chi Tiết

### 2.1 Luồng Đi Của Gói Tin (Packet Flow)

```
[ Máy Tính Người Chơi (Windows) ]
  (1) Tiến trình Game (cs2.exe / TslGame.exe / VALORANT.exe)
        │ Gửi UDP packet đến server (ví dụ: 155.133.253.45:27015)
        ▼
  (2) Windows Network Stack
        │ Bảng Routing Table so khớp IP đích -> Đẩy vào adapter ảo "Game Ping Booster"
        ▼
  (3) Wintun Adapter (Virtual Layer-3 TUN)
        │ Trả về Raw IPv4 Packet
        ▼
  (4) gpb-service.exe (Chạy nền quyền LocalSystem, C# Native AOT)
        │ Đóng gói thêm 9-byte header protocol (SessionID + Flags)
        │ Gửi qua UDP Socket (Physical NIC) tới IP VPS:51820
        ▼
══════════════════════ [ ĐƯỜNG TRUYỀN INTERNET CÁP QUANG BIỂN ] ══════════════════════
        ▼
[ Linux VPS Relay ]
  (5) relayd (Go daemon lắng nghe UDP :51820)
        │ Xác thực Session ID / Source IP
        │ Bóc 9-byte header, ghi Raw IPv4 Packet vào card TUN ảo `gpb0`
        ▼
  (6) Linux Kernel
        │ IP Forwarding + iptables MASQUERADE (SNAT về IP của VPS)
        │ Đẩy packet trực tiếp ra ngoài Internet tới Server Game với Ping thấp nhất
        ▼
[ Server Game (AWS / Azure / Valve) ] -> Trả phản hồi ngược lại theo chu trình trên
```

### 2.2 Cấu Trúc Các Tiến Trình (Three-Tier Architecture)

| Tiến trình | Môi trường / Ngôn ngữ | Đặc quyền | Trách nhiệm chính |
| :--- | :--- | :--- | :--- |
| **`GamePingBooster.exe`** | Windows Client / C# Avalonia XAML (Native AOT) | User thông thường | Giao diện đồ họa, bật/tắt, chọn game, đăng nhập subscription, hiển thị ping trực quan. |
| **`gpb-service.exe`** | Windows Service / C# (Native AOT) | **LocalSystem** | Tạo card Wintun, quản lý routing table, theo dõi PID game, chạy 2 thread bơm packet (Pump threads), giao tiếp IPC với UI qua Named Pipe `\\.\pipe\GamePingBooster`. |
| **`relayd`** | Linux VPS / Go (Tĩnh, không cgo) | `root` hoặc `CAP_NET_ADMIN` | Lắng nghe UDP 51820, quản lý card TUN `gpb0`, cấp dải IP nội bộ (`10.77.0.0/24`), NAT packet ở tầng Kernel. |

### 2.3 Giao Thức Mạng Dây (Wire Protocol v2 / v3)

- **Handshake (57 bytes - v2, 240 bytes - v3)**: Xác thực bằng HMAC-SHA256 (Pre-Shared Key) hoặc chữ ký ECDSA P-256 (Licence Token). Nếu xác thực sai, relay **hoàn toàn im lặng** (không trả phản hồi để chống port scanning).
- **Data Packet Header (9 bytes siêu nhẹ)**:
  - `Byte 0`: Version (high 4 bits) + Type (`0x3` = Data) -> `0x23` hoặc `0x33`.
  - `Byte 1..8`: 64-bit Session ID ngẫu nhiên.
  - `Byte 9..N`: Nguyên vẹn gói IPv4 gốc.
  - **Không mã hóa payload**: Vì dữ liệu game đã có mã hóa riêng hoặc không nhạy cảm; không mã hóa giúp giảm triệt để CPU overhead và đưa độ trễ về mức tiệm cận vật lý.
- **Tính năng Roaming**: Client đổi mạng (từ Wi-Fi sang LAN, hoặc IP nhà mạng thay đổi) -> Relay tự động cập nhật endpoint mới ngay khi nhận được Data packet hợp lệ tiếp theo mà không làm đứt trận game.

---

## 3. Hiện Trạng Hệ Thống Đã Thiết Lập Trên VPS

VPS Ubuntu 24.04 (`/home/ubuntu`) đã được tối ưu hóa toàn bộ tham số Kernel cho Gaming Relay & Load Balancer:

1. **Kernel Sysctl (`/etc/sysctl.d/99-gaming-relay.conf`)**:
   - `net.ipv4.ip_forward = 1` và `net.ipv6.conf.all.forwarding = 1`.
   - Thuật toán nghẽn: **`fq + bbr`** (BBR Congestion Control giảm giật ping, chống rớt gói).
   - Mở rộng Socket Buffer: `rmem_max = 67108864`, `wmem_max = 67108864` (64MB buffer UDP).
   - Queue backlog: `somaxconn = 65535`, `netdev_max_backlog = 100000`.
   - Bảng theo dõi kết nối: `nf_conntrack_max = 1048576`.
2. **File Descriptors (`/etc/security/limits.d/99-gaming-relay.conf`)**:
   - `nofile = 1048576`, `nproc = 524288`.
3. **Các gói bổ trợ đã cài đặt**:
   - `haproxy`, `nginx`, `socat`, `iptables-persistent`, `nftables`, `fail2ban`, `vnstat`, `iperf3`, `ethtool`, `conntrack`, `tcpdump`.
4. **Mẫu cấu hình Load Balancer dự phòng**:
   - Thư mục `/home/ubuntu/relay-templates/`: chứa script iptables kernel NAT, mẫu cấu hình HAProxy và Nginx Stream.

---

## 4. Các Module Đã Bổ Sung / Cải Tiến

Chúng ta đã lập trình bổ sung tính năng **Auto-Scan & Dynamic Routing** trực tiếp vào client:

### 4.1 Tự Động Quét Socket Game (`DynamicGameDetector.cs`)
- **File**: `client/src/GamePingBooster.Service/Network/DynamicGameDetector.cs`
- **Nguyên lý**: Gọi P/Invoke vào API Windows `iphlpapi.dll` (`GetExtendedUdpTable` và `GetExtendedTcpTable`).
- **Hoạt động**:
  - Quét mỗi 500ms tìm PID của game đang chạy.
  - Đọc Remote IP & Port mà socket UDP của game kết nối ra ngoài.
  - Tự động bỏ qua IP loopback, IP LAN (`192.168.x.x`, `10.x.x.x`, `172.16.x.x`), IP DNS (port 53), IP Web (port 80/443).
  - Khi bắt được IP máy chủ trận đấu thật -> Bắn sự kiện `GameServerDetected`.

### 4.2 Tự Động Nạp Định Tuyến /32 (`TunnelEngine.cs`)
- **File**: `client/src/GamePingBooster.Service/Tunnel/TunnelEngine.cs`
- **Hoạt động**:
  - Đăng ký nhận sự kiện từ `DynamicGameDetector`.
  - Ngay khi có IP server game mới -> Lập tức gọi `_routes.InstallGameRoutes(adapterIndex, ["<IP>/32"])`.
  - Tạo route hẹp nhất có thể (`/32`), chỉ nắn đúng traffic trận đấu đó qua VPS Relay.
  - Khi game đóng hoặc ngắt kết nối -> Tự động dọn dẹp sạch sẽ route `/32` và dừng detector.

---

## 5. Kế Hoạch Nâng Cấp Chi Tiết (Roadmap Cho Agent Mới)

Dưới đây là 4 nhiệm vụ cốt lõi cần triển khai tiếp theo:

### Pha 1: Mở Rộng Đa Game (Multi-Game Support)
1. **Cập nhật Profile JSON (`profiles/`)**:
   - Mở rộng file hồ sơ bổ sung các tựa game hot:
     - **Counter-Strike 2**: Process `cs2.exe`, dải Valve SDR Singapore (`155.133.253.0/24`, `103.10.124.0/24`), port `27015-27050`.
     - **Valorant**: Process `VALORANT.exe`, `VALORANT-Win64-Shipping.exe`, dải Riot Direct Singapore (`151.106.248.0/22`, `162.249.72.0/22`).
     - **Dota 2**: Process `dota2.exe`, dải Valve Singapore SDR.
     - **Apex Legends**: Process `r5apex.exe`, dải AWS/Multiplay Singapore & Tokyo.
2. **Cập nhật Giao diện Avalonia UI (`MainWindow.axaml` & `MainViewModel.cs`)**:
   - Thêm dropdown `ComboBox` danh sách Game.
   - Thêm dropdown chọn Server Region (`Auto - Best Ping`, `Singapore`, `Tokyo`, `Hong Kong`).
   - Gửi lệnh IPC `set-game` hoặc truyền `gameId` xuống `TunnelEngine`.

### Pha 2: Tự Động Kết Nối Khi Mở App (Auto-Connect on Launch)
1. **Sửa `App.axaml.cs` và `MainViewModel.cs`**:
   - Thêm cờ cấu hình `AutoConnectOnStartup: true`.
   - Khi nhận được trạng thái `Configured == true` và có endpoint relay -> Tự động gọi `_pipe.ConnectTunnelAsync()` mà không cần người dùng bấm nút.
   - Khi ứng dụng khởi chạy cùng Windows (Minimized to System Tray), đường hầm đã sẵn sàng ở trạng thái nền.

### Pha 3: Xây Dựng Licence & Subscription Server Độc Lập
Thay vì phụ thuộc vào server web của tác giả, cần tự dựng một backend riêng:
1. **Kiến trúc Server**: Viết bằng **Go** hoặc **Node.js/Express** hoặc **Python/FastAPI**.
2. **Quản lý cặp khóa ECDSA P-256**:
   - `licence.priv`: Đặt trên Licence Web Server để ký token.
   - `licence.pub`: Cấu hình trên VPS Relay (`relayd -licence-key /path/to/licence.pub`).
3. **Triển khai 3 API Endpoint chuẩn cho Client (`LicenceClient.cs`)**:
   - `POST /auth/login` (hoặc `/auth/exchange`): Kiểm tra tài khoản người dùng, trả về `refreshToken`.
   - `POST /auth/token`: Nhận `devicePublicKey` (mã máy) + `refreshToken` -> Kiểm tra hạn subscription trong Database -> Ký và trả về **150-byte Licence Token** (chuỗi Hex).
   - `GET /profile`: Trả về danh sách Relay và Game cho tài khoản.
4. **Cấu trúc 150-byte Token (chuẩn `protocol/token.go`)**:
   - `0..1`: Version (`0x01`)
   - `1..9`: UserID (`uint64`)
   - `9..74`: Device Public Key (65 bytes P-256)
   - `74..82`: Expiry Timestamp (Unix seconds)
   - `82..83`: Tier (`0x01` = VIP, `0x02` = Pro...)
   - `83..84`: Max Concurrent Sessions
   - `84..86`: Reserved (`0x00 0x00`)
   - `86..150`: Chữ ký ECDSA P-256 IEEE P1363 (`r || s`, 64 bytes)

### Pha 4: Đóng Gói Bộ Cài Thương Mại (Installer Pipeline)
1. Sử dụng script `./gpb installer` kết hợp Inno Setup 6.
2. Biên dịch Native AOT x64 không phụ thuộc .NET Runtime.
3. Đóng gói sẵn IP VPS Relay và cấu hình Licence Server mặc định vào `%ProgramData%\GamePingBooster\`.

---

## 6. Tài Liệu Tham Khảo File & API

- **Relay Go Source**: `/home/ubuntu/GamePingBooster/relay/`
  - Khởi chạy daemon: `cmd/relayd/main.go`
  - Xử lý UDP loop, TUN loop & Session table: `internal/server/server.go`
  - Đặc tả Wire Protocol & Token format: `internal/protocol/protocol.go` & `token.go`
  - Setup NAT & sysctl cho Linux: `deploy/setup-nat.sh`
- **Client C# Source**: `/home/ubuntu/GamePingBooster/client/`
  - Giao diện người dùng: `src/GamePingBooster.App/` (`Views/MainWindow.axaml`, `ViewModels/MainViewModel.cs`)
  - Client API License: `src/GamePingBooster.App/Services/LicenceClient.cs`
  - Core Tunnel Engine: `src/GamePingBooster.Service/Tunnel/TunnelEngine.cs`
  - Quản lý định tuyến Windows: `src/GamePingBooster.Service/Network/RouteManager.cs`
  - Quét IP động: `src/GamePingBooster.Service/Network/DynamicGameDetector.cs`
- **Công cụ quét dải IP game**: `/home/ubuntu/GamePingBooster/tools/profile-builder/`
