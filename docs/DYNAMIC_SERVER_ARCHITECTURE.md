# Kiến Trúc Đội Ngũ VPS Động & Tự Động Kết Nối (Dynamic Relay Fleet & Auto-Routing)

## 1. Bài Toán & Yêu Cầu Cốt Lõi
1. **Triển khai VPS dễ dàng**: Cho phép thêm các server VPS mới ở Singapore, Tokyo (Nhật Bản), Hong Kong, Seoul (Hàn Quốc)... chỉ bằng 1 câu lệnh cài đặt tự động.
2. **Không bắt buộc người dùng cập nhật App (Zero-Update Client)**: Khi thêm hoặc đổi IP VPS, người dùng không cần tải bản cài đặt mới hay cập nhật phần mềm.
3. **Tự động đo ping & chọn server tối ưu**: Khi người dùng đăng nhập và bật game, hệ thống tự động phát hiện cụm máy chủ trận đấu của game (Azure/AWS/Riot/Valve), đo độ trễ qua các VPS Relay và tự động kết nối vào VPS có ping thấp nhất.

---

## 2. Cơ Chế Hoạt Động Của Hệ Thống

```
┌────────────────────────┐         1. Đăng ký VPS mới           ┌────────────────────────┐
│  VPS Relay Mới (Tokyo) │ ────────────────────────────────────▶ │  Licence Web Server    │
│  (Chạy setup-vps.sh)   │                                       │  (Quản lý fleet.json)  │
└────────────────────────┘                                       └───────────┬────────────┘
                                                                             │
                                                               2. Kéo danh sách VPS mới
                                                                  (GET /profile)
                                                                             │
                                                                             ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 Client Máy Người Dùng                                  │
│                                                                                        │
│  ┌───────────────────────┐   3. Nhận danh sách Relay   ┌────────────────────────────┐  │
│  │   GamePingBooster.App │ ──────────────────────────▶ │   gpb-service.exe          │  │
│  │   (ProfileSync.cs)    │                             │   (TunnelEngine.cs)        │  │
│  └───────────────────────┘                             └─────────────┬──────────────┘  │
│                                                                      │                 │
│                                                4. Đo Ping Landmark & │                 │
│                                                   Chọn VPS thấp nhất │                 │
│                                                                      ▼                 │
│                                                        ┌────────────────────────────┐  │
│                                                        │   Kết nối VPS tối ưu       │  │
│                                                        │   (Ví dụ: Tokyo / Sing)    │  │
│                                                        └────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Các Thành Phần Triển Khai

### 3.1. File Cấu Hình Động Trên Server (`fleet.json`)
Server Backend (Licence Server) quản trị danh sách các Relay VPS hiện có:
```json
{
  "relays": [
    {
      "id": "sg-1",
      "name": "Singapore Relay 1 (Primary)",
      "location": "Singapore",
      "endpoint": "sg1.relay.gamepingbooster.com:51820",
      "minTier": 0
    },
    {
      "id": "jp-1",
      "name": "Tokyo Relay 1",
      "location": "Tokyo, Japan",
      "endpoint": "jp1.relay.gamepingbooster.com:51820",
      "minTier": 0
    },
    {
      "id": "hk-1",
      "name": "Hong Kong Relay 1",
      "location": "Hong Kong",
      "endpoint": "hk1.relay.gamepingbooster.com:51820",
      "minTier": 0
    }
  ]
}
```

### 3.2. Cơ Chế Client Nhận Cập Nhật Mà Không Cần Update App (`ProfileSync.cs`)
* Khi ứng dụng mở lên hoặc khi người dùng đăng nhập:
  * `ProfileSync.cs` gửi yêu cầu `GET /profile` có đính kèm `RefreshToken` và `DevicePublicKey`.
  * Server trả về danh sách Relays & Games mới nhất (được đóng gói an toàn bằng `ProfileEnvelope`).
  * Ứng dụng nạp thẳng danh sách này vào RAM của `gpb-service.exe` qua Named Pipe (`set-profile`).
* **Lợi ích**: Bất kỳ khi nào bạn bật thêm một VPS tại Nhật hay Hong Kong, trong vòng vài giây, toàn bộ người dùng mở app sẽ tự động nhận diện VPS mới mà không cần cài lại app.

### 3.3. Thuật Toán Tự Động Chọn VPS Ping Thấp Nhất (`SelectRelayAsync`)
Trong `client/src/GamePingBooster.Service/Tunnel/TunnelEngine.cs`:
1. **Dò vùng máy chủ đích (Landmark Probe)**:
   * Game (ví dụ PUBG, Valorant, CS2) phân bổ người chơi vào server theo độ trễ. PUBG thăm dò các endpoint UDP 8081 của Azure tại Singapore (`southeastasia`), Tokyo (`japaneast`), Seoul (`koreacentral`).
   * `LandmarkProbe` đo độ trễ mạng vật lý tới các landmark này để biết trận đấu chuẩn bị diễn ra ở đâu.
2. **Đo thử nghiệm qua các ứng viên VPS (Candidate Relay Probing)**:
   * Client gửi gói tin đo độ trễ vòng lặp tới từng VPS:
     $$\text{Total Latency} = \text{Ping(Client} \to \text{VPS Relay)} + \text{Ping(VPS Relay} \to \text{Game Server)}$$
3. **Tự động chuyển tuyến (Dynamic Routing)**:
   * Nếu người chơi match vào server Singapore: Relay Singapore được chọn (ping ~25ms - 32ms).
   * Nếu người chơi match vào server Nhật Bản / Hàn Quốc: Relay Tokyo hoặc Hong Kong được chọn (ping ~55ms - 65ms thay vì 110ms đi thẳng qua ISP bị nghẽn).
