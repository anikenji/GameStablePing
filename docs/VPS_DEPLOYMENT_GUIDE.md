# Hướng Dẫn Triển Khai VPS Relay Đa Quốc Gia (Singapore, Nhật Bản, Hong Kong)

Tài liệu này hướng dẫn cách thiết lập một máy chủ trung chuyển (Relay VPS) chỉ bằng **1 câu lệnh duy nhất**.
Máy chủ mới sẽ tự động tối ưu hóa hạ tầng mạng cho gaming và tự động đăng ký vào danh sách Relay Fleet của hệ thống.

---

## 1. Yêu Cầu Cấu Hình VPS Khuyên Dùng

* **Hệ điều hành**: Ubuntu 22.04 LTS / Ubuntu 24.04 LTS hoặc Debian 12.
* **Cấu hình phần cứng**:
  * 1 vCPU (ưu tiên xung nhịp cao).
  * 1 GB RAM (Relay viết bằng Go cực nhẹ, ngốn chưa tới 50MB RAM).
  * Băng thông: Cổng 1Gbps, lưu lượng 1TB - 2TB/tháng.
* **Nhà cung cấp VPS khuyên dùng**:
  * **Singapore (SG)**: Vultr Singapore, Linode Singapore, DigitalOcean Singapore, OVH Singapore.
  * **Tokyo (JP)**: Vultr Tokyo, Linode Tokyo, AWS EC2 ap-northeast-1.
  * **Hong Kong (HK)**: Vultr Hong Kong, Aliyun HK, UCloud HK.

---

## 2. Triển Khai Nhanh Bằng One-Click Script

Đăng nhập SSH vào VPS với quyền `root` và chạy lệnh tương ứng với từng khu vực:

### 2.1. Triển khai Relay tại Singapore (SG)
```bash
curl -sSL https://raw.githubusercontent.com/VietNguyenR/GamePingBooster/main/relay/deploy/setup-vps.sh | sudo bash -s -- \
  --name "Singapore Relay 1" \
  --location "Singapore" \
  --port 51820 \
  --mode token \
  --licence-key /etc/relayd/licence.pub \
  --backend-url "https://api.gamepingbooster.com"
```

### 2.2. Triển khai Relay tại Tokyo, Nhật Bản (JP)
```bash
curl -sSL https://raw.githubusercontent.com/VietNguyenR/GamePingBooster/main/relay/deploy/setup-vps.sh | sudo bash -s -- \
  --name "Tokyo Relay 1" \
  --location "Tokyo, Japan" \
  --port 51820 \
  --mode token \
  --licence-key /etc/relayd/licence.pub \
  --backend-url "https://api.gamepingbooster.com"
```

### 2.3. Triển khai Relay tại Hong Kong (HK)
```bash
curl -sSL https://raw.githubusercontent.com/VietNguyenR/GamePingBooster/main/relay/deploy/setup-vps.sh | sudo bash -s -- \
  --name "Hong Kong Relay 1" \
  --location "Hong Kong" \
  --port 51820 \
  --mode token \
  --licence-key /etc/relayd/licence.pub \
  --backend-url "https://api.gamepingbooster.com"
```

---

## 3. Tự Động Hóa Dành Cho Người Dùng (Zero-Update Client)

1. Khi script chạy xong, nó sẽ gọi webhook `POST https://api.gamepingbooster.com/api/v1/relays/register`.
2. Backend Server sẽ tự động thêm VPS mới này vào file cấu hình động `fleet.json`.
3. Người dùng trên Windows khi mở ứng dụng hoặc khi đăng nhập sẽ tự động nhận danh sách VPS mới qua `GET /profile` mà **không cần phải cập nhật ứng dụng hay tải file mới**.
4. Khi chơi game, tính năng `LandmarkProbe` sẽ tự động đo ping:
   * Nếu game chọn cụm server Singapore -> Tự động kết nối qua VPS Singapore.
   * Nếu game chọn cụm server Tokyo -> Tự động kết nối qua VPS Tokyo.

---

## 4. Các Lệnh Quản Trị & Kiểm Tra Trên VPS

* **Kiểm tra trạng thái dịch vụ**:
  ```bash
  sudo systemctl status relayd
  ```
* **Xem nhật ký hoạt động thời gian thực (Live Logs)**:
  ```bash
  sudo journalctl -u relayd -f
  ```
* **Kiểm tra card mạng ảo TUN**:
  ```bash
  ip addr show gpb0
  ```
* **Khởi động lại dịch vụ**:
  ```bash
  sudo systemctl restart relayd
  ```
