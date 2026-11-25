# Architecture

JAgentDesk is a client-server system for monitoring and controlling local AI coding agents. The daemon runs on your machine, manages agent processes, and streams their output in real time over WebSocket. Clients (mobile app, CLI, desktop app) connect to the daemon to observe and interact with agents.

Your code never leaves your machine. JAgentDesk is local-first.

## System overview

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Mobile App  │    │     CLI     │    │ Desktop App │
│   (Expo)     │    │ (Commander) │    │ (Electron)  │
└──────┬───────┘    └──────┬──────┘    └──────┬──────┘
       │                   │                  │
       │    WebSocket      │    WebSocket     │    Managed subprocess
       │  (direct, tailnet │    (direct)      │    + WebSocket
       │   or relay)       │                  │
       └───────────┬───────┴──────────────────┘
                   │
            ┌──────▼──────┐       ┌──────────────────┐
            │   Daemon    │◄─────►│ Connected daemons │
            │  (Node.js)  │       └──────────────────┘
            └──────┬──────┘
                   │
      ┌────────────┼────────────┬────────────┬────────────┐
      │            │            │            │            │
┌─────▼─────┐ ┌───▼────┐ ┌──────▼─────┐ ┌────▼─────┐ ┌────▼────┐
│  Claude   │ │ Codex  │ │  Copilot   │ │ OpenCode │ │ Pi/OMP  │
│  Agent    │ │ Agent  │ │   Agent    │ │  Agent   │ │ Agent   │
│  SDK      │ │ Server │ │    ACP     │ │          │ │         │
└───────────┘ └────────┘ └────────────┘ └──────────┘ └─────────┘
```

## Components at a glance

- **Daemon:** Local server that spawns and manages agent processes and exposes the WebSocket API.
- **App:** Cross-platform Expo client for iOS, Android, web, and the shared UI used by desktop.
- **CLI:** Terminal interface for agent workflows that can also start and manage the daemon.
- **Desktop app:** Electron wrapper around the web app that bundles and auto-manages its own daemon.
- **Relay:** Cloudflare Worker that forwards end-to-end encrypted frames between apps and daemons.
- **Built-in plugins:** Features under `plugins/<id>/` that load into the daemon and app hosts.

## Packages

### `packages/server` — The daemon

The heart of JAgentDesk. A Node.js process that:

- Listens for WebSocket connections from clients
- Manages agent lifecycle (create, run, stop, resume, archive)
- Streams agent output in real time via a timeline model
- Provides agent-to-agent tools through a transport-neutral tool catalog, with MCP as one adapter
- Optionally connects to a Tailscale (tsnet) tailnet and to the encrypted relay for remote access
- Optionally links to other daemons as [connected hosts](connected-hosts.md)
- Optionally serves the browser web client from the same HTTP server (self-hosting guide: [public-docs/web-ui.md](../public-docs/web-ui.md))

All paths are under `packages/server/src/`.

Project identity is daemon-global rather than session-owned. After registry bootstrap, the daemon's
project Git observer keeps one non-recursive watch on each lexically equivalent active project root
and listens only for the root `.git` entry, with a slow rescan as a missed-event fallback. It runs
for empty projects and without connected clients, then fans metadata changes through the WebSocket
server to capability-aware sessions. It deliberately does not use the broad recursive working-tree
watcher or the per-session Git observer: those are checkout/status mechanisms and intentionally do
not retain non-Git directories.

**Key modules:**

| Module                          | Responsibility                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------- |
| `server/bootstrap.ts`           | Daemon initialization: HTTP server, WS server, agent manager, storage, tsnet    |
| `server/websocket-server.ts`    | WebSocket connection management, hello handshake, pairing, binary frame routing |
| `server/session.ts`             | Per-client session state, timeline subscriptions, terminal operations           |
| `server/agent/agent-manager.ts` | Agent lifecycle state machine, timeline tracking, subscriber management         |
| `server/agent/agent-storage.ts` | File-backed JSON persistence at `$JAGENTDESK_HOME/agents/`                      |
| `server/agent/tools/`           | Transport-neutral catalog for hosts, workspaces, agents, and automation         |
| `server/agent/mcp-server.ts`    | Thin MCP adapter that registers the JAgentDesk tool catalog with the MCP SDK    |
| `server/agent/providers/`       | Provider adapters (see "Agent providers" below)                                 |
| `server/authorization/`         | Semantic permissions per session ([permissions.md](permissions.md))             |
| `server/pairing/`               | SAS device pairing, signed hello, paired-device store                           |
| `server/tsnet-listener.ts`      | Tailnet (tsnet) listener for remote access                                      |
| `server/relay-runtime.ts`       | Encrypted relay control and data sockets ([relay.md](relay.md))                 |
| `server/connected-hosts/`       | Daemon-to-daemon links and routed sessions                                      |
| `server/plugins/builtin/`       | `BuiltinServerHost` that registers built-in feature plugins                     |
| `server/bots/`                  | Bots runtime and SQLite store ([bots.md](bots.md))                              |
| `server/orchestration/`         | Task Brief compiler, role-scoped topology enforcement, handback/dissent state   |
| `server/schedule/`              | Cron-based scheduled agents                                                     |
| `server/loop-service.ts`        | Looping agent runs that retry until an exit condition                           |
| `server/chat/`                  | Chat rooms for agent-to-agent and human-to-agent messaging                      |
| `terminal/`                     | Terminal sessions backed by the persistent terminal worker                      |

### `packages/protocol` — Wire schemas and shared protocol types

The source of truth for WebSocket messages, binary frame codecs, endpoint parsing,
agent timeline types, provider config schemas, and other values shared by daemon
and clients. Server, app, CLI, and `@jagentdesk/client` all depend on this package;
it does not depend on the server.

### `packages/client` — Daemon client library and SDK facade

Owns the low-level daemon WebSocket driver plus the higher-level `JAgentDeskClient`
facade. App and CLI may import the low-level driver from
`@jagentdesk/client/internal/daemon-client` during migration, while new SDK-shaped
code imports from `@jagentdesk/client`.

### `packages/app` — Mobile + web client (Expo)

Cross-platform React Native app that connects to one or more daemons.

- Expo Router navigation (`/h/[serverId]/workspace/[workspaceId]`, `/h/[serverId]/agent/[agentId]`, etc.). The `workspaceId` URL segment is an opaque workspace id, not a directly meaningful filesystem path.
- The desktop shell is one Gumloop sidebar (`components/gumloop-shell/`); compact layouts use a drawer. See [themes.md](themes.md).
- `HostRuntimeController` manages saved host connections, route selection, reconnection, and per-host runtime state
- `runtime/replica-cache` restores a disposable display replica before the host connects. See [data-model.md](data-model.md#offline-replica).
- `SessionContext` wraps the daemon client for the active session
- `plugins/builtin/` holds `BuiltinClientHost`, which mounts built-in feature plugins
- Composer UI and submit/draft behavior live in `packages/app/src/composer/`; screens and panels should integrate it from there instead of dropping composer internals into `components/`, `hooks/`, or `screens/workspace/`
- Timeline reducers in `timeline/session-stream-reducers.ts` handle compaction, gap detection, sequence-based deduplication
- Timeline sync correctness is documented in [timeline-sync.md](timeline-sync.md): live streams are for immediacy, `fetch_agent_timeline_request` is authoritative, and catch-up is paged but complete.
- Voice features: dictation (STT) and voice agent (realtime)

The replica cache paints stale data while the host connects. It does not own mutations, infer
deletions, or replace daemon reconciliation. Pending permission requests are not restored from it.

### `packages/cli` — Command-line client

Commander.js CLI with Docker-style commands. Common agent operations are also exposed at the top level (e.g. `jagentdesk ls`, `jagentdesk run`).

- `jagentdesk agent ls/run/import/attach/logs/stop/delete/send/inspect/wait/archive/detach/open/reload/update/mode`
- `jagentdesk daemon start/stop/restart/status/pair/set-password`
- `jagentdesk host add/ls/inspect/update/enable/disable/rm` ([connected-hosts.md](connected-hosts.md))
- `jagentdesk relay reset` ([relay.md](relay.md))
- `jagentdesk chat ls/create/inspect/post/read/wait/delete`
- `jagentdesk terminal ls/create/capture/send-keys/kill`
- `jagentdesk script ls/start/stop`
- `jagentdesk loop run/ls/inspect/logs/stop`
- `jagentdesk schedule create/ls/inspect/update/pause/resume/run-once/logs/delete`
- `jagentdesk heartbeat create/update/delete`
- `jagentdesk workspace create/ls/rename/archive`
- `jagentdesk permit allow/deny/ls`
- `jagentdesk provider ls/models`
- `jagentdesk plugin init/install/ls/status/logs/update/remove`
- `jagentdesk usage ls/inspect`
- `jagentdesk hub connect/disconnect/status`
- hidden legacy `jagentdesk worktree create/ls/archive` compatibility alias
- `jagentdesk speech …`

Communicates with the daemon via the same WebSocket protocol as the app.

### `packages/relay` — Encrypted relay

Cloudflare Worker with a Durable Object per daemon. It forwards Noise-encrypted frames and never
holds daemon or device private keys. The daemon accepts tailnet connections through embedded tsnet
and keeps the relay as a second path. Both paths use the same device pairing and signed-hello
admission. See [relay.md](relay.md) for configuration, identity storage, and transport boundaries,
and [SECURITY.md](../SECURITY.md) for the threat model.

### `plugins/` — Built-in feature plugins

Each feature lives in `plugins/<id>/` with a `jagentdesk-plugin.json` manifest plus `server/` and
`client/` entrypoints. `BuiltinServerHost` (`packages/server/src/server/plugins/builtin/host.ts`)
and `BuiltinClientHost` (`packages/app/src/plugins/builtin/host.ts`) wire them in. The same
directory holds bundled provider plugins and usage-source plugins. See
[builtin-plugins.md](builtin-plugins.md) and [plugins.md](plugins.md).

### `packages/desktop` — Desktop app (Electron)

Electron wrapper for macOS, Linux, and Windows.

- Can spawn the daemon as a managed subprocess
- Native file access for workspace integration
- Same WebSocket client as mobile app

**Multi-window (hybrid land-on model).** `createWindow()` in `main.ts` is reusable: `⌘⇧N`/File→New Window, relaunching the app (`second-instance`), and the sidebar "Open in new window" action each open a fresh `BrowserWindow`. Every window shows the full sidebar — there is no per-window project ownership or filtering. "Land on a project" is delivered by a per-`webContents` `PendingOpenProjectStore`: each window pulls its own pending project path on mount (`jagentdesk:get-pending-open-project`) and runs the normal open-project flow, identical to a CLI `jagentdesk <path>` launch.

> **Window-state v1 limitation:** only the _first_ window of a session restores and persists saved geometry (size/position/maximized). Windows opened via ⌘⇧N / second-instance / "Open in new window" open at the default size, OS-cascaded, and do not persist — this avoids every window stacking on the same restored bounds and fighting over the single window-state store. Lifting this needs per-window state keys.
>
> **In-app browser profile.** Every browser guest uses one stable persistent Electron session, so cookies, authentication, cache, and site storage are shared across tabs, workspaces, and desktop windows and survive tab or app closure. Browser identity is independent of that storage partition: after every `did-attach`, the renderer explicitly registers its browser id, workspace id, and current guest `WebContents` id, and main accepts the registration only when that guest belongs to the calling renderer and the shared profile. Registration is intentionally repeated because reparenting a retained `<webview>` can replace its guest without replacing the DOM element. Settings > General > Clear browser data is the sole profile-deletion path; it clears the shared session and reloads live guests without deleting saved tabs or URLs.
>
> **In-app browser window opens.** Ordinary link opens, including Shift-clicked links, become JAgentDesk workspace tabs. Script-created opens with popup features or a named window target and POST-backed opens remain secured Electron child windows in the shared browser profile, preserving `window.opener`, `postMessage`, named-window reuse, request bodies, and `window.close()` for OAuth, payment, and similar popup protocols. Unsupported URL schemes are denied before either path.
>
> **In-app browser ownership.** Each registered guest records its owning host window. The active browser is keyed by `(host window, workspace)`, and application-menu Reload / Force Reload resolve only within the window Electron supplies to the menu callback. A non-null active update must name a browser owned by that host; a null update clears only that host/workspace. Browser automation continues to target explicit browser ids returned by `browser_new_tab` or `browser_list_tabs`. Agent browser identity and dialogs are covered in [agentic-browser.md](agentic-browser.md).
>
> **Browser keyboard boundary.** Guest pages receive renderer-published shortcuts first. `Cmd/Ctrl+L` and `Cmd/Ctrl+R` are explicit guest-shell reservations; ordinary JAgentDesk shortcuts run only after the page declines them. The sandboxed guest preload runs in every frame so focused iframes use the same boundary, while Node integration remains disabled. Human guest input disables Electron's menu fallback for plain keys. Agent-generated keys use guest `sendInputEvent` with `skipIfUnhandled`, so an unhandled Enter stops at the guest instead of reaching the host composer. Main selects the preload; it exposes no APIs to guest pages.

```text
Human key -> guest WebContents
  |-- Cmd/Ctrl+T/L/R ----------> reserved browser-shell action
  `-- page keydown
        |-- page prevents ------> page owns it
        `-- published shortcut -> guest preload -> IPC(browserId) -> JAgentDesk resolver

