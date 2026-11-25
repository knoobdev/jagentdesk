# Data Model

## Project identity

Projects are allocated for the exact root selected by the caller, normalized lexically with `path.resolve` (never `realpath`). New project IDs are opaque `prj_<16 hex>` values. Existing remote-shaped or path-shaped IDs are retained as readable compatibility records and are never rekeyed. An active exact root is idempotent; archived-only matches do not resurrect an old project. Workspace `projectId` is stable membership: reconciliation may update git-derived kind and branch metadata, but never rehomes a workspace or changes a project's root, ID, or default name.

`projectKey` is a persisted, opaque equivalence key used only to group the same logical project
across hosts. It is separate from the host-local `projectId`; today's producer prefers a normalized
Git remote and otherwise uses the local project root. Consumers never derive it from live Git.
Creation persists it with the project, and normal boot reconciliation fills it for
older records where the field is absent—there is no migration.

`kind` and `projectKey` are mutable metadata, not identity. Workspace reconciliation watches active project roots and
updates those fields and `updatedAt` when Git facts change, preserving the project's ID, root path,
names, and workspace foreign keys. Attached workspaces are independently refreshed
from their own cwd, so an explicit project root never implies a workspace checkout. Empty projects
are observed too.

The workspace registry model defines placement once: initial directory/worktree construction,
mutable reconciliation fields, and the persisted-to-wire checkout projection. Its update policy
preserves `displayName` and `baseBranch`. `WorkspaceProvisioningService` owns the corresponding
registry writes, so directory opens, agent imports, and worktree creation all enter through that
service instead of constructing records independently. The workspace record is then the durable
placement authority: `cwd` is the exact execution directory, while `worktreeRoot` is the backing
checkout root. They intentionally differ for an exact subproject inside a worktree. Archive,
restore, branch auto-name, and descriptor flows consume those persisted facts rather than
rediscovering ownership from a directory that may already be gone. Reconciliation may refresh
mutable placement facts, but never changes `projectId`, `cwd`, `displayName`, or `baseBranch`.
Workspace archive runs lifecycle teardown from the exact `cwd` but removes only the backing
`worktreeRoot` after its last active reference disappears. Worktree recovery recreates that backing
checkout from `mainRepoRoot`, then restores the relative path from `worktreeRoot` to `cwd`.

JAgentDesk uses **file-based JSON persistence** for its core records. [Bots](bots.md) use SQLite (`bots/bots.sqlite`) for their transactional records and trigger deduplication. All data is validated at runtime with Zod schemas, and the schema file named in each section is the field reference. Core stores write atomically: write a temp file in the target directory, then rename it into place. There is no schema-versioning framework. Schemas add optional fields with defaults; the one record migration is the `workspaceId` backfill in `packages/server/src/server/migrations/`, and `persisted-config.ts` normalizes a few legacy provider and speech entries inline.

All server-side stores live under `$JAGENTDESK_HOME` (defaults to `~/.jagentdesk`).

## Store Surface Rules

Store APIs own persistence atomicity and should not make services coordinate raw reads and writes. A good store method maps cleanly to one SQL statement or one SQL transaction, even when the current implementation is JSON files. If a caller needs a queue, lock, read-merge-write loop, or uniqueness race workaround, that behavior belongs behind the store surface.

---

## Directory layout

```
$JAGENTDESK_HOME/
├── config.json                          # Daemon configuration
├── server-id                            # Stable daemon identifier (plain text, "srv_<base64url>")
├── daemon-keypair.json                  # Noise key and relay ownership key (mode 0600)
├── paired-devices.json                  # Paired desktop, mobile and daemon devices
├── hosts.json                           # Saved hosts and their device keys (mode 0600)
├── finish-subscriptions.json            # Durable local finish-notification intent
├── remote-finish-subscriptions.json     # Finish intent for agents on saved hosts
├── jagentdesk.pid                       # Daemon PID lock file
├── daemon.log                           # Default log file (path configurable)
├── agents/
│   └── {sanitized-cwd}/
│       └── {agentId}.json               # One file per agent
├── schedules/
│   └── {scheduleId}.json                # One file per schedule
├── chat/
│   └── rooms.json                       # All rooms + messages
├── loops/
│   └── loops.json                       # All loop records
├── bots/
│   └── bots.sqlite                      # Bots, items, rooms, trigger dedupe
├── orchestration/
│   └── runtime.json                     # Orchestration assignments and handbacks
├── projects/
│   ├── projects.json                    # Project registry
│   ├── workspaces.json                  # Workspace registry
│   └── icons/                           # Host-local custom project icon images
├── worktrees/                           # JAgentDesk-owned worktrees (unless worktrees.root is set)
├── runtime/
│   └── managed-processes/
│       └── {recordId}.json              # Helper processes owned by JAgentDesk; reconciled on daemon bootstrap
└── push-tokens.json                     # Expo push notification tokens
```

