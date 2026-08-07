## ADDED Requirements

### Requirement: File-based JSON persistence under $JAGENTDESK_HOME
All server-side stores MUST persist as file-based JSON under `$JAGENTDESK_HOME` (defaulting to `~/.jagentdesk`), validated at runtime with Zod schemas, with no traditional database (JAgentDesk `$JAGENTDESK_HOME`/`~/.jagentdesk` becomes `$JAGENTDESK_HOME`/`~/.jagentdesk`) (`docs/data-model.md:33-35`).

#### Scenario: Home directory default
- **WHEN** `$JAGENTDESK_HOME` is unset
- **THEN** stores resolve under `~/.jagentdesk` and every persisted record is validated against its Zod schema before use (`docs/data-model.md:33-35`)

### Requirement: Atomic temp-then-rename writes owned by the store surface
Persistent server stores MUST write atomically by writing a temp file in the target directory then renaming it into place, and store APIs MUST own persistence atomicity so callers never coordinate raw read-merge-write loops, queues, or uniqueness races (`docs/data-model.md:37-39,71`).

#### Scenario: Atomic write
- **WHEN** a store persists a record
- **THEN** it writes a temp file in the target directory and renames it into place (`docs/data-model.md:71`); the loop store is the documented exception writing directly, serialized through an in-memory queue (`docs/data-model.md:402`)

### Requirement: No migration framework; forward compatibility via optional fields
The data model MUST NOT include a schema-versioning/migration framework; forward compatibility MUST rely on optional fields with defaults plus small inline normalization for legacy entries (`docs/data-model.md:33`).

#### Scenario: Absent field backfilled without migration
- **WHEN** an older record lacks `projectKey`
- **THEN** normal boot reconciliation fills it in place, with no migration step (`docs/data-model.md:11,496`)

### Requirement: Agent record store
Agents MUST be stored one file per agent at `$JAGENTDESK_HOME/agents/{sanitized-cwd}/{agentId}.json`, keyed by the UUID `id`, grouped by a `sanitized-cwd` directory derived by stripping the filesystem root and replacing path separators with `-` (`docs/data-model.md:52-54,71,75-104`).

#### Scenario: Agent path and id
- **WHEN** an agent with `cwd` and UUID `id` is persisted
- **THEN** its file path is `$JAGENTDESK_HOME/agents/{sanitized-cwd}/{id}.json` and ownership is carried by `workspaceId`, never inferred from `cwd` (`docs/data-model.md:77,86`)

### Requirement: Daemon configuration store
Daemon configuration MUST be a single file at `$JAGENTDESK_HOME/config.json` validated with `PersistedConfigSchema`, with all fields optional and sensible defaults (`docs/data-model.md:176-236`).

#### Scenario: Config defaults
- **WHEN** `config.json` omits git process limits
- **THEN** `maxProcessesPerSecond` defaults to `64` and `maxProcessConcurrency` defaults to `8` (`docs/data-model.md:240-241`)

### Requirement: Schedule store
Schedules MUST be stored one file per schedule at `$JAGENTDESK_HOME/schedules/{id}.json`, keyed by an 8-hex-character `id` (`docs/data-model.md:313-317`).

#### Scenario: Schedule id format
- **WHEN** a schedule is created
- **THEN** it is written to `$JAGENTDESK_HOME/schedules/{id}.json` where `id` is 8 hex characters (`docs/data-model.md:315-317`)

### Requirement: Chat store
Chat rooms and messages MUST be stored in a single file `$JAGENTDESK_HOME/chat/rooms.json` containing `rooms` and `messages` arrays, with UUID `id` keys and `roomId`/`replyToMessageId` foreign keys (`docs/data-model.md:361-395`).

#### Scenario: Single chat file
- **WHEN** a message is posted
- **THEN** it is appended to the `messages` array in `$JAGENTDESK_HOME/chat/rooms.json` with a UUID `id` and a `roomId` FK to `ChatRoom.id` (`docs/data-model.md:363-395`)