Agent browser_keypress -> guest sendInputEvent(skipIfUnhandled)
  |-- guest handles ------------> page owns it
  `-- guest does not handle ----> stop; never redispatch to the host window
```

### `packages/website` — Marketing site

TanStack Start + Cloudflare Workers. Serves localhost:8082.

## WebSocket protocol

All clients speak the same WebSocket protocol over a single connection that mixes JSON text frames and a small binary framing for terminal streams. Schemas live in `packages/protocol/src/messages.ts`.

**Handshake:**

```
Client → Server:  WSHelloMessage {
                    type: "hello",
                    clientId,
                    clientType: "mobile" | "browser" | "cli" | "mcp",
                    protocolVersion,
                    appVersion?,
                    capabilities?: { voice?, pushNotifications?, ... },
                  }
Server → Client:  status message with payload { status: "server_info",
                    serverId, hostname, version, capabilities?, features }
```

Paired devices answer a daemon challenge with a signed hello before the session opens. Routed
hellos from a [connected host](connected-hosts.md) also carry `routed`, `producer`, and
`sessionPermissions`; the daemon overwrites them with the admitted caller's values.

There is no dedicated welcome message; the server emits a `status` session message after accepting the hello, then begins streaming. The session stores client capabilities from the hello and rehydrates them on reconnect, so the wire boundary can ask one question: `session.supports(...)`.

