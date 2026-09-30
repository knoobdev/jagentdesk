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
`>=0.8.0-0 <=0.10.2`), not against the JAgentDesk version. Type-only imports of the host packages
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

## Not wired yet

The runtime accepts these registrations, but the daemon does not dispatch to them. A plugin
that registers one gets a line in its log:
`[jagentdesk] Not supported by this daemon yet, so it will not run: …`

- Lifecycle hooks (`event` and `before` hooks for workspace and agent creation, turns,
  permissions, archive). The workspace and agent managers never call `runtime.emit` /
  `runtime.before`.
- Plugin agent providers (`server/provider`, `server/acp`). The provider registry does not
  read `getProviderRegistrations`.
- Demand-based event delivery to plugin sessions. JAgentDesk sends status to every session.
- `timeline.append` on agent refs, and the upstream client's `observeEvents` subscription API.

The upstream e2e tests for these features are kept in `packages/server/src/server/plugins/`
as skipped tests (`*.e2e.test.ts`), each with the reason in its header comment.
