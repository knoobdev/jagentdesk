# Built-in feature plugins

Built-in features are statically imported into the daemon and app. They run in the host process;
they do not use the installed-plugin process, client bundle evaluator, or `pluginsEnabled` switch.
Settings → Plugins controls each feature per host. The persisted ids, defaults, dependencies,
capabilities, RPC names, tool names, and data paths are release contracts.

Docker was the phase 2 pilot; Clusters, Databases, Argo CD, SSH servers, Remote tasks and Custom
providers followed. Migrated features declare `builtinEntrypoints`; the other feature manifests
still describe phase 1 implementations.
Docker was the phase 2 pilot. Migrated features declare `builtinEntrypoints`; the other feature
manifests still describe phase 1 implementations.
Docker was the phase 2 pilot. A manifest with `builtinEntrypoints` is migrated; the others still
describe phase 1 implementations. Each migrated feature kept some code in core because another
feature or a core flow shares it:

| Feature          | Stays in core                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| `docker`         | Docker CLI service, log/stats streams, SSH remote Docker                                               |
| `skills`         | Provider skill directories (`agent/native-skill-paths.ts`), tar extraction, bundled-skill lookup       |
| `spec-mode`      | Plan contract and tasks.md parser (`agent/spec-plan.ts`), per-agent mode hooks, phase bubble text      |
| `autorun`        | Nothing beyond the per-agent mode hooks it shares with Spec mode                                       |
| `activity-graph` | Archify renderer, the stream's node-selection contract (`agent-stream/activity-node-action.ts`)        |
| `insights`       | The usage-history query key the push router writes                                                     |
| `session-share`  | Guest scopes, guest socket attach and re-scoping, guest-mode app entry, the cloudflared tunnel manager |
| `browser-tools`  | The browser broker and its RPCs (basic browser tools), fingerprint profile patches                     |

The bundled provider and usage plugins retain their existing SDK runtime. Do not move those
implementations while migrating a feature.

## Layout and generated list

```
plugins/docker/
  jagentdesk-plugin.json
  package.json                 # type: module for daemon TypeScript emission
  server/index.ts              # register(host: BuiltinServerHost)
  server/session.ts            # RPC handlers and per-session resources
  server/streams.ts            # local Docker events watcher
  server/agent-tools.ts
  server/lifecycle.posix.test.ts
  client/index.tsx              # register(app: BuiltinClientHost)
  client/sidebar.tsx
  client/screen.tsx
```

A manifest with `kind: "builtin"` supplies its feature metadata. `builtinOrder` preserves list
order. A migrated feature declares `builtinEntrypoints.server` and `.client` with paths relative
to its directory. Keep existing SDK manifest fields such as `requirements` when present.
`npm run generate:builtin-plugins` generates the protocol metadata and the daemon/app static
loaders. Commit those outputs. Lint rejects stale outputs. Adding a manifest does not change
wire schemas or add an installed plugin.

The only core-to-feature imports belong in `plugins/builtin/load.generated.ts` in each host.
Expo's route file remains a small adapter to the generic `BuiltinScreen`, preserving its URL and
route ownership. See [Expo Router](expo-router.md).

## Daemon host

Import the declared API at
`packages/server/src/server/plugins/builtin/host-api.ts`. Extend that facade deliberately when a
migration needs another shared core service; do not import core implementation files from the
feature. The facade exposes shared Docker/process/pty primitives, the secret store class, the
host tool installer, and tool types. Per-session
services provide the logger, config store, secret store, SQLite opener, Docker service factory
and remote routing, binary frame codecs, terminal manager, structured push, binary push, the
client's capabilities, and its transport backlog. `core.daemon` carries the hooks only the
bootstrap can supply: agent lifecycle events, broadcast to every client, and the offline push
notice. Bootstrap starts the registry after the agent manager exists for that reason. Vendored
daemon assets resolve through `vendorDirectoryCandidates`, because compiled features do not sit
where `src/server` modules do.
SQLite paths stay within the daemon's built-in storage directory. Prefix new secret keys and
new database paths with the feature id. Preserve existing storage locations during migrations.