**Top-level WS envelopes** are `hello`, `recording_state`, `ping`/`pong`, and `session` (which wraps the rich union of session messages).

Client liveness checks use the top-level JSON `ping`/`pong` envelope, not a session RPC or RFC6455 control ping. Current clients ping every 10 seconds, beginning one interval after connecting. The first ping claims a 45-second application-ownership lease for that physical socket, all later inbound activity renews it, and the daemon forcibly terminates the socket if the lease expires. A legacy or raw socket that never sends an application ping never enters this lease and is not closed for omitting one. Session RPC timeouts are operation failures and must not be treated as proof that the socket is dead.

Every physical send path enforces a 64 MiB outbound buffer limit (`packages/server/src/server/websocket/physical-socket.ts`), including JSON broadcasts, binary terminal frames, and the encrypted relay socket. It is an out-of-memory backstop for a client that stopped draining, well above the terminal stream's 4 MiB soft backpressure threshold. JSON is serialized once per broadcast after sockets already at the limit are removed, then its exact byte length is checked for every remaining socket. A frame that would cross the limit is not sent; that physical socket is forcibly terminated without disturbing other sockets attached to the same logical session. Multiple tabs and simultaneous direct and remote paths may legitimately share a client id.

Client session RPC waits default to 60s so slow or mobile networks do not turn a live but delayed daemon response into a false operation failure. Keep connect timeouts, app-level grace windows, explicit diagnostic latency probes, liveness ping timers, and genuinely long-running RPCs separate from this default.

