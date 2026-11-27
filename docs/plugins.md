# Plugins: JAgentDesk vs upstream

This page covers installed plugins and the bundled SDK plugins. Statically linked features
(Docker, Kubernetes, Databases and the rest) are in [Built-in feature plugins](builtin-plugins.md).

JAgentDesk's plugin system is a selective port of the upstream split plugin API (separate
client and server entries, `PluginClientContext` / `PluginServerContext`, SDK subpaths
`@jagentdesk/plugin`, `/client`, `/client/ui`, `/client/react-native`, `/client/host`,
`/server`, `/server/provider`, `/server/acp`). Author-facing docs are in
[`public-docs/plugins/`](../public-docs/plugins/). This page lists where JAgentDesk behaves
differently and what is not wired yet.

Code: `packages/plugin` (SDK), `packages/server/src/server/plugins` (daemon runtime),
`packages/app/src/plugins` (app host).

## Entries

| Plugin files                                | Client runs   | Server runs  |
| ------------------------------------------- | ------------- | ------------ |
| `index.client.ts(x)` + `index.server.ts(x)` | client entry  | server entry |
| `index.client.ts(x)` only                   | client entry  | —            |
| `index.server.ts(x)` only                   | —             | server entry |
| `index.server.ts(x)` + `index.ts(x)`        | `index.ts(x)` | server entry |
| `index.ts(x)` only (pre-split plugin)       | `index.ts(x)` | —            |

Upstream rejects pre-split single-entry plugins; JAgentDesk keeps loading them as client
entries (`resolveEntryPaths` in `compiler-build.ts`).

## Requirements

`requirements.jagentdesk` (a semver range) is enforced when a plugin declares it, on both the
daemon and the app. A manifest **without** requirements is accepted on any version.
Upstream treats a missing range as `<0.8.0` and rejects it; JAgentDesk does not, because
those are exactly the pre-split plugins it still loads (`packages/protocol/src/plugin-requirements.ts`).

## Upstream plugins

Plugins written for upstream are rebranded on install (`paseo-rebrand.ts`) in two steps:

1. **Before the plugin's own build steps**, the manifest file is renamed.
2. **After them**, across the whole checkout (including helper packages outside the plugin
   folder), the SDK scope `@getpaseo/plugin` / `@paseo/plugin` becomes `@jagentdesk/plugin` with
   every subpath kept, and the SDK's branded runtime exports (`usePaseo`,
   `usePaseoContextValue`, `PaseoApiProvider`, `getPaseoClient`) are renamed in files that import
   the SDK. Doing this after the build lets the build resolve `@getpaseo/plugin` from the
   plugin's own dependencies.

Entry file names are kept. `requirements.paseo` is a Paseo version range, so it is checked
against the Paseo plugin API JAgentDesk implements (`SUPPORTED_PASEO_PLUGIN_API`,
`>=0.8.0-0 <=0.17.3`), not against the JAgentDesk version. Type-only imports of the host packages
(`@getpaseo/*`, `@jagentdesk/*`) pass validation because types are erased.

## Installing and updating

Settings → host → Plugins installs from a directory, Git or npm source and shows each plugin's
status, source and revision. `jagentdesk plugin update [plugin-id]` shows the available updates and
asks before applying them (`--yes` skips the prompt, `--check` only shows them). The Marketplace
(paseo.cafe catalog) sits alongside the source installer.

A Marketplace entry installs from its scanned npm release when it has one and falls back to its
Git source; npm installs count as installed. Catalog caveats are shown, and entries without a
manifest show "Can’t install". Plugin screenshots and README images open in the zoomable viewer.

## Persistence

`pluginsEnabled` and `plugins` are written at the top level of `config.json`, so installed
plugins and the global toggle survive a daemon restart. Removing a plugin uses
`removePlugins` because the config store deep-merges patches. Plugin settings
(`registerSettings`) are stored under `$JAGENTDESK_HOME/plugin-settings/<pluginId>/` and are
readable by the server entry at startup before any client connects.

## Runtime contracts

Use `server.addHook` with the SDK hook names, such as `agent.open.before`,
`agent.turn.after` and `worktree.create.after`. Legacy `before` / `on` names remain aliases.
Before hooks transform requests in registration order. Waiting hooks reject the operation
with plugin attribution; notification failures are logged and do not stop later handlers.
`worktree.create.after` finishes before setup scripts or the first agent opens. A failed hook
rolls back a worktree created by that operation. Registered worktree reuse keeps the fork's
existing ownership rules.

