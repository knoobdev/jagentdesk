# Plugins: JAgentDesk vs upstream

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
entries (`resolveEntryPaths` in `runtime.ts`).

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

Settings → Plugins installs from a directory, Git or npm source and shows each plugin's status,
source and revision. `jagentdesk plugin update [plugin-id]` shows the available updates and asks before applying
them (`--yes` skips the prompt, `--check` only shows them). The Marketplace entry (paseo.cafe catalog) is kept alongside the source installer.

A Marketplace entry installs from its scanned npm release when it has one and falls back to its
Git source; npm installs count as installed. Catalog caveats are shown, and entries without a
manifest show "Can't install". Plugin screenshots and README images open in the zoomable viewer.

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

Plugin providers participate in provider discovery, launch overrides, diagnostics and reload.
A reload retires their native sessions; the next prompt reopens a resumable session. Closing
an already closed provider session does not issue another native close. Provider launch
configuration preserves custom-provider environment overlays and internal MCP approval rules.

`agent.open.before` can attach per-agent tools, MCP servers and instructions. These are launch
state, not persisted user configuration. Tools are filtered through the provider's
`jagentdeskTools` policy. Tool and MCP name collisions fail before the session opens. Plugin
changes invalidate open sessions so the next open uses current contributions.

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

## Built-ins

The daemon loads bundled plugins through `BuiltinPluginLoader` before configured plugins,
including when the user plugin switch is off. `worktree-include` is bundled in source and
packaged builds. It copies matching ignored files from `.worktreeinclude` before setup or the
first agent starts. It does not overwrite existing destinations or copy tracked files.

The same loader reserves the 19 statically linked feature ids. Settings → Plugins shows their
per-host switches above Installed; `pluginsEnabled` applies only to Installed. Feature switches
persist in top-level `builtinPlugins`. The config store migrates the three legacy opt-in flags
once; after that, editing those flags does not change built-ins.

Use the built-in set RPC for changes so dependency checks, cascades and service lifecycle run
together. Wire requests use `.request` / `.response` suffixes; a disabled feature answers with
`plugin_disabled`. Keep workspace Forge checkout/search, shared Docker/secret-store libraries,
and guest permission checks independent of feature gates.

Capture feature tools once per agent, including stateless HTTP MCP access. A toggle changes new
agents' catalogs; existing agents retain their launch tools. Session subscriptions and daemon
background services still stop on disable. Do not clear push listeners while stopping a service:
the same WebSocket sessions must work when it is enabled again.

Usage-source built-ins await the Usage host API.

## Remaining host gaps

The supported Paseo version range covers the ported runtime API, not every upstream host
surface. These integrations still depend on other platform batches:

- Plugin timeline sender projection needs the app timeline projection host (B5, #8492).
- Full owned-list observation recovery needs the client list subscription engine (B5).
- Background counts and snapshot flags need background agent/work ownership (B7, #9362).
- Worktree manager creation/removal/restoration needs workspace automation gates (B9, #10278).
- Workspace receipt replay and automatic `firstAgentContext` creation need CreationService (B9).
- Reloading plugin configuration from disk needs the config reload RPC (B2, #7959).

Runtime e2e tests are enabled in `packages/server/src/server/plugins/`. Individual cases that
need these absent hosts remain skipped with their prerequisite beside the test.