Built-in plugins keep their own data under the home as well; [builtin-plugins.md](builtin-plugins.md) treats those paths as release contracts.

The `agents/{sanitized-cwd}/` directory name is derived from the agent's `cwd` by stripping the filesystem root and replacing path separators with `-` (Windows drive letters become a `C-` style prefix).

---

## 1. Agent Record

**Path:** `$JAGENTDESK_HOME/agents/{project-dir}/{agentId}.json`
**Schema:** `packages/server/src/server/agent/agent-storage.ts`

Each agent is stored as a separate JSON file, grouped by project directory. The record holds
identity, configuration, the provider persistence handle, and status. It does not hold the
timeline: the daemon keeps projected items in memory and rebuilds them from provider history
when the agent resumes ([timeline-sync.md](timeline-sync.md)).

Fields whose meaning the schema does not show:

- `workspaceId` — the single source of ownership. Every agent is stamped with one at create time; legacy cwd-only records are backfilled once by `migrations/backfill-workspace-id.migration.ts` (the only place a cwd→id mapping exists). Runtime code never infers ownership or status from cwd: status is computed per `workspaceId`, and same-cwd siblings are independent.
- `labels` — `jagentdesk.parent-agent-id` is set automatically for agent-scoped creation and removed by detach. See [agent-lifecycle.md](agent-lifecycle.md).
- `lastStatus` — `closed` means the record is resumable but has no live provider runtime. Archive is represented separately by `archivedAt`.
- `sessionMetrics` — provider-formatted session stats, replaced as a whole. Independent of the cumulative usage Insights reads.
- `internal` — system-internal agents such as loop workers.
- `background` — hidden from default discovery and agent-announcing surfaces; fixed at creation.
- `metadata` — plugin-owned data. JAgentDesk stores it and never reads a key.

---

## Runtime-only Terminal Sessions

Terminals are live daemon state, not persisted JSON records. A terminal carries a `workspaceId` while it is running; workspace-scoped terminal lists include only terminals with the matching `workspaceId`. Legacy live terminals without an owner remain visible to unscoped terminal reads but contribute to no workspace status.

Terminal activity contributes to the workspace status bucket **per `workspaceId`**: a working terminal drives `running` onto the workspace it carries only. Same-`cwd` siblings are untouched; terminal visibility is likewise `workspaceId`-scoped.

---

## 2. Daemon Configuration

**Path:** `$JAGENTDESK_HOME/config.json`

The `daemon.orchestration` branch is the durable provider/model routing and topology policy;
its roles may contain multiple profiles and its runtime assignments/handbacks are stored
separately under `$JAGENTDESK_HOME/orchestration/runtime.json`. See
[orchestration.md](orchestration.md) for the role and evidence contract.

Single file, validated with `PersistedConfigSchema` (`packages/server/src/server/persisted-config.ts`). All fields are optional with defaults. Top-level keys:

| Key              | Holds                                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `daemon`         | `listen`, `hostnames`, `trustedProxies`, `mcp`, `relay`, `git`, `cors`, `serviceProxy`, `auth`, `orchestration`, profiles, and per-feature switches |
| `tailnet`        | Embedded Tailscale `hostname`, `host`, and `stateDir`                                                                                               |
| `app`            | `baseUrl` for links back into the app                                                                                                               |
| `builtinPlugins` | Per-host `{ [id]: { enabled } }` toggles for built-in plugins. Unknown ids are ignored                                                              |
| `plugins`        | Installed local plugin sources, with `pluginsEnabled` as the master switch ([plugins.md](plugins.md))                                               |
| `usage`          | `{ enabled }` switch for the Usage feature (account quotas from usage-source plugins); on unless `false`                                            |
| `providers`      | `local.modelsDir` for local speech models                                                                                                           |
| `agents`         | `providers` overrides, `metadataGeneration`, `resumeOnStartup`, `resumePrompt`, `idleRuntimeCleanup` ([agent-lifecycle.md](agent-lifecycle.md))     |
| `worktrees`      | `root` for new worktrees (default `$JAGENTDESK_HOME/worktrees`) and `servicePorts` allocation                                                       |
| `features`       | `dictation`, `voiceMode`, `webUi`                                                                                                                   |
| `log`            | Level, format, console and file targets, rotation                                                                                                   |