Shared libraries that several features or core subsystems consume stay in core and reach features
as `BuiltinPlatformServices` on the same services object: the SSH service (pool, storage and its
remote Docker/database/cluster/forwarding modules), the custom provider service (the provider
runtime materializes it at spawn), agent access (labels, cwd and `requestHostToolPermission`) and
the hooks that close SSH dependents. Bootstrap supplies the
daemon instances; a session receives the same instances. Bootstrap starts built-in background
services after these libraries exist and stops them, dependents first, before it disposes the
libraries. `home`, `daemonId` and `broadcastToTrustedSessions` (each session's emit gate still
applies) are on the same object.

A feature that owns a daemon-wide service (a job engine, a cache) creates it in its background
service and shares it with its sessions and tool installers through `createDaemonSlot()`. A slot
holds one value per daemon, keyed by the daemon's config store, so in-process test daemons stay
separate. Do not keep daemon state in plain module variables.

`register(host)` declares contributions once:

- `host.rpc(namespace, methods, createSession)` registers exact existing inbound wire names.
  The same method map admits and dispatches requests. A synchronous handler is still consumed;
  it cannot fall through to another dispatcher. The host applies `plugin_disabled` before
  creating or calling a handler, including after an awaited lifecycle transition. Keep existing
  slash names during migrations; new RPCs follow [RPC namespacing](rpc-namespacing.md).
- `host.agentTools(install)` receives the core tool registrar and a per-agent context: caller id
  and labels, the host-tool permission request, the shared cluster/database registries, and the
  daemon core services. The host installs tools from the agent's captured enabled-plugin set. Do
  not check live plugin state in a tool handler: existing agents retain their opening tool set.
  Approval and provider tool policy remain in core. The catalog places each feature's tools at its
  established position (`registerAgentTools` `only`/`except` slots); a new feature lands after them.
