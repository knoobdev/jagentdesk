## ADDED Requirements

### Requirement: Built-in provider registry
JAgentDesk MUST đăng ký và expose các built-in provider `claude`, `codex`, `copilot`, `opencode`, `pi`, `omp`; mỗi provider MUST có ID, label, description, default mode (có thể null), mode definitions và optional voice defaults. Provider `omp` MUST mặc định disabled như JAgentDesk; unknown provider ID MUST bị reject (`scratchpad/reference/packages/protocol/src/provider-manifest.ts:24-36,190-251,271-282`).

#### Scenario: Built-in catalog is deterministic
- **GIVEN** daemon khởi động với provider registry mặc định
- **WHEN** client yêu cầu catalog
- **THEN** catalog có đủ sáu provider IDs nêu trên, `omp` không enabled nếu chưa opt-in, và một ID ngoài registry không thể tạo agent (`scratchpad/reference/packages/protocol/src/provider-manifest.ts:190-251,271-305`)

### Requirement: Provider mode and permission metadata
Mỗi mode MUST có `id`, English `label`, description, icon, color tier và optional `isUnattended`; mode semantics MUST được preserve, gồm Claude `Plan Mode`/`Always Ask`/`Accept File Edits`/`Auto mode`/`Bypass`, Codex `Default Permissions`/`Auto-review`/`Full Access`, OpenCode `Build`/`Plan` và OMP `Full Access`/`Write Approval`/`Always Ask` (`scratchpad/reference/packages/protocol/src/provider-manifest.ts:38-168`).

#### Scenario: Unattended mode is marked dangerous
- **GIVEN** client chọn mode `bypassPermissions`, `full-access` hoặc `full`
- **WHEN** daemon gửi mode metadata cho UI
- **THEN** mode có `isUnattended=true`, `colorTier=dangerous` và UI hiển thị cảnh báo trước khi create/run

### Requirement: Runtime provider and model discovery
Provider adapter MUST report availability, models, thinking options, feature controls và runtime modes khi provider hỗ trợ; ACP provider MUST được coi runtime-discovered source of truth cho capabilities/modes/models, còn static UI metadata chỉ enrich icon/color (`scratchpad/reference/packages/protocol/src/provider-manifest.ts:21-23`; `scratchpad/reference/public-docs/custom-providers.md:134-177`).

#### Scenario: ACP catalog resolves at runtime
- **GIVEN** custom ACP command khởi động thành công và trả capabilities qua initialize/session
- **WHEN** client mở provider settings
- **THEN** catalog hiển thị modes/models/features do ACP báo, merge `additionalModels` theo model ID và không yêu cầu danh sách static đầy đủ (`scratchpad/reference/public-docs/custom-providers.md:134-177`)

### Requirement: Native and ACP provider implementations
JAgentDesk MUST hỗ trợ native Claude Code, Codex app-server, OpenCode, Pi và OMP theo provider adapters; MUST hỗ trợ GitHub Copilot và các provider ACP qua stdio; catalog ACP MUST giữ các provider JAgentDesk công bố và cho phép cài/chạy entry đã version-pin, nhưng provider không có trong catalog vẫn có thể add thủ công (`scratchpad/reference/public-docs/supported-providers.md:13-20,22-62`).

#### Scenario: Provider adapter selection
- **GIVEN** user tạo agent với provider `codex`
- **WHEN** daemon resolves provider
- **THEN** daemon chọn Codex app-server adapter với sandbox/approval controls; nếu chọn một ACP entry thì daemon spawn command stdio và dùng ACP handshake thay vì native adapter

### Requirement: Custom provider overrides are validated and isolated
Custom provider config MUST nằm dưới `agents.providers`, có lowercase alphanumeric-hyphen ID, `extends` là built-in ID hoặc `acp`, label, và MAY override env, command, model list, additionalModels, disallowedTools, enabled hoặc order. Nhiều profile cùng base provider MUST được tách credentials/model list; disabling một entry MUST không disable entry khác (`scratchpad/reference/public-docs/custom-providers.md:9-19,95-116,118-189`).

#### Scenario: Invalid custom ID is rejected
- **GIVEN** config khai báo provider ID chứa uppercase hoặc ký tự không thuộc `[a-z][a-z0-9-]*`
- **WHEN** daemon loads provider settings
- **THEN** config entry bị reject/diagnosed trước khi provider xuất hiện trong catalog hoặc được dùng để launch agent (`scratchpad/reference/public-docs/custom-providers.md:11-20`)

### Requirement: Availability and failure diagnostics are observable
Provider registry MUST phân biệt enabled, installed/available và runnable; UI/CLI MUST expose diagnostic reason khi binary thiếu, authentication lỗi, model discovery timeout hoặc provider bị disabled. Agent creation MUST fail before a foreground turn nếu provider unavailable (`scratchpad/reference/public-docs/supported-providers.md:13-20`; `scratchpad/reference/packages/server/src/server/agent/agent-manager.ts:1071-1092`).

#### Scenario: Missing CLI does not create a running agent
- **GIVEN** provider entry enabled nhưng underlying CLI không tồn tại hoặc không authenticated
- **WHEN** user yêu cầu create agent
- **THEN** request trả availability diagnostic, không spawn turn và không để agent ở `running`

### Requirement: Provider selection supports model, thinking, features, and voice
Agent config MUST cho phép chọn provider/model, thinking option, mode và provider feature values; provider có voice declaration MUST expose default voice mode/model, còn provider không khai báo voice MUST không bị hiển thị như voice-capable (`scratchpad/reference/docs/data-model.md:106-128`; `scratchpad/reference/packages/protocol/src/provider-manifest.ts:24-36,190-251`).

#### Scenario: Provider-specific feature survives create
- **GIVEN** client chọn provider có feature toggle/select và giá trị model/thinking hợp lệ
- **WHEN** daemon creates session
- **THEN** persisted config và runtime info giữ provider, model, thinking option, mode và feature values để lần resume sau khôi phục cùng lựa chọn (`scratchpad/reference/docs/data-model.md:106-128`)

### Requirement: Cross-provider orchestration is first-class
JAgentDesk MUST cho phép agent/MCP/CLI discover provider-model catalog, tạo subagent full-session bằng provider khác, chọn current hoặc explicit workspace, gửi follow-up và nhận finish notification. Native provider subagents vẫn provider-owned/read-only; daemon-managed subagents MUST có lifecycle và track riêng (`scratchpad/reference/public-docs/orchestration.md:9-33,35-60`; `scratchpad/reference/public-docs/cli.md:11-13,40-48`).

#### Scenario: Planner launches a cross-provider worker
- **GIVEN** một agent đang chạy và catalog có provider/model khác
- **WHEN** agent gọi orchestration create với workspace ID explicit
- **THEN** daemon tạo worker trong workspace đó, giữ parent relationship của planner, worker xuất hiện trong Subagents track và có thể nhận follow-up/notify khi hoàn tất (`scratchpad/reference/public-docs/orchestration.md:23-60`)

