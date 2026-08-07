## ADDED Requirements

### Requirement: Self-hosted daemon and multi-client product boundary

JAgentDesk MUST cung cấp một daemon chạy trên máy làm việc để quản lý tiến trình coding agent, đồng thời cho phép desktop app, mobile app và CLI kết nối vào cùng daemon. Agent runtime MUST tiếp tục tồn tại khi một client ngắt kết nối; daemon là chủ sở hữu runtime và stream trạng thái theo thời gian thực cho mọi client đang kết nối (`scratchpad/reference/docs/product.md:38-47`).

#### Scenario: Client disconnect does not stop an agent

- **GIVEN** daemon đang quản lý một agent ở trạng thái `running` và có ít nhất một client đã kết nối
- **WHEN** client đó đóng kết nối trong khi agent đang xử lý turn
- **THEN** daemon giữ process và trạng thái agent, và một client khác kết nối lại có thể đọc được trạng thái/timeline mới nhất (`scratchpad/reference/docs/product.md:40-47`)

### Requirement: Cross-platform product surfaces

JAgentDesk MUST có các bề mặt desktop Electron, mobile iOS/Android, web UI self-hosted tùy chọn và CLI; các bề mặt này MUST dùng chung daemon contract thay vì mỗi bề mặt có một agent runtime riêng. Built-in surface MUST bao gồm agents đa provider, workspaces, terminals, voice, schedules, MCP/orchestration, split panes, keybindings và in-app browser tương ứng với danh mục JAgentDesk đã công bố (`scratchpad/reference/docs/product.md:71-81`).

#### Scenario: Same daemon is visible from app and CLI

- **GIVEN** một daemon đang chạy và một workspace đã tồn tại
- **WHEN** người dùng liệt kê agents từ app rồi chạy lệnh CLI list trên cùng daemon
- **THEN** hai kết quả cùng phản ánh một tập agent theo `workspaceId`, không tạo thêm runtime chỉ vì dùng bề mặt khác (`scratchpad/reference/public-docs/cli.md:9-13,103-110`)

### Requirement: Projects, workspaces, and agent-oriented canvas

Sản phẩm MUST tổ chức project theo filesystem và git remote khi có, mở project thành workspace, cho phép workspace chính và các workspace cô lập bằng git worktree, đồng thời cho phép nhiều agent, terminal và provider xuất hiện cạnh nhau trong cùng workspace (`scratchpad/reference/docs/product.md:24-36`).

#### Scenario: Isolated worktree workspace

- **GIVEN** một project Git có checkout chính
- **WHEN** người dùng tạo workspace với isolation `worktree`
- **THEN** hệ thống tạo workspace riêng gắn với checkout/worktree của nó và agent chạy trong workspace đó không được coi là đang sửa checkout chính (`scratchpad/reference/docs/product.md:24-35`; `scratchpad/reference/public-docs/cli.md:50-85`)

### Requirement: JAgentDesk transport and authorization delta

JAgentDesk MUST thay đường relay của JAgentDesk bằng Tailscale: daemon phục vụ WebSocket `/ws` trên tailnet và client dial trực tiếp qua địa chỉ Tailscale. Việc cùng ở trong tailnet MUST không đủ để điều khiển daemon; client MUST hoàn tất pairing ở tầng ứng dụng và ký handshake/kết nối bằng định danh thiết bị đã đăng ký. Đây là delta bắt buộc so với topology mạng riêng/VPN mà JAgentDesk chỉ mô tả như một cách expose daemon (`scratchpad/reference/public-docs/web-ui.md:61-79`).

#### Scenario: Tailnet node without pairing is rejected

- **GIVEN** một node đã truy cập được địa chỉ Tailscale của daemon nhưng public key thiết bị chưa nằm trong danh sách paired
- **WHEN** node mở `/ws` và gửi hello
- **THEN** daemon từ chối session trước khi trả về `server_info` hoặc cho phép RPC điều khiển agent, với mã lỗi ứng dụng có thể kiểm thử

### Requirement: Mobile first-run pairing and Tailscale gate

Mobile app MUST hiển thị màn hình nhập pairing offer trước khi yêu cầu đăng nhập Tailscale. Sau khi quét QR, mở deep-link hoặc dán một offer JAgentDesk v3 hợp lệ, app MUST lưu offer, chuyển sang login Tailscale tương tác hoặc auth key, rồi quay lại màn hình nhập mã sáu số. Local MUST là một lựa chọn tường minh riêng. Trên nền tảng chưa có native Tailscale bridge, app MUST hiển thị trạng thái unsupported và chỉ cho phép Local; không được báo connected giả.

#### Scenario: Mobile receives offer before Tailscale login

- **GIVEN** app mobile khởi động trên thiết bị chưa có tailnet identity usable và chưa có pending offer
- **WHEN** app hoàn tất cold start
- **THEN** route đầu tiên cho phép Scan desktop QR, Paste pairing link hoặc Continue with Local; sau khi có offer hợp lệ, login Tailscale mới được mở (`packages/app/src/app/index.tsx`; delta JAgentDesk)

### Requirement: Read-only file and diff product boundary

JAgentDesk MUST giữ file explorer, file preview, image preview và diff viewer của JAgentDesk nhưng MUST không port in-app editor và MUST không expose RPC ghi file từ client. Mọi thao tác sửa code phải do agent/terminal thực hiện ngoài app; app chỉ đọc trạng thái sau đó (`scratchpad/reference/docs/product.md:7-9`; `scratchpad/reference/packages/app/src/file-pane/editor/`; `scratchpad/reference/packages/protocol/src/messages.ts:2247`).

#### Scenario: File pane rejects edit action

- **GIVEN** người dùng đang xem một file trong file pane
- **WHEN** client cố gửi yêu cầu ghi file hoặc tìm nút chỉnh sửa
- **THEN** client không có control/RPC ghi file và chỉ có thể tải/đọc nội dung hoặc xem diff

### Requirement: Content-light push notification boundary

JAgentDesk MUST hỗ trợ attention policy và push notification cho agent nhưng payload gửi qua Expo Push Service MUST chỉ chứa event type và opaque identifier; payload MUST không chứa prompt, code, diff hay nội dung file. Khi người dùng mở notification, app MUST fetch chi tiết qua kết nối Tailscale đã pair (`scratchpad/reference/packages/server/src/server/push/push-service.ts:25`; `scratchpad/reference/packages/server/src/server/agent-attention-policy.ts:42-79`).

#### Scenario: Error notification does not leak content

- **GIVEN** một agent chuyển sang trạng thái cần attention
- **WHEN** daemon tạo push payload
- **THEN** payload có event type/opaque id, không có trường prompt/code/file content, và app chỉ lấy timeline chi tiết sau khi mở được Tailscale session
