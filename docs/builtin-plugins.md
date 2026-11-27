# Built-in feature plugins

Each optional feature lives in `plugins/<id>/` and is statically linked into the daemon and the app.
Built-ins run in the host process. They do not use the installed-plugin process, the client bundle
evaluator, or the `pluginsEnabled` switch (see [Plugins](plugins.md) for installed plugins). The
persisted ids, defaults, dependencies, RPC names, tool names and data paths are release contracts:
do not rename them.

## The list

| Id                 | Name                                          | Default | Requires      |
| ------------------ | --------------------------------------------- | ------- | ------------- |
| `docker`           | Docker                                        | on      |               |
| `clusters`         | Kubernetes ([guide](kubernetes.md))           | on      |               |
| `databases`        | Databases ([guide](databases.md))             | on      |               |
| `ssh-servers`      | SSH servers ([guide](ssh.md))                 | on      |               |
| `remote-tasks`     | Remote tasks ([guide](remote-tasks.md))       | on      | `ssh-servers` |
| `custom-providers` | Custom API providers                          | on      |               |
| `jira`             | Jira                                          | on      |               |
| `argocd`           | Argo CD                                       | on      | `clusters`    |
| `devices`          | Devices & simulators ([guide](simulators.md)) | on      |               |
| `workbench`        | Workbench                                     | on      | `devices`     |
| `forge-hub`        | Forge Hub ([forges](forge-providers.md))      | on      |               |
| `skills`           | Skills                                        | on      |               |
| `memory`           | Memory ([guide](memory.md))                   | on      |               |
| `spec-mode`        | Spec mode                                     | on      | `skills`      |
| `autorun`          | Autonomous run                                | off     |               |
| `insights`         | Insights                                      | on      |               |
| `session-share`    | Session sharing                               | off     |               |
| `browser-tools`    | Agentic browser ([guide](agentic-browser.md)) | off     |               |