`server.registerWorktreeManager({ create, remove?, restore? })` lets a plugin take over worktree
creation, removal and restoration. It runs after `worktree.create.before` and before
`worktree.create.after`, with the 120-second Git worktree timeout. The daemon snapshots existing
worktree paths before `create` so a manager cannot adopt a pre-existing directory, verifies the
Git worktree afterwards, records `worktreeManagerPluginId` in `jagentdesk/worktree.json` and on
the workspace record, and skips first-agent branch auto-rename. Removal saves
`refs/jagentdesk/kept-commits/<sha>` before the owning plugin's `remove`. All three callbacks carry
`untrusted` for fork change requests; `remove` and `restore` fall back to built-in Git when the
plugin declines or is disabled. Example: `plugin-examples/worktrunk`.

`terminal.create.before` runs in `withTerminalCreateHook`, which wraps the daemon's local terminal
manager, so every local creation path is covered and adopted terminals are not; callers pass an
`origin` to name the source. SSH terminals bypass it: they run on the remote host, where a launch
wrap's executable does not exist. `command.run.before` runs inside the setup and teardown runners
through `commandRunHook`. Setup and archive dependencies take `lifecycle` as a required field so a
new caller cannot skip the hook by omission; pass `null` only where no plugins run. Both hooks change
only `env` and a [launch wrap](#launch-wrap); `keepSelectedWrap` in the lifecycle module applies the
one-wrap rule to all three wrap hooks. The terminal wrap becomes the terminal's `command` and `args`
in `withTerminalCreateHook`, so the terminal worker protocol does not change. A default-shell
terminal resolves the shell there through `default-terminal-shell.ts`, which stays apart from
`terminal.ts` so the daemon does not load node-pty. The wrapped shell starts without JAgentDesk's
shell integration, so a wrapped script does not report command completion. A setup or teardown wrap
goes in front of the `buildStringCommandShellInvocation` argv.

Plugin providers participate in provider discovery, launch overrides, diagnostics and reload.
Declare `ProviderRegistration.launchWrap: true` when every session spawns its own harness and can
run it as `[...config.wrap, command, ...args]`, and offer `session.launch_wrap` on the connection.
`runAcpProvider({ command })` does both; the bundled Muse Code connector declares them itself.
A reload retires their native sessions; the next prompt reopens a resumable session. Closing
an already closed provider session does not issue another native close. Provider launch
configuration preserves custom-provider environment overlays and internal MCP approval rules.

`agent.open.before` can attach per-agent tools, MCP servers and instructions. These are launch
state, not persisted user configuration. Tools are filtered through the provider's
`jagentdeskTools` policy. Tool and MCP name collisions fail before the session opens.
`packages/server/src/server/plugins/session-attachments.ts` records what each plugin contributed to
each live session. A plugin start, stop, or reload reruns only that plugin's callback per session,
swaps its tools in place, and reopens a session only when its launch would differ. A reopen closes
the provider process, so a reload must not reopen agents the plugin does not change. Agents with
native plugin tools resolve the tool by plugin and name at call time and keep their launch-time
catalog until the reopen.

### Launch wrap

An `agent.open.before` result can carry `wrap: [executable, ...args]`. The provider then starts that
session's harness as `[...wrap, command, ...args]` with the final hook env, with no shell except for
Windows script launchers, which go through cmd.exe like any provider launcher. `executable` must be
an absolute path. The wrap is never saved on the agent; every open asks the hooks again, and a plugin
session reopen reuses the wrap it opened with.

- **Support is a provider property.** The provider snapshot entry carries `launchWrap: true` when
  the provider can apply a wrap; an absent field means unsupported, which is also what an older host
  reports. Built-in providers declare it in the contract table in `provider-registry.ts`; custom ACP
  providers and providers that extend a built-in inherit it.
- **One wrap per open.** A later hook may omit the wrap or return the same value. A different value
  fails the open.
- **Fail closed.** `buildLaunchContext` admits a wrapped open before any harness starts and throws
  `LaunchWrapUnsupportedError` (`code: "launch_wrap_unsupported"`) when the provider does not declare
  support or a plugin provider's live connection lacks `session.launch_wrap`. A missing launcher
  fails the spawn; nothing retries the bare command.

Providers start through `spawnProcess({ wrap })`; `applyLaunchWrap` covers the launches that do not
(pty terminals, OMP's stdio MCP transports, worktree commands). The wrap also covers what JAgentDesk
starts for the session: OMP's stdio MCP servers, Pi's MCP probe, and ACP client terminals. OpenCode
shares one server between sessions, so a wrapped session gets a dedicated server started behind the
wrap; the MCP servers OpenCode starts for it run inside that server. A configured external OpenCode
server cannot be wrapped and the open fails. The guarantee does not cover JAgentDesk's host terminal
tools, work before the open hook (draft command and control discovery, the catalog lookup during
create without a model), host-side probes, catalog, session listing, version, update and usage
commands, Codex native archive, or a later open after the plugin that chose the wrap is gone.

Plugin sessions receive events only when they express demand through `observeEvents` or
registered handlers. Plugin RPC subscriptions own their delivery, release and reconnect
lifetime, and carry JSON or `Uint8Array` values. Plugin binary opcodes are `0x40`–`0x42`:
`0x20` already belongs to JAgentDesk screen frames and `0x30` is reserved for upstream host
routing. Protocol capability fields are optional for older clients and daemons.

Agent refs support `timeline.append`. `agent.turn.after` has no timeline field; fetch a bounded
page through the agent ref when a hook needs history. Streaming provider history uses the
canonical store, including rewind, without retaining a second complete snapshot.

Every app plugin surface supplies the installation host's state source. A surface that spans
hosts can pass its own source. Screens and Settings therefore have the same entity hooks as
workspace panels.

Workspace panels may declare `workspace`, `explorer`, or both locations. On web,
`explorer` opens a retained right-pane tab and keeps the existing main pane selected.
Native and compact layouts open that panel in the workspace. Dragging a plugin tab
between web hosts must respect its declared locations; do not infer host support from
the generic plugin panel manifest.

Timeline transformers receive immutable source items before display grouping. Each plugin row keeps
the row it replaced as `source`, which outline navigation, find and turn logic read. A reply split
into several cards stays one reply: turn folding keeps every card visible, and the turn footer hangs
under the last card, copies the original reply text once, forks at its message, and shows its
duration and stats. Read a reply with `getAssistantReply` (`packages/app/src/types/stream.ts`)
instead of checking `kind === "assistant_message"`. Client renderers run inside the installation's
existing runtime, including its translations and state source.

## Bundled plugins

The daemon loads bundled plugins through `BuiltinPluginLoader` before configured plugins, including
when the user plugin switch is off. They share Settings → host → Plugins → Built-in and its
per-host switches with the feature built-ins; `pluginsEnabled` applies only to Installed. Toggle
rules, persistence and dependency checks are in
[Built-in feature plugins](builtin-plugins.md#turning-a-built-in-off).

`worktree-include` is bundled in source and packaged builds. It copies matching ignored files from
`.worktreeinclude` before setup or the first agent starts. It does not overwrite existing
destinations or copy tracked files.

Bundled provider plugins follow the configured executable and environment. A missing CLI shows an
unavailable reason in the existing row.

Bundled `*-usage-source` plugins feed Usage with their account reports; turning off a source stops
its plugin and removes its cards. Usage opens from the sidebar. Its Sources list controls card
visibility on this device; the Built-in switches control discovery on the host. Quota fetches run
while Usage, a context popover, or the visible sidebar summary needs them. Per-turn token and cost
history belongs to the `insights` built-in.

Plugin tools are captured once per agent, including stateless HTTP MCP access, so a toggle changes
new agents' catalogs only. Session subscriptions and background services still stop on disable. Do
not clear push listeners while stopping a service: the same WebSocket sessions must work when it is
enabled again.

## Composer surfaces

Composer items share the composer's model and option controls. Keep legacy composer pills on this
host too, so toolbar measurement and compact overflow account for every plugin control.

A sheet or popover can mount in a separate React tree. Carry the installation's runtime contexts
through `usePluginRuntimeContextBridge`; the composer and New workspace contexts belong to the
surface that opened it. Creating a second runtime loses that surface's draft and translation state.

## Remaining host gaps

The supported Paseo version range covers the ported runtime API, not every upstream host surface.
Runtime e2e tests in `packages/server/src/server/plugins/` skip the cases that need a missing host
integration and name the prerequisite beside the test:

- Owned-list observation recovery after repeated socket closes needs the client list subscription
  engine.
- Worktree creation hooks across receipt replays need idempotency receipts in `CreationService`.
- Enabling and disabling configured plugins through a daemon config reload, without a restart,
  waits on the config reload path.
