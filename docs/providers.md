# Providers

A provider is an agent backend: the daemon spawns its CLI or runtime, maps its events onto the JAgentDesk timeline, and answers catalog, permission and history requests for it. This doc covers adding a provider and the contracts every provider adapter must keep. To configure profiles, endpoints or ACP agents without code, see [custom-providers.md](custom-providers.md).

## Where providers come from

| Source                     | Providers                                                                                | Code                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Built-in, direct           | `claude`, `codex`, `opencode`, `pi`, `omp` (OMP is disabled by default)                  | `packages/server/src/server/agent/providers/`                          |
| Built-in, ACP              | `copilot`                                                                                | `providers/copilot-acp-agent.ts`                                       |
| Bundled provider plugins   | Muse Code, Antigravity, Hermes (enabled by default); Hoplite, fx, goose (off by default) | `plugins/<id>-provider/`                                               |
| Config-defined (`extends`) | Profiles of a built-in provider, generic ACP agents, custom API providers                | [custom-providers.md](custom-providers.md)                             |
| Development only           | `mock`, `mock-slow` (listed only with `JAGENTDESK_NODE_ENV=development`)                 | `providers/mock-load-test-agent.ts`, `providers/mock-slow-provider.ts` |

An `extends: "acp"` entry whose ID is `cursor`, `kimi`, `kiro` or `traecli` gets a dedicated ACP client (`providers/<name>-acp-agent.ts`) instead of `GenericACPAgentClient`. The in-app ACP catalog (`packages/app/src/data/acp-provider-catalog.ts`) writes those entries.

## Choosing an integration