New session RPCs use dotted names with `.request` and `.response` suffixes, such as `checkout.forge.set_auto_merge.request` and `checkout.forge.set_auto_merge.response`. See [rpc-namespacing.md](rpc-namespacing.md) for the convention and migration rules for older flat RPC names.

The Supervisor–Lead–Peer control plane is documented in [orchestration.md](orchestration.md).

**Notable session message types:**

- `agent_update` — Agent state changed (status, title, labels)
- `agent_stream` — New timeline event from a running agent
- `workspace_update`, `script_status_update`, `workspace_setup_progress` — Workspace state
- `agent_permission_request` / `agent_permission_resolved` — Tool-call permission flow
- `agent_deleted`, `agent_archived`, `agent_status`, `agent_list`
- `checkout_status_update`, `checkout_diff_update`, and the full `checkout_*` request/response set for git operations
- Terminal subscribe/input/capture commands
- Voice/dictation streaming events (`dictation_stream_*`, `assistant_chunk`, `audio_output`, `transcription_result`)
- Request/response pairs for fetch, list, create, etc., correlated by `requestId`; failures use `rpc_error`

Agent snapshots optionally carry the daemon-owned active turn identity, and turn lifecycle stream events
optionally carry the same `turnId`. New clients use these fields when present and normalize an old daemon's
status once at the directory boundary rather than maintaining a second activity model.

