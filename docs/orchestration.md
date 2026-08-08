# Orchestration

Orchestration là control plane dùng chung cho desktop, mobile và các client khác của
JAgentDesk. Client không tự tạo topology; daemon giữ authority, route, lifecycle và trạng
thái bền vững.

## Luồng thực tế

```text
Human chat trong Workspace
  → orchestration.task.prepare.request
  → Task Brief ready hoặc câu hỏi thiếu thông tin ngay trong cùng panel
  → một Supervisor của brief/workspace
  → Supervisor gọi orchestration.bootstrap_lead
  → đúng một Lead
  → Lead gọi orchestration.create_peer cho từng assignment bounded
  → Peer gọi orchestration.handback
  → Lead gọi orchestration.resolve_dissent nếu có bất đồng
  → Lead gọi orchestration.accept_result sau validation
  → runtime gửi handback/accepted result ngược lên parent agent
  → Supervisor báo cáo lại Human
```

Không có nút “Refine request”. Request tự nhiên được compiler giữ nguyên trong
`rawRequest`, tách thành objective/context/constraints/accepted decisions/acceptance và
validation. Nếu objective còn thiếu, response có `status: "needs_clarification"` và
`openQuestions`; daemon không tạo agent khi brief chưa sẵn sàng.

## Cấu hình provider/model

Config nằm trong `$JAGENTDESK_HOME/config.json`, nhánh `daemon.orchestration`:

- `roles.supervisor`, `roles.lead`, `roles.peer` đều có `profiles[]`; mỗi profile gồm
  `provider`, `model`, `thinkingOptionId`, `enabled` và `defaultProfileId`.
- `routes` là route semantic (`planning`, `impl`, `impl_deep`, `search`, `research`,
  `audit`, `ui`) với `primary` và danh sách `fallbacks` có thứ tự.
- `limits.maxPeersPerLead` mặc định là `3`, giới hạn fan-out của một Lead trong một run
  để tránh dispatch vô hạn.

Default route thực tế ưu tiên Codex cho Supervisor/Lead, DeepSeek qua OpenCode cho `impl`
và `research`, Codex Luna cho `impl_deep`/`audit`, và Gemini UI cho `ui`. Đây là profile
cấu hình, không phải mock session; daemon vẫn resolve provider/model qua provider catalog
trước khi tạo agent.

## Runtime authority và MCP

Daemon gắn label cho agent thật để trace theo `workspaceId`, `briefId`, role, route và
profile. Runtime state được lưu tại `$JAGENTDESK_HOME/orchestration/runtime.json`, không
đặt trong UI state.

| Role       | Tool được cấp                                                                               | Giới hạn                                                     |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Supervisor | `orchestration.bootstrap_lead`                                                              | chỉ giữ/khởi tạo một Lead; không dispatch trực tiếp Peer     |
| Lead       | `orchestration.create_peer`, `orchestration.resolve_dissent`, `orchestration.accept_result` | chỉ staff Peer bounded, chịu technical acceptance            |
| Peer       | `orchestration.handback`                                                                    | không tạo agent, không dispatch, không accept toàn bộ result |

`create_agent` chung bị từ chối khi caller đã thuộc một run orchestration. Các tool scoped
đều kiểm tra role, workspace, parent agent, brief và route trước khi thực hiện. Dissent chỉ
nhận đúng một trong `RESOLVED_BY_LEAD`, `NEEDS_MORE_EVIDENCE`,
`ESCALATED_TO_HUMAN`; outcome `NEEDS_MORE_EVIDENCE` chỉ được mở một verification round.

Handback bắt buộc có `whatChangedOrInspected`, `evidence`, `remainingUncertainty` và
`counterevidence`; `requestedResolution`, `currentDirection`, `claim`, `risk` được dùng
khi handback là dissent.

## Wire surface

Các RPC mới dùng namespace dotted và response correlation bằng `requestId`:

- `orchestration.config.get.request/response`
- `orchestration.config.update.request/response`
- `orchestration.task.prepare.request/response`

Agent lifecycle vẫn đi qua daemon WebSocket/MCP hiện có; không có transport riêng cho
Orchestration và không có session giả trong app.

## UI surface

- Host → Orchestration: bật/tắt feature, automatic Task Brief, hỏi khi thiếu thông tin,
  chỉnh fan-out, thêm nhiều profile/provider/model cho từng role, chọn default và chỉnh
  primary semantic route.
- Workspace → Orchestration: nhập request tự nhiên, xem brief/status/route/acceptance,
  gửi cho Supervisor và theo dõi agent thật theo label role.

Desktop và mobile dùng cùng RPC và cùng daemon contract; khác biệt nền tảng không làm
thay đổi authority hoặc routing semantics.