### Requirement: Loop store
Loops MUST be stored in a single file `$JAGENTDESK_HOME/loops/loops.json` containing an array of loop records keyed by an 8-char id, written directly (not atomic) and serialized through an in-memory queue, with `status: "running"` records recovered as `"stopped"` on startup (`docs/data-model.md:398-436`).

#### Scenario: Running loop recovered on boot
- **WHEN** the daemon starts and a loop record has `status: "running"`
- **THEN** it is recovered as `"stopped"` with an interruption log entry (`docs/data-model.md:402`)

### Requirement: Project registry store
Projects MUST be stored as an array of records in `$JAGENTDESK_HOME/projects/projects.json`, where new `projectId` values are opaque `prj_<16 hex>` and are never rekeyed (`docs/data-model.md:487-518`).

#### Scenario: Opaque project id
- **WHEN** a project is created for an exact normalized root
- **THEN** it receives an opaque `prj_<16 hex>` `projectId`; archived-only exact-root matches allocate a fresh opaque id rather than resurrecting the old one (`docs/data-model.md:495,516-518`)

### Requirement: Workspace registry store
Workspaces MUST be stored as an array of records in `$JAGENTDESK_HOME/projects/workspaces.json`, keyed by an opaque `wks_<hex>` `workspaceId` that MUST NOT be treated as a filesystem path and MUST be compared by exact equality, with `projectId` as a real FK to a project record (`docs/data-model.md:522-552`).

#### Scenario: Opaque workspace id is never a path
- **WHEN** a filesystem or git operation targets a workspace
- **THEN** it uses the `cwd`/`workspaceDirectory` field, never the opaque `wks_<hex>` `workspaceId` (`docs/data-model.md:530,547`)

### Requirement: Push token store
Expo push notification tokens MUST be stored as a `{ "tokens": [...] }` set in `$JAGENTDESK_HOME/push-tokens.json`, loaded with permissive parsing that filters non-string entries and persisted with atomic temp-file rename (`docs/data-model.md:556-566`).

#### Scenario: Non-string tokens filtered
- **WHEN** `push-tokens.json` is loaded
- **THEN** non-string entries are dropped and the surviving token set is persisted via atomic temp-file rename (`docs/data-model.md:566`)

### Requirement: Daemon meta files
The daemon MUST persist identity and coordination meta files under `$JAGENTDESK_HOME`: `server-id` (plain text `srv_<base64url>`, overridable via a server-id env var), `daemon-keypair.json` (`{ v: 2, publicKeyB64, secretKeyB64 }`, mode `0600`), a `*.pid` lock file (`{ pid, startedAt, ... }`), and `daemon.log` (path/rotation configurable via `log.file`) (`docs/data-model.md:570-579`).

#### Scenario: Server id format and PID lock
- **WHEN** the daemon boots
- **THEN** `$JAGENTDESK_HOME/server-id` holds a stable `srv_<base64url>` value (`docs/data-model.md:576`) and the `*.pid` lock prevents two daemons sharing one `$JAGENTDESK_HOME` (`docs/data-model.md:578`)

### Requirement: Runtime-only state is not persisted
Live terminals and live timelines MUST be runtime daemon state that is not persisted as JSON records; terminal ownership is carried by an in-memory `workspaceId` and re-fetched rather than stored (`docs/data-model.md:168-172`).

#### Scenario: Terminals not written to disk
- **WHEN** a terminal session is running
- **THEN** it exists only as live daemon state with a `workspaceId`, and workspace-scoped terminal lists include only terminals whose `workspaceId` matches (`docs/data-model.md:170-172`)

### Requirement: Paired-devices store for pairing
The daemon MUST persist a paired-devices store under `$JAGENTDESK_HOME` recording each paired device's public key so hello signatures can be verified, owned by the store surface with atomic writes (JAgentDesk pairing delta; ADR-0002; consistent with meta-file conventions in `docs/data-model.md:570-579`).

#### Scenario: Pairing verification source
- **WHEN** a `hello` arrives carrying a pairing `signature`
- **THEN** the daemon verifies it against a device public key recorded in the paired-devices store, and an unpaired device is not granted control even inside the tailnet (ADR-0002)