`directory_suggestions_request` is one daemon-owned filesystem search capability. The daemon
configures the same `searchDirectoryEntries` engine with a root, output format, path-query policy,
entry-kind filters, match mode, blank-query behavior, and hidden-directory traversal policy. A
request without `cwd` searches the host home for absolute project paths; a request with `cwd`
searches that workspace and returns relative entries. Clients may prepend their small host-scoped
recent-project list for bare queries, but must not parse filesystem query syntax or re-filter a
correlated daemon response. The legacy `directories` response field remains a projection of the
typed `entries` list.

**Binary frames (terminal stream protocol):**

Terminal I/O is sent as binary WebSocket frames decoded by `decodeTerminalStreamFrame` in `packages/protocol/src/binary-frames/terminal.ts`. The layout is:

- 1-byte opcode: `Output (0x01)`, `Input (0x02)`, `Resize (0x03)`, `Snapshot (0x04)`, `Restore (0x05)`, `ReplayBegin (0x06)`, `ReplayData (0x07)`, `ReplayEnd (0x08)`
- 1-byte slot: terminal slot id
- variable payload: bytes for output/input, JSON-encoded `{ rows, cols }` for resize, ANSI bytes for restore and replay

The daemon no longer sends `Snapshot`. Reattach replays ANSI history through `Restore` or the chunked replay frames; see [terminal-worker.md](terminal-worker.md) and [protocol-compatibility.md](protocol-compatibility.md#terminal-ansi-replay).

Terminal PTY size is last-interacting-client-wins. A client claims the PTY size only when its terminal viewport genuinely changes size or the user focuses/taps the terminal. Passive rendering work — attaching, restoring visibility, font settling, renderer refits, or looking at a visible terminal — must not send a resize frame. The server does not broadcast resize ownership; the resized PTY redraws through normal output, and every attached client renders that output in its own local viewport.

There is also a separate file-transfer binary frame format in the same directory, used for download/upload streams.
File downloads keep the existing `FileBegin`/`FileChunk`/`FileEnd` framing and stream 256 KiB chunks
from one stable file handle. Each transfer awaits completion of its own physical WebSocket send before
reading the next chunk; it is scoped to the requesting physical socket and does not queue unrelated
messages or transfers.

### Compatibility rules

App and daemon versions drift in the wild. Wire schemas stay append-only and new features gate on
`server_info.features`. New wire enum values are gated at serialization with
`session.supports(CLIENT_CAPS.someCapability)`. The full contract is in
[protocol-compatibility.md](protocol-compatibility.md).

## Agent lifecycle

States (`initializing`, `idle`, `running`, `error`, `closed`) are defined in
`packages/protocol/src/agent-lifecycle.ts`. [agent-lifecycle.md](agent-lifecycle.md) owns their
meaning, restart recovery, idle runtime release, agent messages, and archive.

- **AgentManager** is the source of truth for agent state and broadcasts updates to all subscribers
- Timeline sequence allocation is append-only with epochs (each run starts a new epoch). The one
  permitted in-place enrichment adds a provider message id to the manager-owned row for an accepted
  prompt; it preserves the row's sequence, content, and timestamp. Clients dedupe by sequence number;
  the default fetch page is 200 items.
- Timeline row `timestamp` values are canonical daemon-owned timestamps. Providers may supply original replay timestamps, but clients must not guess timestamp trust or hide time UI based on local clock heuristics.
- Events stream to connected clients in real time; correctness is backed by authoritative timeline fetches and paged-to-completion catch-up.
- Agent records persist to `$JAGENTDESK_HOME/agents/{cwd-with-dashes}/{agent-id}.json`. That storage path is derived from `cwd`, not from workspace id. The daemon keeps projected timeline items in memory; provider history is the durable transcript and rebuilds them on resume.

## Right-sidebar boundary: directory-backed vs workspace-owned

Two workspaces can share the same `cwd` (e.g. a `directory` workspace and a `local_checkout` workspace on the same folder, or several workspaces opened against one checkout). Model B keeps these distinct: they share everything the directory determines, but nothing the workspace owns. The right-sidebar surfaces split cleanly along this line, and the split is enforced purely by **what each piece of state is keyed by**.

**Directory-backed (shared by same-`cwd` workspaces) — keyed by `(serverId, cwd)`, never by `workspaceId`:**

| Surface                 | Key                                                      | Source                                                  |
| ----------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| Git status              | `checkoutStatusQueryKey(serverId, cwd)`                  | `packages/app/src/git/query-keys.ts`                    |
| Git diff                | `checkoutDiffQueryKey(serverId, cwd, mode, baseRef, ws)` | `packages/app/src/git/query-keys.ts`                    |
| Forge change request    | `checkoutPrStatusQueryKey(serverId, cwd)`                | `packages/app/src/git/query-keys.ts`                    |
| Change request timeline | `prPaneTimelineQueryKey({ serverId, cwd, prNumber })`    | `packages/app/src/git/pull-request-panel/query-keys.ts` |
| File preview content    | `FileTarget { cwd, path }` on the host's client          | `packages/app/src/file-panels/file/hook.ts`             |
| File explorer listings  | fetched via `listDirectory(workspaceRoot, path)`         | `packages/app/src/hooks/use-file-explorer-actions.ts`   |

**Workspace-owned (independent per workspace) — keyed by `workspaceId` (falling back to `cwd` only when no `workspaceId` exists):**

| State                        | Key builder / store                                | Source                                                        |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Review draft comments        | `buildReviewDraftKey` / `buildReviewDraftScopeKey` | `packages/app/src/review/store.ts`                            |
| Diff mode override           | review-draft scope key (in-memory)                 | `packages/app/src/review/state.ts`                            |
| Composer attachments         | `buildWorkspaceAttachmentScopeKey`                 | `packages/app/src/attachments/workspace-attachments-store.ts` |
| File explorer nav/open state | `fileExplorer` map keyed `workspace:{workspaceId}` | `packages/app/src/hooks/use-file-explorer-actions.ts`         |
| File explorer expanded paths | `expandedPathsByWorkspace[workspaceStateKey]`      | `packages/app/src/stores/panel-store/state.ts`                |

**Do not "fix" the sharing away.** Re-keying a directory-backed query by `workspaceId` makes same-`cwd` workspaces diverge (two windows onto the same git tree showing different diffs). Re-keying owned state (drafts, expanded paths) by `cwd` makes them leak between distinct workspaces on the same folder. The `workspaceId`-keyed builders carry a `// workspaceId is opaque; do not parse this key back into a path.` comment — the opaque-id fallback to `cwd` exists only for old payloads without a `workspaceId`, not as a content-sharing mechanism.

One deliberate non-violation: `AgentFileExplorerState.directories`/`files` cache directory listings inside the `workspaceId`-keyed explorer map. Same-`cwd` workspaces therefore keep duplicate caches, but they can never diverge — both fetch the identical directory via `listDirectory(workspaceRoot, …)`. This is duplication, not leakage, and is left as-is.

## Agent providers

Each provider implements the `AgentClient` interface in `agent/agent-sdk-types.ts`. Provider implementations live in `agent/providers/`.

The built-in, user-facing providers are Claude Code, Codex, Copilot, OpenCode, Pi, and OMP. Additional adapters exist in the same directory for ACP-compatible agents and internal use:

| Provider           | Wraps                                | Session format                                     |
| ------------------ | ------------------------------------ | -------------------------------------------------- |
| Claude (`claude/`) | Anthropic Agent SDK                  | `~/.claude/projects/{cwd}/{session-id}.jsonl`      |
| Codex              | Codex AppServer (`codex-app-server`) | `~/.codex/sessions/{date}/rollout-{ts}-{id}.jsonl` |
| Copilot            | GitHub Copilot via ACP               | Provider-managed                                   |
| OpenCode           | OpenCode server `/global/event`      | Provider-managed                                   |
| Pi (`pi/`)         | Local Pi RPC process                 | Provider-managed                                   |
| OMP (`omp/`)       | Local OMP RPC process                | Provider-managed                                   |
| Cursor, Kimi, Kiro | ACP wrappers                         | Provider-managed                                   |
| Generic ACP        | ACP wrapper                          | Provider-managed                                   |
| Mock load test     | In-process fake                      | In-memory                                          |

More providers ship as bundled provider plugins in `plugins/*-provider/`. See [providers.md](providers.md) and [custom-providers.md](custom-providers.md).

All providers:

- Handle their own authentication (JAgentDesk does not manage API keys)
- Support session resume via persistence handles
- Map tool calls to a normalized `ToolCallDetail` type
- Expose provider-specific modes (plan, default, full-access)

Providers that can accept native tool definitions should set `supportsNativeJAgentDeskTools` and read `launchContext.jagentdeskTools`. The daemon then passes the shared JAgentDesk tool catalog directly and removes the internal JAgentDesk MCP server from that provider launch config. Providers that only support MCP continue to receive the same tools through the MCP fallback at `/mcp/agents`.

## Data flow: running an agent

1. Client sends `CreateAgentRequestMessage` with config (prompt, cwd, provider, model, mode)
2. Session routes to `AgentManager.create()`
3. AgentManager creates a `ManagedAgent`, initializes provider session
4. Provider runs the agent → emits `AgentStreamEvent` items
5. Events append to the agent timeline, broadcast to all subscribed clients
6. Tool calls are normalized to `ToolCallDetail` (shell, read, edit, write, search, etc.)
7. Permission requests flow: agent → server → client → user decision → server → agent

## Storage

`$JAGENTDESK_HOME` defaults to `~/.jagentdesk`. [data-model.md](data-model.md) owns the directory
layout and every store.

## Deployment models

1. **Local daemon** (default): `jagentdesk daemon start` on `127.0.0.1:6767`
2. **Managed desktop**: Electron app spawns daemon as subprocess, and stops it again on quit so that "restart the app" is a complete reset. Settings > Host > "Keep daemon running after quit" opts out. Only a daemon the desktop started is stopped — a daemon you started yourself with `jagentdesk daemon start` is left alone (`jagentdesk.pid` records `desktopManaged`).
3. **Remote (Tailscale)**: Daemon behind a firewall, reachable over a tailnet via embedded tsnet
4. **Remote (relay)**: Daemon reachable through the encrypted relay without a tailnet ([relay.md](relay.md))
5. **Docker**: Daemon and bundled web UI in a container ([docker.md](docker.md))
