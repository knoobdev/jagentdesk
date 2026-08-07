## ADDED Requirements

### Requirement: Agent lifecycle is explicit and persisted
Agent session MUST implement lifecycle `initializing → idle → running → idle`, with `error` and `closed` terminal/runtime states. `closed` MUST mean durable resumable record without live provider runtime, not deletion; transitions MUST persist and stream to subscribed clients (`scratchpad/reference/docs/agent-lifecycle.md:5-13`).

#### Scenario: Completed turn returns to idle
- **GIVEN** agent đang `idle` và chưa có foreground turn
- **WHEN** client gửi prompt hợp lệ và provider emits terminal `turn_completed`
- **THEN** agent đi qua `running` trong lúc xử lý rồi về `idle`, state transition được persist và broadcast

### Requirement: Create and run agent with explicit configuration
Daemon MUST create agent với UUID, provider, cwd/workspace, title/labels, mode, model, thinking option, feature values, system prompt/MCP config và optional initial prompt/attachments. Create MUST validate provider availability/mode trước khi launch; run MUST stream timeline events and final turn outcome (`scratchpad/reference/packages/server/src/server/agent/agent-manager.ts:1058-1099`; `scratchpad/reference/packages/server/src/server/agent/create-agent/create.ts:79-121,173-223`).

#### Scenario: Invalid provider mode fails before turn
- **GIVEN** create request chọn provider có tồn tại nhưng mode ID không thuộc manifest/provider snapshot tại cwd
- **WHEN** daemon xử lý create request
- **THEN** request bị reject trước khi gửi initial prompt vào provider runtime và không để lại agent `running` (`scratchpad/reference/packages/server/src/server/agent/create-agent/create.ts:241-267`)

### Requirement: One active foreground run per agent
AgentManager MUST reject a second prompt khi agent đã có active foreground turn hoặc tracked run. Khi provider chấp nhận turn, daemon MUST phát `turn_started`, set lifecycle `running`, stream timeline/tool events và kết thúc bằng completed/failed/canceled outcome (`scratchpad/reference/packages/server/src/server/agent/agent-manager.ts:2014-2049,2054-2085`).

#### Scenario: Concurrent prompt is rejected
- **GIVEN** agent có `activeForegroundTurnId` khác null
- **WHEN** client gửi prompt thứ hai
- **THEN** daemon trả lỗi `already has an active run` và không gọi `startTurn` lần hai (`scratchpad/reference/packages/server/src/server/agent/agent-manager.ts:2029-2042`)

### Requirement: Cancellation requires provider acknowledgement
Cancellation MUST chỉ đổi lifecycle sau khi provider acknowledge interrupt hoặc phát terminal turn event. Nếu interrupt bị reject hoặc timeout, agent MUST vẫn `running`, foreground turn hiện tại MUST còn nguyên và follow-up/reload/replacement/rewind MUST báo failure thay vì nhận work mới (`scratchpad/reference/docs/agent-lifecycle.md:27-29`).

#### Scenario: Failed interrupt does not create split brain
- **GIVEN** provider từ chối interrupt của turn đang chạy
- **WHEN** client gửi Stop rồi ngay lập tức gửi prompt mới
- **THEN** Stop báo failure, agent vẫn `running` và prompt mới bị từ chối cho đến khi provider phát terminal event

### Requirement: Resume, reload, replace and import preserve identity
Daemon MUST resume a closed persisted session bằng provider persistence handle dưới cùng agent ID; reload/replace MUST đóng runtime cũ an toàn trước khi đăng ký runtime mới; import MUST nhận provider handle + cwd, loại session đã import trùng, và có thể unarchive record cũ đúng cwd trước khi load (`scratchpad/reference/packages/server/src/server/agent/agent-manager.ts:1109-1160`; `scratchpad/reference/packages/server/src/server/agent/import-sessions.ts:117-185,194-240`).

#### Scenario: Closed agent resumes without duplicate identity
- **GIVEN** durable record `lastStatus=closed` có persistence handle
- **WHEN** user mở hoặc prompt agent đó
- **THEN** daemon khởi tạo provider session dưới agent ID cũ, hydrate timeline và không tạo record agent mới (`scratchpad/reference/docs/agent-lifecycle.md:17-22`)

#### Scenario: Already imported handle is rejected
- **GIVEN** provider handle đã gắn với một active agent record
- **WHEN** client gửi import cùng provider và handle
- **THEN** import bị reject với lỗi duplicate và không tạo workspace/agent thứ hai (`scratchpad/reference/packages/server/src/server/agent/import-sessions.ts:194-200`)

### Requirement: Archive is global soft delete with cascade
Archive MUST set `archivedAt`, normalize status khỏi `running|initializing`, notify subscribers, close runtime và recursively archive managed children. Archive MUST không xóa durable record; unarchive là thao tác riêng gọi native unarchive rồi resume/hydrate (`scratchpad/reference/docs/agent-lifecycle.md:50-67,75-82`).

#### Scenario: Parent archive cascades
- **GIVEN** parent agent có hai managed children mang parent label
- **WHEN** parent được archive
- **THEN** parent và cả hai children có `archivedAt`, runtime đóng và không còn trong active list của mọi client (`scratchpad/reference/docs/agent-lifecycle.md:52-67`)

### Requirement: Parent, detached, and provider-native subagents are distinct
Agent-scoped creation MUST asynchronous, mặc định cùng workspace và gắn parent label; detached agent MUST bỏ parent label nhưng giữ cwd/workspace/runtime và không còn bị parent archive cascade. Provider-native child MUST được hiển thị read-only timeline hoặc provider-backed handle, còn JAgentDesk/JAgentDesk subagent là full session có thể follow-up/archive (`scratchpad/reference/docs/agent-lifecycle.md:31-48`; `scratchpad/reference/public-docs/orchestration.md:13-33,49-60`).

#### Scenario: Detach changes relationship only
- **GIVEN** child agent đang ở subagent track của parent
- **WHEN** user gọi detach
- **THEN** parent label bị xóa, child giữ nguyên agent ID/cwd/workspace/status và archive parent sau đó không archive child

### Requirement: Timeline, attention, permissions, and structured output are session surfaces
Session MUST lưu/stream canonical timeline gồm user/assistant/tool/reasoning/status items, usage và attention metadata; composer MUST hỗ trợ attachments, queue, permission card, plan card và question form. Run MUST hỗ trợ background/no-wait và optional output schema; permission state MUST không bị giả lập thành completed turn (`scratchpad/reference/packages/server/src/server/agent/agent-manager.ts:741-757`; `scratchpad/reference/public-docs/cli.md:26-48,122-150`; `scratchpad/reference/docs/data-model.md:93-104`).

#### Scenario: Background run remains observable
- **GIVEN** client gửi prompt với background/no-wait
- **WHEN** request response trả về trước khi turn kết thúc
- **THEN** agent tiếp tục chạy ở daemon, timeline/attention event vẫn stream tới subscriber và output schema chỉ trả JSON phù hợp khi run kết thúc

