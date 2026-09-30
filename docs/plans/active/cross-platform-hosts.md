# Đa nền tảng: khả năng theo host, fleet Android, bộ cài công cụ

Authority: spec `24`, `ADR-0024` (repo `remote-coding-app-spec`). Nghiên cứu:
`remote-coding-app-spec/docs/reference/cross-platform-host-dependencies.md`.

Chủ sản phẩm chốt 2026-09-30: báo khả năng theo host + dùng host Mac từ xa + thêm fleet Android;
bộ tự cài phải nhận biết nền tảng và chọn đúng bản.

## Giai đoạn

| #   | Việc                                                                                                                         | Trạng thái | Bằng chứng                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------- |
| 1   | Protocol `capabilities.host` + probe daemon (24.2) + RPC `host.capabilities.refresh`                                         | xong       | 6 test đơn vị; RPC trên daemon dev (macOS arm64) trả đúng 12 khả năng trong ~0,1 s |
| 2   | Bộ cài theo nền tảng (24.8): registry, plan/install RPC, tải bản phát hành + SHA-256, PATH Windows, thay forge-cli-installer | chưa làm   |                                                                                    |
| 3   | UI: nav theo khả năng, chọn host, trạng thái trống + nút cài (24.4)                                                          | chưa làm   |                                                                                    |
| 4   | Gate đăng ký tool agent theo khả năng (24.5)                                                                                 | chưa làm   |                                                                                    |
| 5   | Backend Android cho SimFleet (24.6): list/create/boot/shutdown/screenshot/input/UI tree/app/URL/log/geo/perm                 | chưa làm   |                                                                                    |
| 6   | Cài Android SDK + JDK 17 (24.8)                                                                                              | chưa làm   |                                                                                    |
| 7   | Workbench Android: proxy theo thiết bị + CA (24.7)                                                                           | chưa làm   |                                                                                    |
| 8   | CI job test trên Windows; smoke test trên máy Windows thật                                                                   | chưa làm   |                                                                                    |

## Dữ kiện đã kiểm (2026-09-30)

- Checksum darwin của cloudflared trong ghi chú phát hành sai 4 bản liên tiếp; dùng `digest` của
  GitHub releases API.
- Gói Debian `tea` không phải Gitea CLI.
- Emulator Android không có bản Linux arm64 / Windows arm64; SDK chỉ có SHA-1.
- Windows: winget/scoop chỉ đổi PATH cho tiến trình mới — đọc lại registry.

## Rủi ro

- Không có máy Windows/Linux thật trong môi trường phát triển hiện tại: phần Windows/Linux chỉ có
  test đơn vị + CI cho tới khi có máy thật.
- Android SDK ~1,4–2,4 GB; test thật trên Mac này cần tải SDK (chưa tải).

## Khôi phục

Mỗi giai đoạn một commit trên nhánh `feat/cross-platform-hosts`; bảng trên ghi commit + test.