- **Provider plugin.** Use this for an agent that speaks ACP or that you want to ship outside core. The plugin calls `server.registerProvider(...)`; ACP agents pass `runAcpProvider({ id, label, command, ... })` from `@jagentdesk/plugin/server/acp` (see `plugins/goose-provider/server/provider.ts`). Bundled provider plugins appear in Settings → host → Plugins → Built-in with per-host switches, and a missing CLI shows its unavailable reason there. A registration with `requiresConfiguration: true` activates only while `agents.providers` contains its ID. Hermes is on by default for that reason: it does nothing until `agents.providers.hermes` exists. An `extends: "acp"` entry for goose or Hermes migrates to the bundled provider on load and keeps a custom command; Hermes agents saved by the generic adapter resume with their mode translated (`plugins/hermes-provider/server/legacy-modes.ts`). The ACP shim builds the standard row for each ACP tool `kind` (`packages/plugin/src/server/acp-internal/tool-call-detail.ts`). A `toolCall` transformer sees the raw `input`, `output` and `content`, and a `detail` it sets replaces the standard row. Parse vendor display text defensively and return the call unchanged when the shape does not match (`plugins/hermes-provider/server/terminal-command.ts`). Plugin runtime behavior is in [plugins.md](plugins.md#runtime-contracts).
- **Built-in ACP.** Subclass `ACPAgentClient` (`providers/acp-agent.ts`). The base class owns process spawning, stdio transport, session lifecycle, streaming, permissions and catalog discovery. You supply `provider`, `defaultCommand`, `defaultModes` and `capabilities`, and override `isAvailable()` only to add credential checks.
- **Direct.** Implement `AgentClient` and `AgentSession` from `packages/server/src/server/agent/agent-sdk-types.ts`. You own process management, streaming, permissions and persistence.

## Adding a built-in provider

1. Create the client in `packages/server/src/server/agent/providers/`. Read `agent-sdk-types.ts` for the full `AgentClient` / `AgentSession` contract; required members are `createSession`, `resumeSession`, `fetchCatalog` and `isAvailable` on the client, and `startTurn`, `subscribe`, `streamHistory`, `describePersistence`, permissions, modes, `interrupt` and `close` on the session.
2. Add the definition to `AGENT_PROVIDER_DEFINITIONS` in `packages/protocol/src/provider-manifest.ts`, with modes that carry `icon` and `colorTier` (`safe`, `moderate`, `dangerous`, `planning`, or a `#hex` color). Mark the provider's no-prompt mode with `isUnattended`. Set `enabledByDefault: false` to ship it off.
3. Add the ID to `BUILTIN_PROVIDER_IDS` in `packages/protocol/src/provider-config.ts`, which validates `extends` values. This list is separate from the manifest.
4. Add a factory to `PROVIDER_CLIENT_FACTORIES` in `packages/server/src/server/agent/provider-registry.ts`. Factories receive `(logger, runtimeSettings, options)`; the registry already resolves the provider's runtime settings slice.
5. Register an icon in `BUILTIN_PROVIDER_ICONS` (`packages/app/src/components/provider-icons.ts`). Unknown providers fall back to catalog SVGs and then a generic icon.
6. Add an entry to `agentConfigs` and `allProviders` in `packages/server/src/server/daemon-e2e/agent-configs.ts`, with a `full` (no prompts) and an `ask` mode.

Try it with the CLI against the dev daemon:

```bash
npm run cli -- provider ls
npm run cli -- provider models my-provider --thinking
npm run cli -- run --provider my-provider/some-model --mode default "Say hello"
```

## Adapter contracts

### Tools

JAgentDesk tools live in a shared catalog under `packages/server/src/server/agent/tools/`; MCP is only the fallback adapter. A provider that can register runtime tools sets `supportsNativeJAgentDeskTools: true` and consumes `launchContext.jagentdeskTools` in `createSession` / `resumeSession`. `AgentManager` then strips the internal MCP server from the launch config so tools do not arrive twice. Providers that only speak MCP keep `supportsMcpServers: true` and get `/mcp/agents` injected.

Exact MCP preapproval is a separate daemon-owned contract. A provider must fail closed for Hub unattended execution until it can approve one exact injected MCP server and tool identity without approving native tools.

### Provider options

The provider validates and applies `AgentSessionConfig.providerOptions`; the registry supplies the effective options at session startup. Defaults and merge rules are in [custom-providers.md](custom-providers.md#provider-options).

### Catalog and snapshots

`fetchCatalog` is the single discovery API for models and modes. Callers outside the provider never probe models and modes separately. A catalog with `incomplete: true` omits models the provider could not confirm.

The daemon keeps provider snapshots per resolved cwd, plus a semantic global scope for settings and requests without a cwd. Probes receive `{ scope: "global", force }` or `{ scope: "workspace", cwd, force }`. Providers decide what global means; never infer it by comparing a cwd to the home directory.

What re-probes a provider:

- **A cold read** of a scope.
- **The background schedule.** Enabled providers refresh about every 30 minutes (`PROVIDER_BACKGROUND_REFRESH_INTERVAL_MS`), one provider per slot, across the global scope and every cached cwd. A failed, unavailable or incomplete background probe keeps a ready catalog. Background refresh is soft, so OpenCode keeps its shared server. A manual refresh pushes that provider's next slot back. Shutdown cancels the schedule and aborts running probes.
- **An explicit workspace refresh**, which affects one cwd.
- **Settings refresh**, which clears every scope and in-flight load, then force-refreshes only the global scope. Workspace scopes re-probe lazily on their next read.
- **A config change to that provider** (a custom provider save, a daemon config patch, a changed base it extends). `stageMutableProviderConfig` diffs each provider's override, runtime settings and enabled state; only the changed providers get a new client and go back to loading. Every other provider keeps its client, entries and in-flight loads. Rebuilding every client on each save leaked one owned `opencode serve` per edit and re-ran Claude model discovery in every cached cwd. A replaced client gets `retire()`: OpenCode v2 stops its idle owned server, and one still serving sessions stops when the last session releases it.

A custom API provider's refresh asks its models endpoint first (`checkApiProviderEndpoint`), before any provider process starts. A refusal (401, 403, 429, unreachable) puts it in `error`, and the background schedule skips it until its config changes or someone refreshes it. Concurrent refreshes of one provider share one endpoint check, and Claude shares one model-discovery process across cwds.

A refresh stops at its deadline (`JAGENTDESK_PROVIDER_REFRESH_TIMEOUT_MS`, default 120 s). A plugin provider's connection is shared with its running sessions, so the bridge cannot close it at the deadline; it sends `request.cancel` for the abandoned catalogue request instead, and the provider stops that request's work. The ACP shim stops the probe process it started for that request.

Do not add focus, selector-open or config-reload refreshes. Registry and config replacement may update label, description, default mode, enabled state and membership, but must not spawn provider processes for providers whose config did not change.

### Draft metadata

Avoid creating provider sessions for metadata. Prefer `fetchCatalog`, `listCommands` or `listControls` on the client: scratch sessions show up as empty native sessions in provider import and history UIs. Draft command and control listing require an explicit draft model; do not resolve a default model through catalog discovery.

### User messages and rewind

`AgentManager` owns the one canonical timeline row for a foreground prompt that carries a `clientMessageId`. It records the row when `startTurn` accepts, with the wire `messageId` equal to the `clientMessageId`. Adapters still emit their native user-message echo with that `clientMessageId`; the manager records the provider identity on the internal row without redispatching it. Adapters own externally initiated user rows, which have no client identity. Do not dedupe transcripts by text.

Rewind takes the canonical `messageId` and resolves it to the provider identity, so a prompt cannot be rewound until its provider echo arrives.

### Persistence

`describePersistence()` returns a handle only once a new provider process could resume it. Reload, idle runtime release and daemon restart resume the stored handle; an agent without one starts a new session. When there is no handle, `AgentManager` stores `getRuntimeInfo().sessionId` instead, so that ID follows the same rule. Codex, for example, writes its rollout only at the first turn, so its adapter reports neither ID before Codex announces that turn.

### Session import

The picker calls `listImportableSessions` and gets rows only: handle, cwd, title, prompt previews, last activity. Import calls `importSession({ providerHandleId, cwd })` for the chosen row and must not list again. The provider returns the resumed session, storage config, persistence handle and hydrated timeline; `AgentManager.importProviderSession` publishes the agent only after it is seeded.

### Notices

`setMode` and `setThinkingOption` may return an `AgentProviderNotice` when a change needs user-facing context, such as a change staged until the next turn. The app shows it as a generic toast.

### Session-scoped cancellation

Some providers cancel the whole session rather than one turn (OpenCode's `session.abort`). A cancel still in flight when the next run starts kills that run, which breaks "stop, then prompt again", `notifyOnFinish` wakes and schedules. Own this inside the provider session:

- Model the stop as an explicit `stopping` turn state carrying the canceled run's terminal and the cancellation the caller is owed. Pressing Stop again retries the stop in progress; never fire a detached retry.
- Scope the cancel settlement the way the provider scopes the cancel. For session-scoped cancels, track every request issued on the session and let it outlive the stop that issued it. Only the newest may hold the gate closed.
- Gate daemon-issued operations (prompt, slash command, summarize) on both the terminal and the cancel settlement. Keep permission and question responses outside the gate, or auto-approve deadlocks the stop. Runs the provider starts on its own (plugin or autonomous wakes) are observed, not gated.
- Fail closed: if the cancel never succeeded, refuse new runs until the next Stop issues a fresh cancel. `AgentManager` already turns a rejected `interrupt()` into a refused cancel.
- Suppress the canceled run's residue only until its authoritative terminal. Anything after that terminal is a new run and takes the normal live path.

### Helper processes

Record provider helper processes that can outlive a session in the daemon's managed-process registry: provider and kind, PID, launch command and args, and process identity from the platform process table. Remove the record on normal exit or shutdown. A helper with a readiness phase belongs to the provider's lifecycle model from `spawn`, before readiness succeeds, so startup timeout, startup exit and shutdown all clean it up.

Bootstrap reconciles the ledger in the background: dead PIDs are deleted, identity mismatches are deleted without killing anything, positively matched leftovers are terminated, and records that cannot be inspected wait for the next pass. Do not add process-name sweepers.

A provider session owns every process it spawns until `AgentManager` registers the session. If initialization, resume or initial history hydration fails, `connect()` disposes the process before rethrowing.

### Installation and updates

A client may expose `installation` with `installUrl`, `updateUrl`, `inspect`, `checkForUpdates` and `update` (plugin providers use `ProviderRegistration.installation`). The app reads them through `provider.installation.inspect`, `provider.installation.check_updates`, `provider.installation.update` and `provider.installation.update.subscribe`. Shared helpers for release lookups and updater commands are in `providers/release-check.ts` and `providers/update-command.ts`.

### Plan usage

Usage comes from bundled `*-usage-source` plugins. A source calls `server.registerUsageSource({ id, label, providers, input, discover, fetch })` (see `plugins/kimi-usage-source/index.server.ts`), and the app reads reports through `usage.list_reports.request`. Keep report shapes provider-agnostic: windows, balances and details render generically. `provider.usage.list.request` and `packages/server/src/services/quota-fetcher/` serve older clients only (`COMPAT(providerUsageList)`).

Claude's OAuth usage endpoint is undocumented. Extra-usage amounts are reported in minor currency
units and displayed only for USD; the balance contract does not represent other currencies.
Codex individual spending limits provide percentages, not dollar amounts.

## Provider notes

### Claude

First-party model metadata lives in `providers/claude/model-manifest.ts`. Thinking options and Claude feature gates derive from it, so update only the manifest when adding a model.

### ACP

- Mode IDs can be URIs (Copilot uses `https://agentclientprotocol.com/protocol/session-modes#agent`). The manifest `defaultModeId` must match exactly.
- Copilot custom agents arrive as a session config option with `id: "agent"` and `category: "_agent"`, mapped to the `agent` feature. The value is the agent's display name; blank means the default agent.
- Permission options render as ordered actions and JAgentDesk returns the chosen `optionId`. Agents can encode a single-choice question as several options of the same allow kind, so Auto Accept never resolves those requests.

### Pi

Pi is process-backed: JAgentDesk talks to the user's `pi` binary through `pi --mode rpc` and embeds no Pi SDK.

- System prompts go through the generated JAgentDesk Pi extension. Do not pass `--append-system-prompt`: it replaces Pi's `APPEND_SYSTEM.md` discovery.
- Send raw RPC `images` only when the model's `input` includes `"image"`. Text-only Pi and OMP models reject image content and persist the rejected image in history, so materialize the image to a file and pass a path hint.
- MCP servers reach Pi through its built-in MCP extension, or, when `pi-mcp-adapter` is loaded for the cwd (it registers an `mcp` command in `get_commands`), through a per-agent `--mcp-config` file. That flag replaces Pi's global layer, so copy the existing `<Pi agent dir>/mcp.json` into the generated file before adding servers, and set `auth: false`, `oauth: false` for local HTTP servers such as `/mcp/agents`.
- Import discovery reads Pi's JSONL session files because RPC has no session listing. Resume and history still go through RPC with the session file as `nativeHandle`.
- Extension UI dialogs (`select`, `input`, `editor`, `confirm`) become question permissions answered with `extension_ui_response`. For an `ask_user` call with `allowComment: true`, JAgentDesk shows selection and comment as one question and auto-answers the follow-up optional `input`. Keep placeholders and skip semantics so the app can tell "skip this input" from "cancel the dialog". Fire-and-forget UI requests are ignored.
- `providers/pi/extensions/` adapts known Pi extensions (subagents, ask-user, todo, MCP adapter) into timeline items, questions and provider subagents.

### OMP

OMP lives under `providers/omp/`; only the JSONL child-process transport is shared with Pi. It launches `omp --mode rpc-ui`, discovers commands with `get_available_commands`, bridges `rpc-ui` approval dialogs into permissions, and imports terminal-started sessions from `~/.omp/agent/sessions` when enabled.

- OMP registers the full caller-scoped JAgentDesk tool catalog natively. Serialize every host definition with `loadMode: "essential"`, or OMP mounts non-built-in names under `xd://` and `create_agent`, `send_agent_prompt` and `wait_for_agent` stop being direct calls.
- OMP task subagents surface as provider subagents (`providers/omp/subagent-index.ts`), not managed agents.
- Rewind is a branch: `branch` writes a new session file whose header names the previous file as `parentSession`, leaving the previous file and its recorded head untouched. Treat the file OMP selects as the authority, not the newest file or message. Import listings return a file path, so persist the resumed session's own `sessionId` with that path as `nativeHandle`.

### OpenCode

- V2 discovers tool definitions from each bound session's catalog. Keep session filtering and caller-scoped execution checks: registration is location-wide, and an allowlist cannot register a definition missing from the catalog.
- An agent's own MCP servers take one of two paths, decided once per OpenCode server from the plugin's bind result `features.mcpTools` (`shared-service.ts` `mcpPath`, logged as `opencode_mcp_path`). Do not compare version strings: the flag is true only when the server has `permission.assert` (OpenCode 2.0.29+) and the plugin is current. A restarted server is a new generation and decides again.
  - **Session path.** The daemon connects the servers itself (`v2/session-mcp.ts`) and the plugin exposes their tools under OpenCode's `<server>_<tool>` names to that session and its descendants only. Each name registers once per location; the `context` hook gives each session its own definition, keeps a same-named tool from the user's config for other sessions, and adds the servers' instructions to every request (instruction entries load before the hook, so a child's first request would miss them). The plugin calls `permission.assert` before each call, so `toolPolicy.preapproved` grants still apply. Launch env, including the browser and `PATH` shims, reaches shells through `session.environment`, which children do not inherit, so the plugin asks the daemon to adopt each descendant before its first model request.
  - **Legacy path.** Without the flag, the agent gets an OpenCode server of its own and its servers go through `mcp.add` with `codemode: false`, then a wait for `connected` under the same 30 s budget as location readiness. Use `mcp.add` only: `mcp.connect` toggles config-backed servers, and newer OpenCode returns `McpServerNotFoundError` for a dynamically added one. Never fail a session because the server is old.
  - The tools-health check (spec 04 §27b.0) follows the path: `mcp.list` on the legacy path, the plugin's per-session registrations on the session path. `JAGENTDESK_OPENCODE_MCP_PATH=legacy` in the daemon environment forces the legacy path on every server.
- OpenCode owns user message IDs. Do not pass JAgentDesk IDs to its prompt APIs; record the user row from `message.updated`.
- Complete turns from v2 execution events, reconciled against active state and the durable log after admission, after reconnect, and while a turn stays active. Do not use `session.wait`: a long turn exceeds Node's HTTP headers deadline while OpenCode keeps working. The event feed has no replay. A quiet stream is healthy; v2 heartbeats are SSE comments.

## Gotchas

- **`AgentProvider` is `string`.** IDs are validated at runtime against the registry.
- **Runtime values win.** The manifest supplies UI scaffolding (icons, color tiers); models and modes come from the provider at runtime. Keep the manifest mode list and the client's mode list in sync.
- **`defaultCommand` is a tuple**: binary, then default arguments. `super.isAvailable()` checks that the binary resolves.
- **Runtime settings can replace the command or add env** per provider (`ProviderRuntimeSettings`). The registry passes the provider's slice to your factory.
- **Auth varies.** Env API keys, OAuth tokens, auth files (`~/.codex/auth.json`) or CLI-managed auth (Copilot). `isAvailable()` checks whatever your provider needs. Never add auth checks to tests.