- `host.shared(create)` returns an accessor for one value per daemon, keyed by its config store.
  Use it for a feature-owned service that the background lifecycle, every session, and the tools
  share (Argo CD's SSE service). Do not keep such a service in module state: tests run several
  daemons in one process.
- `host.agentTools(install, { slot })` receives the core tool registrar and the calling agent's
  context: `callerAgentId`, `requestPermission` (core's host tool approval card), and
  `service(handle)`. The host installs tools from the agent's captured enabled-plugin set. Do not
  check live plugin state in a tool handler: existing agents retain their opening tool set.
  Approval and provider tool policy remain in core. `slot` keeps catalog order: core calls each
  slot where the tools were registered before migration (`default` with the kubectl/sql tools,
  `accounts` before the bot tools, `integrations` after them, `late` before the voice tools). A
  plugin may register once per slot: Devices adds Sideload tools to `accounts` and `sim_*` to
  `late`.
- `host.botTriggerSource(source)` adds a source to the Bots poller while the plugin is enabled.
  Core supplies the poll clock and per-key state; the source owns its query and dedupe keys.
- `host.provide(key, value)` offers a service to the built-ins that `require` this one; consumers
  read it with `provided(key)` from session services or the tool context. Core declares each
  contract in `BuiltinProvidedServices`, so features never import each other. Devices provides
  the simulator installer Workbench's `sim_install_batch` uses.
- Each handler receives a request context; `request.supports(capability)` answers for the
  connection that sent the request, as `Session.supportsForSource` did.
- `host.agentTools(install)` receives the core tool registrar and a tool context (the daemon
  scope, the caller agent id, the agent manager). The host installs tools from the agent's
  captured enabled-plugin set. Do not check live plugin state in a tool handler: existing agents
  retain their opening tool set. Approval and provider tool policy remain in core. The catalog
  installs each feature's tools at the position its phase 1 registration held
  (`installBuiltinTools(id)` in `jagentdesk-tools.ts`); add a slot there when you migrate a
  feature with tools, so the tool order agents see does not change.
- `host.daemonService(create, dispose)` returns a ref to one instance per daemon. The daemon
  creates every feature's instance when it starts its built-ins, enabled or not, as phase 1 did;
  put work that must stop while disabled in a background service. Read the instance with
  `ref.get(services.daemon)` in a session factory or `ref.get(context.daemon)` in a tool
  installer. The create context adds the daemon home, agent manager and storage, `broadcast`,
  `sendPush`, `isEnabled`, the host capability probe once the daemon listens, and the core
  resources a feature borrows (Session sharing's tunnel manager and guest attach). The daemon
  creates these after agent storage loads. Tests install an instance with `builtinServerRegistry.createScope()` and
  `scope.set(ref, instance)`.
- `host.provide(port, get)` serves a core-declared interface (`BuiltinPorts` in `host.ts`) that
  a core flow consumes: prompt delivery, agent launch, guest attach. Core reads it with
  `daemon.port(key)`, or `daemon.enabledPort(key)` where phase 1 checked the feature's state.
  A feature that needs another feature reads that feature's port the same way; it never
  imports it.
- `host.backgroundService(create)` registers a daemon-owned lifecycle through
  `BuiltinPluginState`. Its `start(signal)` receives a new abort signal for each enable; disable
  aborts it before cleanup. The host rejects start/stop operations that exceed five seconds. Use
  the signal to cancel pending work and bind resource cleanup. The bootstrap starts these
  registrations and stops them during daemon shutdown, dependents first. Optional `idle()` runs
  once when the daemon starts with the feature turned off, for shared resources that boot opened
  eagerly.
- A session contribution supplies `handle`, `stop`, and optional `start` and
  `capabilitiesChanged`. The host owns its toggle and disconnect lifetime. It is created on the
  first request unless `host.rpc(..., { eager: true })` asks for creation when the session opens
  and on enable; use that for state the client relies on without sending a request first
  (pushes, delegate registration). `stop` must synchronously invalidate pending work before
  registrations and stops them during daemon shutdown. The call returns a handle; sessions, tool
  installers, and bot trigger sources resolve the daemon's instance with `service(handle)`.
  Instances are scoped by daemon home because e2e tests run several daemons in one process, so
  never keep a daemon service in a module variable. Jira's service is the example: created at
  boot, loaded once, disposed on disable.
- A session contribution supplies `handle`, `stop`, and optional `start`. The host owns its
  toggle and disconnect lifetime. It is created on the first RPC unless registered with
  `{ eager: true }`; use eager when the contribution forwards daemon pushes the client listens for
  before sending any request (Jira's desktop sign-in delegation). `stop` must synchronously invalidate pending work before
  awaiting cleanup, kill children, clear timers, and release subscriptions within five seconds.
  Make start/stop repeatable. A late network result must check its generation before spawning
  another child or publishing an event.

The host checks plugin state. Core continues to own operation permissions, guest containment,
and outbound filtering. A migration does not grant another permission. Remove the feature's
legacy dispatcher and any separate session dispatch allowlist entry; do not duplicate the new
registration in `Session`. Add wire schemas and permission mappings only for genuinely new RPCs.
Read [protocol compatibility](protocol-compatibility.md) first.

Docker keeps the shared CLI service and log/stats stream primitives in core because SSH Docker
also consumes them. Its local events watcher, handlers, subscription ownership, and tools live
in the feature. The local backend object retains its identity: remote routing caches by that
object in a WeakMap. Recreating the object on stop leaks the remote stream owner. Interactive
exec uses the core terminal service through the client host's typed daemon client and terminal
pane. Unmounting the feature closes its exec terminal.

Clusters and Databases keep their registries, Kubernetes/SQL clients, and DTOs in core: SSH
remote k8s/database access and Argo CD's cluster links consume them. The features own the
`cluster/*` and `database/*` handlers, the Helm client, the agent tools, and the disable
lifecycle that disconnects open clients.

The server build compiles static feature imports with the monorepo as its TypeScript root, then
`relocate-builtin-build.mjs` preserves the existing published daemon paths and asset locations.
Compiled features live under `dist/server/builtin-features`; raw SDK plugins keep their existing
`dist/server/builtin-plugins` location. A feature's runtime asset that its module reads from beside
itself, such as Workbench's Frida scripts, needs a copy step into `builtin-features` in
`build:lib`. Validate emitted ESM imports as well as source tests.

## Client host

Import `BuiltinClientHost` and shared UI/services from
`packages/app/src/plugins/builtin/host-api.ts`. Feature-internal imports stay relative. Shared
UI, theme tokens, terminal rendering, host runtime, and workspace selection stay in core. A UI
kit that a not-yet-migrated feature also imports moves to a neutral core path, never into the
feature: Jira's issue primitives live in `components/integration-ui/` because Figma uses them.
UI, theme tokens, terminal rendering, host runtime, and workspace selection stay in core.
Packages installed only under `packages/app/node_modules` (`expo-clipboard`,
`react-native-safe-area-context`) do not resolve from `plugins/`; import them from the host API.
Do not re-export `expo-router/react-navigation` there: every core module that reads the registry
would load it, and its CommonJS entry pulls raw React Native into the app's unit tests. Route
adapters pass `focused` to the screen instead.
Feature client tests run in the app's unit Vitest project.
Unistyles' Babel configuration includes `plugins/` so migrated styles receive the same transform
on web, iOS, and Android.

`register(app)` can contribute a sidebar destination (`Tools` or `main`), a left drill-in panel,
a route screen, settings sections, mobile drawer entries, composer items, timeline renderers,
tool call cards, cards on the host's Settings → Providers page (`providerSettingsSection`),
attachment sources, and per-host mounts (delegation prompts and binders that must run while the
plugin is on). Use the same destination metadata for desktop and mobile. Screens receive the
selected `serverId`; never choose the first host inside a migrated screen. A screen reads its own
route params (`useLocalSearchParams`). A tool call card (`toolCallRenderer`) replaces the generic
rendering of a matching tool call in the chat row (`inline`) or the expanded details (`details`);
the first enabled feature whose `match` returns non-null renders it. `requiresFeature` keeps a
phase 1 `server_info.features` condition for older daemons.

A destination owns `routeSegment` plus any `routeSegments` (list and detail routes). Those give
the Gumloop drill-in title (`shortTitle ?? title`). `routeChanges` notifies when `route` would
change, for example when it reopens the last resource. A left panel registered with
`{ ownsNavigation: true }` replaces the classic sidebar's navigation on its routes; without it
the panel appears only in the Gumloop drill-in. Add `section: true` for a desktop-only section
that also replaces the Gumloop header, as core sections do (Argo CD). Navigation order is the established order in
`use-app-nav.ts` (`APP_NAV_ORDER`) and the classic sidebar's slots; keep a migrated
destination where it was.

State that another feature or core drives stays in core and is exported through the host API:
the cluster navigation and view stores (Argo CD's "Open in Clusters"), the cluster and database
chat stores (agent navigation), and `KindIcon`. A feature never imports another feature.
attachment sources, composer pills for a core attachment kind (`attachmentPill`), and headless
per-host mounts (`hostMount`, rendered once in the host route layout). Use the same destination
metadata for desktop and mobile; a destination's `slot` places it where its row sat before
migration, as with agent tools. `hostCapabilities` hides it on hosts that report none of them,
`shortTitle` keeps a shorter rail label, and existing `sidebar-*` test IDs come from
`components/sidebar/nav-test-ids.ts`. Screens receive the selected `serverId`; never choose the first
host inside a migrated screen.
attachment sources, host binders (mounted per host route), agent controls (the composer's
control row, in plugin order), agent panel accessories, composer docks, a user message body,
agent and workspace header controls, side panels beside the chat, Settings → Agents cards
(`order` keeps several features' cards in sequence), and turn preparers. Use the same
destination metadata for desktop and mobile; `before` keeps a destination at its old rail
position. A destination drills the sidebar in only when the feature registers a left panel for
its segment. Screens receive the selected `serverId`; never choose the first host inside a
migrated screen. A turn preparer adds message fields such as `skillIds` when the user sends;
`prepareBuiltinTurn` runs only enabled features' preparers, so a disabled feature does not
consume its pending state.

`BuiltinClientRegistry.visible` selects every contribution against live per-host server state.
The generic adapters in `surfaces.tsx` feed navigation, drill-in, screens, settings, and composer.
The existing timeline and attachment adapters also consume this registry. Attachment sources
reuse SDK schemas and supply a typed daemon-client search callback, so a built-in does not invoke
an installed-plugin RPC. Existing SDK timeline item and attachment types remain reusable.

A disabled screen keeps its route and renders the existing “Plugin turned off” state with the
permission-gated “Turn on” action. Removing the route itself breaks native navigation retention.
The daemon's feature update hides contributions without an app reload. Host ids are independent;
toggling one host must leave another host's contributions visible.

## Migrate a feature

1. Read its entry-point inventory in the spec repository's feature map. Search the code for its
   RPC names, tool installer, service creation, event listeners, routes, settings, sidebar,
   composer, timeline, and attachment imports. Identify shared libraries that remain in core.
2. Record the baseline commit and dump its RPC names, agent tool names, and i18n keys. Capture
   existing desktop and compact layouts. Keep persisted ids, paths, secrets, and wire names.
3. Add the feature's ESM `package.json` and `server`/`client` entrypoints. Add their relative paths
   to the existing manifest. Preserve all phase 1 metadata and its list order. Regenerate the list.
4. Move handlers and their tests together. Register each existing inbound RPC exactly once
   through `host.rpc`. Move tool installers through `host.agentTools`; preserve tool schemas,
   titles, descriptions, registration order, and approval behavior.
5. Move resource ownership with the handlers. Use a daemon lifecycle for shared services and a
   session contribution for connection-owned streams. Test disable during an outstanding initial
   request, reconnect, repeated toggle, and shutdown. Prove children stop within five seconds.
6. Register client contributions. Leave URL adapters in the route tree. Reuse the same screen
   and panel components for compact and desktop layouts. Gate deep links and secondary entry
   points, including another feature embedding the screen, through the generic host adapter.
7. Remove old imports, dispatcher branches, lifecycle wiring, and tool registration from core.
   Keep authorization in core. Remove phase 1 gates from migrated execution paths; the host owns
   those gates. Retain phase 1 compatibility metadata for old clients.
8. Run `npm run lint`: manifest freshness and production import boundaries run before oxlint.
   Tests may import real host test adapters across the boundary. Production features may import
   only the declared host API; core may import features only through the generated loader.
9. Run focused moved tests and host tests with at most two workers. Build workspace dependencies,
   then root typecheck, lint, server/client builds, web export, iOS/Android export, and the desktop
   web overlay. Verify emitted daemon imports. Do not run the whole local test suite.
10. Compare the contract dumps and web JavaScript bytes with the baseline (at most 5% growth).
    `node scripts/compare-builtin-contracts.mjs <baseline> <out-dir> [plugin...]` compares the
    handled requests, wire names, tool names, and i18n keys; add the feature to its table. Use an isolated daemon home and
    Add the feature's baseline sources to `scripts/compare-builtin-contracts.mjs`; it reads the
    current names from the real registration (`scripts/dump-builtin-registrations.mts`). Use an isolated daemon home and
    `node scripts/compare-builtin-contracts.mjs <baseline> <out> <id>` compares them; add the
    feature's prefixes and phase 1/branch source files to its table. Use an isolated daemon home and
    port, unset every `CLAUDE*` variable, and disable relay/Tailscale. Verify real data, an
    interactive terminal where applicable, live navigation removal within two seconds, disabled
    RPC errors, existing/new agent tool sets, enable, and restart persistence. Record commands,
    timings, screenshots, failures, and omissions before committing the feature separately.