The same Built-in list also holds `bots` ([Bots](bots.md)), `worktree-include`, the bundled
provider plugins and the `*-usage-source` plugins. Those keep the SDK runtime described in
[Plugins](plugins.md#bundled-plugins); this doc covers the 18 features above. The manifest in
`plugins/<id>/jagentdesk-plugin.json` is the source of truth for names, defaults and dependencies.

## Turning a built-in off

Settings → host → Plugins → Built-in has one switch per built-in, per host. The state persists in
`config.json` under `builtinPlugins.<id>.enabled`; a missing key means the manifest's
`defaultEnabled`. On first start the daemon wrote `builtinPlugins` once from the legacy
`browserTools`, `autorun` and `sessionSharing` flags; after that those flags do nothing. Keys for
built-ins that no longer exist are ignored.

Change state only through `plugins.builtin.set.request` (needs `daemon.manage`), so dependency
checks and service lifecycle run together. Turning on a built-in whose requirement is off, or
turning off one that another needs, fails with `plugin_dependency` unless the request sets
`cascade`; the app asks "Also turn on/off …?" and resends with it. A built-in whose host capability
is missing (for example `devices` without Xcode or adb) is listed with `available: false` and
cannot be turned on. Every session receives `plugins.builtin.changed`.

While a built-in is off:

- The app hides its sidebar destination, mobile drawer entry, panels, settings and composer
  controls without a reload. A deep link to its screen shows "Plugin turned off" with a
  permission-gated "Turn on".
- Its RPCs answer `plugin_disabled`.
- Agents lose its tools from their next message. A provider reads its tool list once, when its
  runtime starts, so each launch adopts the host's current set (`BuiltinPluginState.forAgent`
  holds it for that runtime's stateless MCP requests). At the start of every turn the agent manager
  compares that set with the host's; when a built-in with agent tools changed, it closes the runtime
  and resumes the same native session, keeping the agent id and timeline (spec 04 §27b.1). The
  same happens when a built-in's `agentLaunchHints` change: Jira adds an instruction and hides
  the provider's own Atlassian connectors once a connection exists, without changing any tool
  group. A session without a resumable id keeps its old tools and gets one "New tools apply from
  a new session" row, unless it has no conversation yet, in which case it starts again.
- Every foreground turn also asks the provider whether the JAgentDesk tools reached its runtime
  (`AgentSession.checkJAgentDeskTools`: Claude `mcpServerStatus()`, Codex `mcpServerStatus/list`,
  OpenCode the bridge plugin's `status`; others answer `unknown`). Missing tools get one
  release and resume with a fresh MCP config, then a "JAgentDesk tools are unavailable for
  <provider>: <reason>" row (spec 04 §27b.0). Wrapped providers (profiles, custom providers)
  must forward the method; `provider-registry.ts` enforces that through its type.
- An agent asked for an off built-in calls `turn_on_host_tools`, which shows "Turn on <name> for
  this host?" even in unattended modes, because it changes host settings.
- Its background services and session contributions stop within five seconds.
- Its data and secrets stay on disk.

`server_info.features` flags derive from the same state (`BUILTIN_PLUGIN_FEATURES` in
`packages/protocol/src/builtin-plugins.ts`), so older apps also hide disabled features.

## Layout and generated files

```
plugins/docker/
  jagentdesk-plugin.json   # kind: "builtin", id, name, defaultEnabled, requires, builtinOrder, builtinEntrypoints
  package.json             # type: module, so the daemon build emits ESM
  server/index.ts          # export function register(host: BuiltinServerHost)
  client/index.tsx         # export function register(app: BuiltinClientHost)
```

`builtinOrder` sets list order. `builtinEntrypoints.server` / `.client` are paths relative to the
plugin directory; a feature without UI omits `client`. `npm run generate:builtin-plugins`
(`scripts/generate-builtin-plugins.mjs`) writes `packages/protocol/src/builtin-plugins.generated.ts`
and both `plugins/builtin/load.generated.ts` loaders. Commit the outputs; `npm run lint` fails when
they are stale. A manifest with `index.server.ts` instead of `builtinEntrypoints` is a bundled SDK
plugin, not a feature.

## Boundaries

`npm run lint` runs `scripts/lint-builtin-boundaries.mjs` before oxlint. It enforces:

- A feature imports core only through `packages/server/src/server/plugins/builtin/host-api.ts` or
  `packages/app/src/plugins/builtin/host-api.ts`. Tests may also import
  `packages/server/src/server/plugins/builtin/host-test-api.ts`.
- A feature never imports another feature. When one feature needs another, the provider exposes a
  core-declared port (see `host.provide` below) and the consumer lists it in `requires`.
- Core imports features only from the generated loaders.
- Client code under `plugins/` does not import packages installed only in
  `packages/app/node_modules` (`expo-clipboard`, `react-native-safe-area-context`); they do not
  resolve from `plugins/`. Re-export them from the client host API.

When a feature needs another core service, add it to the host API deliberately. Do not re-export
`expo-router/react-navigation` from the client host API: every core module that reads the registry
would load it, and its CommonJS entry pulls raw React Native into the app's unit tests.

## Daemon host

`register(host)` runs once at load and declares contributions. The interface is
`BuiltinServerHost` in `packages/server/src/server/plugins/builtin/host.ts`.

- `host.rpc(namespace, methods, create, { eager })` registers exact inbound wire names. The same
  list admits and dispatches requests, so do not add a second allowlist entry in `Session`. The
  host answers `plugin_disabled` before creating or calling a handler. New RPCs follow
  [RPC namespacing](rpc-namespacing.md) and [protocol compatibility](protocol-compatibility.md);
  existing slash names stay. `create` returns a session contribution with `handle`, `stop`, and
  optional `start` and `capabilitiesChanged`. It is created on the first request, or when the
  session opens and on enable with `eager: true`; use eager when the client relies on pushes
  before it sends a request (Jira's desktop sign-in delegation). `stop` must invalidate pending work
  synchronously before it awaits cleanup, and a late result must check its generation before
  spawning a child or publishing.
- `request.supports(capability)` on each handler's request context answers for the connection that
  sent the request.
- `host.agentTools(install, { slot })` installs tools into one agent's catalog. The context gives
  the caller id and labels, `requestPermission` / `requestHostToolPermission` (approval stays in
  core), the cluster and database registries, `service(handle)` and `provided(key)`. Do not check
  live plugin state in a tool handler. `slot` keeps catalog order: core installs each slot at a
  fixed position, and a feature registers at most once per slot (Devices adds Sideload tools to
  `accounts` and `sim_*` to `late`).
- `host.backgroundService(create)` returns a handle to one instance per daemon, started and stopped
  with the plugin. `start(signal)` gets a new abort signal per enable; start and stop each have
  five seconds. Optional `idle()` runs once when the daemon starts with the plugin off.
- `host.daemonService(create, dispose)` returns a ref to one instance per daemon that exists
  whether or not the plugin is on. Put work that must stop while disabled in a background service.
  The create context adds the agent manager and storage, `broadcast`, `sendPush`, `isEnabled`, the
  host capability probe, and core resources a feature borrows (Session sharing's tunnel manager and
  guest attach).
- `host.shared(create)` returns an accessor for one value per daemon, keyed by its config store
  (Argo CD's SSE service).
- `host.provide(key, get)` serves a port declared in `BuiltinPorts`. Core flows read ports
  (prompt delivery reads `skillInvocation` and `memory`, spawn reads `specMode`), and features that `require`
  this one read `BuiltinProvidedServices` entries with `provided(key)`. Devices provides the
  simulator installer that Workbench's `sim_install_batch` uses.
- `host.botTriggerSource(source)` adds a source to the Bots poller while the plugin is on.

Several daemons run in one test process, so keep daemon state in these per-daemon helpers, never in
module variables.

Sessions and tools receive `BuiltinCoreServices` (`services.ts`): the logger, config store, a
secret store and SQLite opener rooted at `$JAGENTDESK_HOME/builtin-plugins`, the Docker service
factory and remote routing, binary frame codecs, the terminal manager, push and binary push. Prefix
new secret keys and database paths with the feature id. A feature that moved from core keeps its
existing storage location.

Shared libraries stay in core because another feature or core flow consumes them:

| Library                                                            | Consumers                                                  |
| ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Docker CLI service, log/stats streams                              | `docker`, SSH remote Docker                                |
| Cluster/database registries, Kubernetes and SQL clients, DTOs      | `clusters`, `databases`, SSH remote k8s/database, `argocd` |
| SSH service: pool, storage, remote Docker/database/k8s, forwarding | `ssh-servers`, `remote-tasks`                              |
| Custom provider service                                            | `custom-providers`, the provider runtime at spawn          |
| Browser broker and its RPCs                                        | `browser-tools`, basic browser tools                       |
| Guest scopes, guest socket attach, cloudflared tunnel manager      | `session-share`                                            |
| Provider skill directories (`agent/native-skill-paths.ts`)         | `skills`, `spec-mode`                                      |

These reach features as `BuiltinPlatformServices` on the services object. Bootstrap starts built-in
services after the libraries exist and stops them, dependents first, before it disposes the
libraries.

## Client host

`register(app)` uses `BuiltinClientHost` from `packages/app/src/plugins/builtin/host.ts`. It can
add a sidebar destination and mobile drawer entry, a left panel, a route screen, settings sections,
a card on Settings → Providers, composer items, agent controls, header controls, composer docks,
agent panel accessories, Settings → host → Tools & prompts cards, a user message body, turn preparers, timeline
renderers, tool call cards, attachment sources and pills, per-host mounts, message actions (under every user message and
assistant turn) and agent inspector tabs. Read the interface
for each signature.

- Use one destination for desktop and mobile. `group: "Tools"` puts it in the sidebar's Tools
  group. Order comes from `APP_NAV_ORDER` in `packages/app/src/components/sidebar/nav-order.ts`;
  add a new destination there. `hostCapabilities` hides it on hosts that report none of them.
- A destination drills the sidebar into the feature's left panel only when the feature registers
  one for its segment. `routeSegments` adds list/detail segments, `shortTitle` sets the drill-in
  title, and `section: true` makes a desktop-only section that also replaces the header (Argo CD).
- Screens receive the selected `serverId`; never pick the first host inside a feature screen. A
  screen reads its own route params. Route adapters pass `focused` for screens kept mounted while
  blurred.
- Expo route files stay in `packages/app/src/app` as small adapters to `BuiltinScreen`, so URLs and
  route ownership do not move. See [Expo Router](expo-router.md).
- A turn preparer adds message fields such as `skillIds`. Only enabled features' preparers run, so
  a disabled feature does not consume its pending state.
- State that another feature or core drives stays in core and is exported through the host API:
  the cluster navigation and view stores (Argo CD's "Open in Clusters"), the cluster and database
  chat stores, and `KindIcon`.

`BuiltinClientRegistry.visible` filters every contribution against live per-host state. Toggling
one host leaves another host's contributions alone. A disabled screen keeps its route; removing the
route breaks native navigation retention.

Feature client tests run in the app's unit Vitest project. Unistyles' Babel config includes
`plugins/`, so feature styles get the same transform on every platform.

## Build output

The server build compiles features with the monorepo as its TypeScript root, then
`packages/server/scripts/relocate-builtin-build.mjs` moves them to `dist/server/builtin-features`
and rewrites imports so published daemon paths do not change. Bundled SDK plugins keep
`dist/server/builtin-plugins`. A runtime asset a feature reads from beside its module (Workbench's
Frida scripts) needs a copy step in `build:lib`. Check emitted ESM imports, not only source tests.

## Checking a change against the release contract

`node scripts/compare-builtin-contracts.mjs <baseline> <out-dir> [plugin-id...]` scans both trees
and compares, per feature, the wire names it owns, the agent tool names it registers, the app's
i18n keys and the manifest ids. Pass `worktree` as a revision to use the working tree. Add a new
feature's RPC and tool prefixes to `PLUGINS` in the script. `scripts/dump-builtin-registrations.mts`
prints what each feature registers through the real host.

For a change that moves or splits a feature, also verify on an isolated daemon home and port
(unset `CLAUDE*` variables, relay and Tailscale off): real data, navigation removal within two
seconds of turning it off, `plugin_disabled` RPC errors, old and new agents' tool sets, turning it
back on, and persistence across a restart. Keep web bundle growth under 5%.
