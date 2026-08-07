## Why

JAgentDesk là nền tảng self-hosted điều khiển các coding agent chạy cục bộ từ xa. Một
**daemon** chạy trên máy làm việc quản lý tiến trình agent; một **app desktop** và một
**app mobile** kết nối vào daemon. Phạm vi parity được đối chiếu với snapshot tham chiếu cục bộ
tại `scratchpad/reference`, sau đó áp dụng ba quyết định riêng cho sản phẩm cá nhân và không
phụ thuộc dịch vụ relay/đám mây bên ngoài.

Nguồn sự thật về hành vi parity là snapshot tham chiếu; mọi phát biểu về hành vi kế thừa trong
design phải trích dẫn `scratchpad/reference` theo `file:line`.

## What Changes

Port **toàn bộ** bề mặt tính năng parity vào JAgentDesk (không bỏ chức năng nào ngoài các non-goal), với
ba delta:

1. **Bỏ editor trong app.** Xem file và xem diff được giữ; **sửa file trong app thì không**.
   Panel editor trong snapshot tham chiếu (`packages/app/src/file-pane/editor/`) không được port; file panel
   chuyển sang chế độ chỉ-đọc.
2. **Transport là Tailscale (tsnet).** Daemon phục vụ `/ws` trên tailnet; client dial thẳng
   qua WireGuard. Lớp relay legacy trong snapshot tham chiếu và lớp E2EE-box đi kèm bị bỏ vì
   WireGuard đã cung cấp mã hoá transport + định danh node. Seam thay thế là transport listener /
   connection controller / `attachSocket` (đã xác định trong design).
3. **Pairing + ký kết nối ở tầng ứng dụng.** Một node bất kỳ trong tailnet không tự động có
   quyền điều khiển daemon: mỗi thiết bị phải được pair và mỗi kết nối phải được ký/xác thực.
   **Màn hình đầu tiên của app mobile là nhập pairing offer** (scan QR, deep-link hoặc paste).
   Sau khi offer hợp lệ được lưu, app mới yêu cầu đăng nhập Tailscale (tương tác HOẶC auth key),
   sau đó kết nối có ký và yêu cầu mã xác thực sáu số trên desktop.

Push notification: dùng **Expo Push Service** làm broker (miễn phí, không giới hạn) với
payload content-light (chỉ loại sự kiện + id mờ; chi tiết fetch qua Tailscale khi mở app).
Sàn chi phí bắt buộc là tài khoản Apple Developer $99/năm. Phase 1 không tự host APNs/FCM.

## Capabilities

### New Capabilities

- `product-scope`: Định vị sản phẩm, đối tượng, phạm vi và danh mục nền tảng (desktop/mobile/CLI/daemon).
- `domain-model`: Mô hình miền — projects, workspaces (directory/local_checkout/worktree), agents/sessions, terminals, schedules, loops, chat rooms; định danh mờ và quan hệ.
- `transport-tailscale`: Thay relay bằng tsnet — vòng đời kết nối, daemon phục vụ `/ws` trên tailnet, client dial trực tiếp, liveness/ping, giới hạn high-water.
- `pairing-and-signing`: Định danh thiết bị, pairing offer, ký và xác thực mỗi kết nối, thu hồi thiết bị; thứ tự offer → Tailscale-login → mã sáu số.
- `protocol`: Bề mặt RPC/WS đầy đủ — envelope JSON, union session inbound/outbound, request/response theo namespace, sự kiện streaming, binary frame cho terminal + file transfer.
- `agent-sessions`: Vòng đời agent (initializing→idle⇄running→error→closed), create/run/cancel/reload/replace/resume/archive/detach/import, mode/model/thinking/feature, subagents/orchestration.
- `providers`: Đăng ký provider (Claude Code, Codex, Copilot, OpenCode, Pi, OMP, ACP catalog), provider tuỳ biến, availability probing, usage/quota.
- `workspaces-git`: Workspace ↔ repo, git worktree, checkout RPC, diff/status (chỉ-đọc), forge (GitHub/GitLab/Gitea) PR/MR, metadata generation.
- `terminals`: PTY theo workspace, mux nhị phân, capture/send-keys/resize/kill, tab và split pane, activity tracking.
- `diff-and-files`: Xem diff (commit + working), file explorer, file preview pane **chỉ-đọc** (không editor), image lightbox, diff-too-large state.
- `composer-permissions`: Composer (input, attachments, agent controls, queue, subagents track), luồng phê duyệt permission (permission card), plan card, question form.
- `voice-dictation`: Dictation (STT) và voice mode realtime; model local ONNX (Parakeet/Kokoro) hoặc OpenAI; two-way audio native.
- `automation`: Schedules (cron tạo agent mới), heartbeats (cron vào cùng agent), loops (worker/verifier), chat rooms agent↔agent/human↔agent.
- `notifications-push`: Attention policy (present/focused/push-eligible), OS-local notification (desktop/web), Expo push content-light qua Tailscale, đăng ký/thu hồi token.
- `desktop-app`: Electron host bản Expo web export, đa cửa sổ, quản lý vòng đời daemon cục bộ, kết nối local socket/pipe + Tailscale từ xa, in-app browser automation.
- `mobile-app`: Expo/React Native, cây route expo-router, offer/pairing gate, Tailscale-login sau offer, workspace deck, mobile panels + gestures, push routing.
- `design-system`: Token thiết kế trích từ `packages/app/src/styles/theme.ts` (hex/scale thật), 6 theme, semantic color, SPACING/FONT/RADIUS, control geometry, identity colors.
- `settings`: Cấu trúc settings (list+detail), general/appearance/editor-view/shortcuts/integrations/permissions/diagnostics, host settings, quản lý thiết bị đã pair.
- `storage-data-model`: Lưu trữ file-based JSON dưới `$JAGENTDESK_HOME`, atomic write, layout thư mục theo entity, không migration framework (forward-compat bằng optional field).
- `security`: Mô hình đe doạ, phân lớp Tailscale ACL + pairing + ký, chính sách quyền công cụ, BYOK, bypass path, hardening.
- `i18n`: Phạm vi bản địa hoá client, danh sách locale, quy tắc dịch/không-dịch, biến thể forge.
- `cli`: Bề mặt lệnh CLI (agent/daemon/chat/terminal/script/loop/schedule/heartbeat/workspace/permit/provider/speech) và giải quyết workspace.

### Modified Capabilities

<!-- Greenfield: không có capability nào tồn tại trước, mọi thứ là New. -->

## Impact

- **Mã không đưa vào sản phẩm:** relay/hosted-release path legacy, lớp E2EE-box relay, và
  `packages/app/src/file-pane/editor/` (editor).
- **Mã thêm mới:** module transport tsnet (thay relay), lớp pairing + ký kết nối, màn
  Tailscale-login mobile, tích hợp Expo push content-light.
- **Phụ thuộc mới:** Tailscale (tsnet cho daemon; client library/OS integration), Apple
  Developer account ($99/năm) cho iOS push.
- **Không đổi:** mô hình protocol WS `/ws`, mô hình agent/provider, mô hình lưu trữ file-based,
  bộ token thiết kế, bề mặt CLI và các provider/forge adapter — tất cả giữ parity với snapshot
  tham chiếu.