`agents.providers` entries use `ProviderOverrideSchema`. Legacy entries with `command: { mode, ... }`
migrate to the current shape on load. Custom provider IDs must declare `extends` (one of the
built-ins or `"acp"`) and `label`. See `provider-launch-config.ts` and
[custom-providers.md](custom-providers.md). Relay keys are covered in [relay.md](relay.md#configuration).

### Git process limits

Git process limits are global to one daemon. The start-rate limit defaults to `64` processes per
second, and the concurrency limit defaults to `8`:

```json
{
  "daemon": {
    "git": {
      "maxProcessesPerSecond": 64,
      "maxProcessConcurrency": 8
    }
  }
}
```

`maxProcessesPerSecond` limits Git process starts in any one-second interval. The allowance can
start as a burst; it does not wait for earlier processes to exit. `maxProcessConcurrency` limits
the number of Git processes that have started but not exited. Every Git command uses both limits,
including initial workspace reads, filesystem-triggered refreshes, background checks, and explicit
requests.

Environment variables override `config.json`:

| Environment variable                      | Setting                  |
| ----------------------------------------- | ------------------------ |
| `JAGENTDESK_GIT_MAX_PROCESSES_PER_SECOND` | `maxProcessesPerSecond`  |
| `JAGENTDESK_GIT_MAX_PROCESS_CONCURRENCY`  | `maxProcessConcurrency`  |
| `JAGENTDESK_GIT_CONCURRENCY`              | Legacy concurrency alias |

`JAGENTDESK_GIT_MAX_PROCESS_CONCURRENCY` wins when it and the legacy alias are both set. Restart the
daemon after changing the file or environment. Run `jagentdesk daemon restart` for a standalone daemon.
For a desktop-managed daemon, fully quit and reopen JAgentDesk Desktop.

`agents.metadataGeneration.providers` controls the preferred structured-generation fallback order for daemon-side metadata tasks such as commit messages, PR text, branch names, and generated agent titles. Entries are tried first in the configured order, then JAgentDesk falls through to dynamically discovered defaults and finally the current selection when available.

### Speech settings

Configure Speech-to-text, Listening and Speaking independently under **Settings → host → Voice**.
Local downloads show model sizes and languages before installation. Voice mode defaults to off;
hosts that never saved a choice will find it disabled after upgrading.

Credentials belong to their use site: `features.dictation.stt`, `features.voiceMode.stt` or
`features.voiceMode.tts`. Select `provider` (`local` or `openai`) at each site. OpenAI sites accept
`apiKey`, `baseUrl` and `model`. STT accepts `language`; OpenAI STT also accepts
`confidenceThreshold`. OpenAI TTS accepts `voice`; local TTS accepts `speakerId` and `speed`.

Legacy `providers.openai` credentials fold into sites that explicitly select OpenAI on load.
Endpoint-specific values win over shared values. Unused legacy keys are discarded with a warning
that contains only config paths. The next save writes the inline shape. Normalization preserves
unrelated keys, including `builtinPlugins`, relay settings and `agents.providers` API blocks.
Same-provider patches keep saved keys; changing provider replaces that site's fields. Reads redact keys.

Provider environment overrides are `JAGENTDESK_DICTATION_STT_PROVIDER`,
`JAGENTDESK_VOICE_STT_PROVIDER` and `JAGENTDESK_VOICE_TTS_PROVIDER`. The sheet marks overridden
fields read-only. Saved API keys and base URLs win over `OPENAI_STT_*`, `OPENAI_TTS_*` and shared
`OPENAI_*` fallbacks. These settings apply only to JAgentDesk speech.

JAgentDesk uses these paths under the configured OpenAI base URL:

- dictation STT: `/v1/audio/transcriptions`
- voice mode STT: `/v1/audio/transcriptions`
- voice mode TTS: `/v1/audio/speech`

---

## 3. Schedule

**Path:** `$JAGENTDESK_HOME/schedules/{id}.json`
**Schema:** `StoredScheduleSchema` (`packages/protocol/src/schedule/types.ts`)

One file per schedule; the ID is 8 hex characters. `cadence` is `cron` (absent `timezone` means
UTC) or the legacy rolling `every`, which stays readable and executable until its `COMPAT` tag
expires. `target` either sends to an existing agent or creates a new agent from a stored config.
`runs` is the execution history.

---

## 4. Chat

**Path:** `$JAGENTDESK_HOME/chat/rooms.json`
**Schema:** `ChatRoomSchema` and `ChatMessageSchema` (`packages/protocol/src/chat/types.ts`)

Single file containing all rooms and messages. Room names are unique case-insensitively. Message
`mentionAgentIds` are extracted from `@mentions` in the body.

---

## 5. Loop

**Path:** `$JAGENTDESK_HOME/loops/loops.json`
**Schema:** `LoopRecordSchema` (`packages/server/src/server/loop-service.ts`)

Single file containing an array of all loop records. Writes are serialized through an in-memory
queue. On daemon startup any record with `status: "running"` is recovered as `"stopped"` with an
interruption log entry.

---

## 6. Project Registry

**Path:** `$JAGENTDESK_HOME/projects/projects.json`

Array of project records. Schema: `PersistedProjectRecordSchema` (`packages/server/src/server/workspace-registry.ts`).

| Field                | Type                        | Description                                                                                                                                |
| -------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `projectId`          | `string`                    | Host-local primary key; new records use opaque `prj_<16 hex>` IDs                                                                          |
| `projectKey`         | `string \| null`            | Persisted opaque cross-host grouping key; reconciliation backfills absent values                                                           |
| `rootPath`           | `string`                    | Exact lexically normalized selected root; never realpathed                                                                                 |
| `kind`               | `"git" \| "non_git"`        | Mutable Git observation about `rootPath`, never a membership key                                                                           |
| `displayName`        | `string`                    | Selected-root basename, stable across remote and Git changes                                                                               |
| `customName`         | `string \| null`            | User-set override layered over `displayName`. Null means "use the derived name".                                                           |
| `customIconRevision` | `string \| null`            | Identifies the host-local custom icon stored under `projects/icons/`. Null means the icon is discovered by scanning the project directory. |
| `createdAt`          | `string` (ISO 8601)         |                                                                                                                                            |
| `updatedAt`          | `string` (ISO 8601)         |                                                                                                                                            |
| `archivedAt`         | `string \| null` (ISO 8601) | Soft-delete timestamp; required nullable                                                                                                   |

Uploading a file and pasting a website or image URL are two ways of _acquiring_ the same custom
icon. The client fetches URL imports and sends their bytes through the upload RPC. The daemon never
receives or fetches the URL; it validates the uploaded bytes, stores them, and records a new
`customIconRevision`. Going back to automatic deletes the stored image, as does removing the
project.

Active exact roots are idempotent using lexical platform-equivalence semantics. Existing legacy
remote-shaped and path-shaped IDs remain readable, including duplicate roots; reconciliation never
merges them, transfers names, archives them, or moves workspace foreign keys. An explicit
workspace `projectId` is authoritative when it names an active project, regardless of cwd
containment. Archived-only exact-root records are not resurrected by explicit add/open; a fresh
opaque project is allocated instead. Agent restore is separate and restores the agent's existing
workspace together with its owning project.

---

## 7. Workspace Registry

**Path:** `$JAGENTDESK_HOME/projects/workspaces.json`

Array of workspace records. A workspace is a specific working directory within a project. Schema: `PersistedWorkspaceRecordSchema` (`packages/server/src/server/workspace-registry.ts`).

| Field                          | Type                                            | Description                                                                                                                                                                                   |
| ------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaceId`                  | `string`                                        | Opaque stable identifier (`wks_<hex>`), generated independently of the directory. MUST NOT be treated as a path; compare by exact equality. Use the `cwd` field for directory access.         |
| `projectId`                    | `string`                                        | FK to Project.projectId; the workspace's stable project membership                                                                                                                            |
| `cwd`                          | `string`                                        | Exact execution directory selected for agents, files, scripts, and setup                                                                                                                      |
| `kind`                         | `"local_checkout" \| "worktree" \| "directory"` | Mutable checkout classification                                                                                                                                                               |
| `displayName`                  | `string`                                        | The human name (the generated/derived title). Decoupled from `branch` by construction.                                                                                                        |
| `title`                        | `string \| null`                                | User-set name override layered over `displayName`. Null means "use `displayName`".                                                                                                            |
| `branch`                       | `string \| null`                                | The current Git branch for git-backed workspaces. Separate from `displayName`/`title`; a background branch refresh never rewrites the name.                                                   |
| `worktreeRoot`                 | `string \| null`                                | Backing checkout/worktree root. May differ from `cwd` for exact subprojects and remains persisted after the worktree is deleted so restore can reproduce the placement.                       |
| `baseBranch`                   | `string \| null`                                | Comparison base retained across archive and restore. Branch-off creation stores the resolved ref; legacy and PR-checkout records hold a bare name. Null means no recorded base.               |
| `isJAgentDeskOwnedWorktree`    | `boolean`                                       | Whether JAgentDesk owns and may remove/recreate the backing `worktreeRoot`                                                                                                                    |
| `mainRepoRoot`                 | `string \| null`                                | Main repository root for worktree checkouts, independent of both exact `cwd` and backing `worktreeRoot`                                                                                       |
| `createdAt`                    | `string` (ISO 8601)                             |                                                                                                                                                                                               |
| `updatedAt`                    | `string` (ISO 8601)                             |                                                                                                                                                                                               |
| `archivedAt`                   | `string \| null` (ISO 8601)                     | Soft-delete; required nullable                                                                                                                                                                |
| `autoArchivedChangeRequestUrl` | `string \| null`                                | Change request whose merged state triggered auto-archive. Restore replaces it with the current merged change request, when present, so repeated snapshots cannot archive the workspace again. |
| `pinnedAt`                     | `string \| null` (ISO 8601)                     | Pinned-to-top-of-sidebar timestamp; null means "not pinned"                                                                                                                                   |
| `background`                   | `boolean`                                       | Hidden from default discovery; agents inside it are effectively background                                                                                                                    |
| `metadata`                     | `Record<string, JSON>`                          | Plugin-owned data. JAgentDesk stores it and never reads a key                                                                                                                                 |
| `untrustedSource`              | `{ kind: "change_request", … }?`                | Set for checkouts of an untrusted change request; workspace setup automation is skipped                                                                                                       |

> **Opaque-ID invariant:** `workspaceId` is opaque identity, never a filesystem path. Filesystem and git operations take `cwd`/`workspaceDirectory` only — never the id. A compatibility-only first-materialization bootstrap still groups pre-registry agent records by path and Git remote so existing installs retain their legacy records. That grouping never runs against a live registry, and its keys are not runtime project or workspace identity.

`projectId` is still a real FK: workspace records should have a matching project record. Read-only
history surfaces tolerate transient orphaned workspaces by omitting those rows so one bad FK cannot
blank the whole History screen, but mutation paths should repair or remove the orphaned state rather
than treating it as valid.

---

## 8. Push Token Store

**Path:** `$JAGENTDESK_HOME/push-tokens.json`

```json
{
  "tokens": ["ExponentPushToken[...]", ...]
}
```

Simple set of Expo push notification tokens. Loaded with permissive parsing (filters non-string entries). Written atomically as a private file.

---

## 9. Daemon meta files

These small files are not validated as full Zod schemas but are persisted under `$JAGENTDESK_HOME` for daemon identity and runtime coordination.

| Path                  | Format                                 | Notes                                                                                                                                                                                               |
| --------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server-id`           | Plain text, e.g. `srv_<base64url>`     | Stable per-`$JAGENTDESK_HOME` daemon ID. Overridable via `JAGENTDESK_SERVER_ID` env.                                                                                                                |
| `daemon-keypair.json` | `{ v: 2, publicKeyB64, secretKeyB64 }` | Noise key used for pairing and E2EE. `relayPublicKeyB64`/`relaySecretKeyB64` appear after the first relay enable. Mode `0600`. Keep it with `server-id`; see [relay.md](relay.md#trust-boundaries). |
| `paired-devices.json` | JSON `{ devices: [...] }`              | Device public keys, kinds, and pinned tailnet node IDs ([permissions.md](permissions.md#device-pairing)).                                                                                           |
| `hosts.json`          | JSON                                   | Saved-host registrations with private device keys. Mode `0600`; keep out of diagnostic bundles ([connected-hosts.md](connected-hosts.md)).                                                          |
| `jagentdesk.pid`      | JSON `{ pid, startedAt, ... }`         | PID lock; prevents two daemons sharing one `$JAGENTDESK_HOME`. `desktopManaged` marks a daemon the desktop app started.                                                                             |
| `daemon.log`          | Pino log output                        | Default location; path/rotation configurable via `log.file` in `config.json`.                                                                                                                       |

---

## Client-side stores (App)

These live in React Native `AsyncStorage` or browser `IndexedDB`, not on the daemon filesystem.

### Keying convention: directory-backed vs workspace-owned

Right-sidebar client state splits on whether it is determined by the directory or owned by the workspace (two workspaces can share one `cwd`). The split is enforced by the cache key, so changing a key changes the sharing semantics — see [architecture.md](architecture.md#right-sidebar-boundary-directory-backed-vs-workspace-owned) for the full table.

- **Directory-backed** (shared by same-`cwd` workspaces): keyed by `(serverId, cwd)`. Git status/diff, GitHub PR status, PR timeline, file preview content. These are TanStack Query caches, not persisted stores.
- **Workspace-owned** (independent per workspace): keyed by `workspaceId`, with `cwd` used only as a fallback when no `workspaceId` is present. Review draft comments (`@jagentdesk:review-draft-store`), diff-mode overrides (in-memory), workspace composer attachments, and file-explorer nav/expand state. The `workspaceId` part of these keys is **opaque** — never parse it back into a path.

### Offline replica

Host directories (agents, workspaces, projects) and per-agent chats use row storage: SQLite on
native and IndexedDB on web (`packages/app/src/runtime/replica-cache/`). Directory demand and
viewed timelines restore through their owning runtime, so opening one chat never waits for all
saved hosts or unrelated streaming agents. Each chat keeps its latest 50 canonical items. The
whole cache has a 32 MiB budget and evicts whole hosts in least-recently-written order.

The cache is disposable; provider history remains authoritative. Changing its schema evicts
cached rows rather than migrating them. Pending permission requests and unreconciled local
prompts are never stored. The rows are not encrypted, so cached chats may contain source code,
prompts, and tool output. Agent snapshots retain cumulative usage for Insights independently of
timeline retention. [timeline-sync.md](timeline-sync.md#client-replica-lifetime) covers how a
restored chat reconciles with the daemon.

### Draft Store

**AsyncStorage key:** `jagentdesk-drafts` (version `DRAFT_STORE_VERSION` in `packages/app/src/stores/draft-store/state.ts`)

Composer drafts keyed by draft scope, each with a lifecycle (`active`, `abandoned`, `sent`) and an
optimistic-concurrency version.

### Attachment Store (Web)

**IndexedDB database:** `jagentdesk-attachment-bytes`, object store: `attachments`

Stores binary attachment blobs keyed by attachment ID.

### AttachmentMetadata

| Field         | Type      | Description                    |
| ------------- | --------- | ------------------------------ |
| `id`          | `string`  | Unique attachment ID           |
| `mimeType`    | `string`  | MIME type                      |
| `storageType` | `string`  | Storage backend identifier     |
| `storageKey`  | `string`  | Key within the storage backend |
| `createdAt`   | `number`  | Epoch ms                       |
| `fileName`    | `string?` | Original filename              |
| `byteSize`    | `number?` | Size in bytes                  |
