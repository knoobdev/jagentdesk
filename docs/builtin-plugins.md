# Built-in feature plugins

Built-in features are statically imported into the daemon and app. They run in the host process;
they do not use the installed-plugin process, client bundle evaluator, or `pluginsEnabled` switch.
Settings → Plugins controls each feature per host. The persisted ids, defaults, dependencies,
capabilities, RPC names, tool names, and data paths are release contracts.

Docker was the phase 2 pilot. Migrated features declare `builtinEntrypoints` in their manifest;
the other feature manifests still describe phase 1 implementations.
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
feature. The facade exposes shared Docker/process primitives and tool types. Per-session
services provide the logger, config store, secret store, SQLite opener, Docker service factory
and remote routing, binary frame codecs, terminal manager, structured push, and binary push.
SQLite paths stay within the daemon's built-in storage directory. Prefix new secret keys and
new database paths with the feature id. Preserve existing storage locations during migrations.

Shared libraries that several features or core subsystems consume stay in core and reach features
as `BuiltinPlatformServices` on the same services object: the SSH service (pool, storage and its
remote Docker/database/cluster/forwarding modules), agent access (labels, cwd and
`requestHostToolPermission`) and the hook that closes SSH dependents. Bootstrap supplies the
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
- `host.agentTools(install)` receives the core tool registrar and a context with the opening
  `callerAgentId` and the daemon services. The host installs tools from the
  agent's captured enabled-plugin set. Do not check live plugin state in a tool handler: existing
  agents retain their opening tool set. Approval and provider tool policy remain in core.
- `host.backgroundService(create)` registers a daemon-owned lifecycle through
  `BuiltinPluginState`. Its `start(signal)` receives a new abort signal for each enable; disable
  aborts it before cleanup. The host rejects start/stop operations that exceed five seconds. Use
  the signal to cancel pending work and bind resource cleanup. The bootstrap starts these
  registrations and stops them during daemon shutdown. Optional `idle()` runs once when the
  daemon starts with the feature turned off, for shared resources that boot opened eagerly.
- A session contribution supplies `handle`, `stop`, and optional `start`. The host owns its
  toggle and disconnect lifetime. `stop` must synchronously invalidate pending work before
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

The server build compiles static feature imports with the monorepo as its TypeScript root, then
`relocate-builtin-build.mjs` preserves the existing published daemon paths and asset locations.
Compiled features live under `dist/server/builtin-features`; raw SDK plugins keep their existing
`dist/server/builtin-plugins` location. Validate emitted ESM imports as well as source tests.

## Client host

Import `BuiltinClientHost` and shared UI/services from
`packages/app/src/plugins/builtin/host-api.ts`. Feature-internal imports stay relative. Shared
UI, theme tokens, terminal rendering, host runtime, and workspace selection stay in core.
Unistyles' Babel configuration includes `plugins/` so migrated styles receive the same transform
on web, iOS, and Android.

`register(app)` can contribute a sidebar destination (`Tools` or `main`), a left drill-in panel,
a route screen, settings sections, mobile drawer entries, composer items, timeline renderers,
tool call cards and attachment sources. A tool call card (`toolCallRenderer`) replaces the
generic rendering of a matching tool call in the chat row (`inline`) or the expanded details
(`details`); the first enabled feature whose `match` returns non-null renders it. Use the same destination metadata for desktop and mobile. Screens
receive the selected `serverId`; never choose the first host inside a migrated screen.
Destinations render in a group at Docker's position unless their id is in
`SLOTTED_BUILTIN_DESTINATIONS` (`surfaces.tsx`); the navigation lists place those at their
historical position so a migration does not reorder the rail. `requiresFeature` keeps a phase 1
`server_info.features` condition for older daemons.

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
    Add the feature's before/after source locations to `scripts/compare-builtin-contracts.mjs`
    and run it with the feature id; it checks names against the protocol's inbound union. Use an isolated daemon home and
    port, unset every `CLAUDE*` variable, and disable relay/Tailscale. Verify real data, an
    interactive terminal where applicable, live navigation removal within two seconds, disabled
    RPC errors, existing/new agent tool sets, enable, and restart persistence. Record commands,
    timings, screenshots, failures, and omissions before committing the feature separately.
