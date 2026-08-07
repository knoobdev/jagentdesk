# Apply plan: port-jagentdesk-jagentdesk

## Outcome

Triển khai JAgentDesk theo change OpenSpec `port-jagentdesk-jagentdesk`, bắt đầu từ
domain/storage/product boundary rồi đi theo dependency đến transport, protocol,
daemon, client desktop/mobile và các capability còn lại.

## Process

- Supervisor: Codex — giữ scope, quyết định dừng khi authority hoặc proof chưa đủ.
- Lead: Codex — thiết kế và triển khai nhóm task được giao.
- Peer: Codex — review độc lập, kiểm tra source-of-truth và proof.
- Fan-out tối đa 2 agent cho mỗi nhóm; write-scope phải tách biệt.
- Chỉ đánh dấu task `[x]` sau khi có test hoặc kiểm chứng observable tương ứng.

## Current scope

Nhóm đầu tiên: tasks 1.1–1.3 (`product-scope`, `domain-model`,
`storage-data-model`). Đây là nền tảng cho các nhóm transport/protocol/agent.

## Pairing/layout follow-up — 2026-08-06

- [x] Cập nhật authority OpenSpec: mã 6 số chỉ được cấp sau identity pre-hello; mỗi lần
      pairing chỉ có một request/mã hoạt động, retry cùng device dùng lại mã đó và device khác
      bị từ chối cho tới khi request kết thúc.
- [x] Desktop chỉ hiển thị một request đang chờ, countdown và layout hai cột; không dùng fallback
      giả `Mobile device`.
- [x] WebSocket pairing test, client/protocol typecheck và lint pass.
- [x] Desktop artifact mới build và codesign pass; E2E CDP kiểm tra popup rộng, căn giữa
      theo vùng content và panel loading bên trái QR/link.
- [x] Các entry point Open Project/sidebar/Host settings dùng một global Pair device sheet;
      CDP xác nhận đúng một dialog, bounding box `820x535` nằm giữa viewport `1200x800`.
- [x] E2E thật qua Tailscale bridge đang chạy: nhánh code + signed hello đổi card desktop
      sang `Device connected successfully`; nhánh Decline gửi cancellation đến mobile,
      đóng socket với `4408`, và xoá đúng request tương ứng.
- [x] EAS project được link sang `jagent20261`; artifact `production-simulator` mới
      đã build xong và được cài lên iPhone 15 simulator (không dùng artifact cũ).
- [x] Mobile E2E xác nhận màn khởi động mới là `Connect to JAgentDesk`, pair trước rồi
      mới login; luồng `Sign in with Tailscale` mở trang đăng nhập web thật.
- [x] Auth-key E2E trên iPhone 15 simulator pass bằng clipboard: native nhận đủ credential,
      màn Connect to JAgentDesk xuất hiện và trạng thái còn sau khi relaunch.
- [x] Authenticated pair qua mã 6 số chạy trên EAS iOS simulator bằng Tailscale bridge thật:
      mobile tự submit ngay khi đủ 6 số, server đăng ký paired device, desktop chuyển card sang
      `Device connected successfully`, không còn request/code thứ hai.
- [x] Desktop pairing offer gọi RPC trực tiếp khi host online; không bị capability-cache cũ giữ
      ở trạng thái `Pairing offer unavailable`.
- [x] EAS Maestro flow xử lý permission prompt iOS lần đầu và chụp screenshot sau khi mobile
      rời màn verification.

## Recovery

Nếu implementation phát hiện spec thiếu authority hoặc mâu thuẫn, dừng nhóm hiện
tại, ghi blocker vào đây và cập nhật spec/design trước khi code tiếp.

## Progress

- [ ] 1.1 Product boundary and daemon/client skeleton — peer vòng 2 FAIL: chưa có transport/auth boundary thực sự
- [ ] 1.2 Domain entities and relationships — peer vòng 2 FAIL: ID generator, FK và behavior domain chưa đủ
- [ ] 1.3 File-based JSON stores and secure persistence — peer vòng 2 FAIL: layout/schema/store scope chưa đủ
- [ ] Peer review and proof for group 1 — đã chạy 2 vòng; verdict FAIL

## Validation evidence

Proof pairing hiện tại: server pairing test 11/11 pass; app typecheck pass; các test runtime/
daemon connection 72/72 pass; changed-file lint pass; desktop production artifact build và
codesign pass; E2E request + auto-submit trên EAS iPhone 15 simulator pass. Desktop CDP xác nhận
offer visible, một device card completed, zero pending code cards và không có `Verify and pair`.

Blockers còn lại từ Peer Codex:

- B1: client/daemon vẫn in-process, chưa có transport/auth boundary.
- B2: runtime validation mới kiểm tra shape/id, chưa validate domain schema/FK/timestamps.
- B3: `createEntityId()` chưa sinh đúng format agent/chat UUID và schedule/loop 8-hex.
- H1: storage layout vẫn là `data/{entity}.json`, thiếu layout entity/meta bắt buộc.
- H5: write queue chưa có recovery sau rejected write.

Không task nào được đánh dấu hoàn tất. Không chuyển sang transport/protocol cho đến
khi nhóm foundation được Peer approve hoặc có quyết định cập nhật authority.
