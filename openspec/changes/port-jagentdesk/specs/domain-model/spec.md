## ADDED Requirements

### Requirement: Project identity is stable and path-scoped
Mỗi project MUST dùng identity opaque `prj_<16 hex>` cho root filesystem đã normalize bằng `path.resolve`; project đang active có cùng exact root MUST idempotent, còn project chỉ archived MUST không tự resurrect. `projectKey` là equivalence key persisted riêng với `projectId`, không được suy ra lại từ Git trong runtime (`scratchpad/reference/docs/data-model.md:3-17`).

#### Scenario: Reopening an exact root is idempotent
- **GIVEN** registry đã có active project với exact root `/workspace/repo`
- **WHEN** daemon nhận yêu cầu mở lại cùng root sau restart
- **THEN** daemon trả cùng project ID, không tạo project thứ hai và không đổi root/default name (`scratchpad/reference/docs/data-model.md:3-17`)

### Requirement: Workspace is the durable placement authority
Workspace MUST lưu `projectId`, exact `cwd`, backing `worktreeRoot`, `displayName` và `baseBranch` cần thiết cho placement. `cwd` là thư mục thực thi agent; `worktreeRoot` là checkout backing và có thể khác `cwd`; reconciliation MAY cập nhật mutable Git metadata nhưng MUST không đổi `projectId`, `cwd`, `displayName`, `baseBranch` hoặc foreign keys (`scratchpad/reference/docs/data-model.md:19-31`).

#### Scenario: Reconciliation preserves ownership
- **GIVEN** workspace có `projectId`, `cwd` và `baseBranch` đã persisted
- **WHEN** Git branch hoặc kind thay đổi rồi watcher chạy reconciliation
- **THEN** chỉ mutable Git metadata và `updatedAt` thay đổi; `projectId`, `cwd` và agent-workspace relationship giữ nguyên (`scratchpad/reference/docs/data-model.md:13-31`)

### Requirement: Agent record has explicit workspace ownership
Agent record MUST có UUID `id`, `provider`, `cwd`, `workspaceId` và lifecycle/attention metadata; runtime MUST resolve ownership bằng `workspaceId`, không suy luận từ `cwd`. Hai agent có cùng cwd nhưng khác workspace MUST được coi là độc lập (`scratchpad/reference/docs/data-model.md:75-104`).

#### Scenario: Same cwd does not merge agents
- **GIVEN** hai agent có cùng `cwd` nhưng có hai `workspaceId` khác nhau
- **WHEN** daemon tính workspace status hoặc list agent theo workspace
- **THEN** mỗi agent chỉ xuất hiện trong workspace của nó và activity của một agent không làm đổi status workspace kia (`scratchpad/reference/docs/data-model.md:85-93`; `scratchpad/reference/docs/data-model.md:168-172`)

### Requirement: File-based JSON persistence under JAGENTDESK_HOME
JAgentDesk MUST lưu server-side records dưới `$JAGENTDESK_HOME`, mặc định `~/.jagentdesk`, bằng file-based JSON có runtime validation; MUST không dùng database hoặc migration framework. Layout MUST giữ entity separation tương đương JAgentDesk gồm `agents/`, `schedules/`, `chat/`, `loops/`, `projects/`, `runtime/` và push-token store (`scratchpad/reference/docs/data-model.md:33-35,43-69`).

#### Scenario: Default home and validation
- **GIVEN** `$JAGENTDESK_HOME` không được thiết lập
- **WHEN** daemon khởi động và đọc một record
- **THEN** daemon dùng `~/.jagentdesk` và reject record không parse được schema trước khi đưa vào runtime (`scratchpad/reference/docs/data-model.md:33-35`)

### Requirement: Store APIs own atomicity and compatibility
Store API MUST tự quản lý read/merge/write, uniqueness và queue cần thiết. Các store atomic MUST write temp file trong target directory rồi rename vào vị trí chính; forward compatibility MUST dùng optional fields/defaults và inline normalization nhỏ, không thêm migration framework (`scratchpad/reference/docs/data-model.md:33,37-39,71`).

#### Scenario: Concurrent writes do not lose records
- **GIVEN** hai request đồng thời cập nhật cùng một store
- **WHEN** cả hai request hoàn tất
- **THEN** serialization/atomicity thuộc store bảo đảm file cuối parse được và không có caller nào phải tự điều phối raw read-merge-write (`scratchpad/reference/docs/data-model.md:37-39,71`)

### Requirement: Schedule and chat are first-class domain entities
Schedule MUST là một file `{id}.json` với ID 8 hex, cadence cron/every, target existing agent hoặc new agent, run history và status `active|paused|completed`. Chat MUST lưu rooms/messages trong một file, room name unique không phân biệt hoa thường, message có `roomId`, author, body, mentions và optional reply FK (`scratchpad/reference/docs/data-model.md:313-357,361-395`).

#### Scenario: Schedule run creates auditable history
- **GIVEN** schedule active có target `new-agent`
- **WHEN** cadence tới hạn và daemon thực thi
- **THEN** daemon ghi một ScheduleRun với `scheduledFor`, `startedAt`, status terminal `succeeded|failed`, và agent ID nếu tạo agent (`scratchpad/reference/docs/data-model.md:319-357`)

#### Scenario: Chat mention keeps foreign keys
- **GIVEN** room đã tồn tại
- **WHEN** agent gửi message có `@mention` và reply tới message cũ
- **THEN** message mới có UUID, `roomId` hợp lệ, `replyToMessageId` nếu có và danh sách mention agent IDs được trích xuất (`scratchpad/reference/docs/data-model.md:374-395`)

### Requirement: Loop is a recoverable orchestration record
Loop MUST lưu worker/verifier provider/model/mode, verification checks, sleep/time/iteration budgets, active worker/verifier IDs, iteration history và logs. Loop writes MUST được serialize; khi daemon startup gặp record `running`, daemon MUST phục hồi nó thành `stopped` kèm interruption log (`scratchpad/reference/docs/data-model.md:398-450`).

#### Scenario: Interrupted loop is not falsely running
- **GIVEN** `loops.json` có record status `running` trước khi daemon bị dừng
- **WHEN** daemon khởi động lại
- **THEN** record chuyển thành `stopped`, có log interruption và không báo active worker nếu process không còn tồn tại (`scratchpad/reference/docs/data-model.md:400-402`)

