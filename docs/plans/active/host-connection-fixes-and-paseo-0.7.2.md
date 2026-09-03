# Host-connection fixes + Paseo 0.6.x→0.7.2 port

Multi-part job requested 2026-09-03. Track here (spans work; recovery).

## Part 1 — Bug: remove all connections → app auto-selects Local on restart

Expected: emptying the registry returns to the Tailscale/Local host-picker; "Add connection" available.
Findings (source ALREADY implements this):

- `host-runtime.ts:2266 removeHost` / `:2289 removeConnection` → `resetConnectionModeWhenHostsEmpty()` (:2282) → `clearConnectionMode()` when `hosts.length===0`.
- `daemon-start-service.ts:40-44` upsert returns early when `connectionMode===null` (no re-seed).
- `index.tsx:62` routes to host-picker when `connectionMode===null`.
- Settings remove button (`settings/host-page.tsx:406`) goes through `removeConnection`.
  Action: runtime repro on a fresh build to confirm stale-build vs a subtle runtime bug; harden if needed.
- [ ] repro (build desktop → add Local → remove all → restart → expect host-picker)
- [ ] fix if real bug

## Part 2 — Bug: Tailscale shows timeout in Connections but green in host list

- Status computed in two places: `host-runtime.ts:2027` and `:2484` (+ display-source `:1657-1662`).
- [ ] unify to a single connection-status source so list + detail agree
- [ ] on startup, if Tailscale timed out → auto-return to host-picker (verify `shouldRedirectToDesktopTailscaleLogin` covers timeout, not just missing mode)

## Part 3 — Feature: backup/restore connections on re-login (MISSING in source)

Expected: returning to host-picker + re-login deletes the old connection but BACKS IT UP, then RESTORES after a successful connect (Tailscale or Local). Workspaces/projects preserved (keyed by host prefix/serverId).

- [x] backup store: host-backups.ts (persist removed HostProfile by serverId) +tests
- [x] restore on re-login: both upsertTailnetConnection + upsertConnectionFromListen route through upsertHostConnection → applyHostBackup
- [x] workspaces/projects already keyed by serverId (not purged on remove) → auto-reunite on same-daemon re-login
- [x] tests (host-backups.test.ts 7/7)

## Part 4 — Port Paseo 0.6.x → 0.7.2 (SELECTIVE, not bulk-merge)

Memory rule: never bulk `git merge upstream`; port per-feature + rebrand. Fork re-rooted history.

Worktree: `hdc/jagentdesk-port` (branch `port/paseo-0.7.2`). Strategy that worked:
rebranded bulk-apply of the 561-file v0.6.1→v0.7.2 delta into a WIP commit, then
per-package subagent triage that **reverts fork-authoritative files to fork HEAD**
where an upstream file references fork-absent APIs (editor, relay, skia diff,
directorySync, row-store cache, `permissions`-model hub, `WorkspaceTabPlacement`),
and **keeps upstream** where it is compatible & additive.

Outcome (typecheck 0 across every package):

- Backend adopted v0.7.2 substantially: **protocol +23 net files** (new message
  schemas, capabilities, `ProviderOptions`/`ToolPolicy`, `AgentTaskItem`,
  `hasOpenAgentTab`, managed-source plugin fields), **server +169 net files**.
- App: **18 new upstream files adopted** (reconnect-toast, pull-request/changes
  panels, keyboard availability, file-change-icon, file-header-presentation, …),
  5 changed, rest kept fork HEAD. **No JAD app file deleted** (verified via comm).
- Hub authz kept on the fork's **scope** model: `daemon-session`/protocol use the
  v0.7.2 `permissions` names; the fork session gate stays `isSessionRpcAllowed`
  (scopes). Bridged at `attachHubSocket` via `hubScopesForPermissions`
  (`hub.execute`→`hub.execution.*`); `updateAttachedPermissions` is a documented
  no-op (hub relationship is vestigial under Tailscale-only, ADR-0001).
- `operation-permissions.ts`: added the 63 inbound + 66 outbound JAD feature
  operations (browser/cluster/database/skills/orchestration/usage/pairing/host-data)
  with conservative levels (daemon infra→daemon.read|manage, pairing→access.manage,
  agent ops→workspace.\*); removed the stray `hub.execution.agent.validate.response`.
- **fontSize.xs→sm regression** (agents wrongly assumed theme dropped `xs`; it did
  not — `xs:12`, `sm:14`) reverted across ~42 files; `fontSize.xs` count back to 360.

- [x] fetch upstream tags; get exact current base; diff base..v0.7.2 --stat (561 files)
- [x] triage upstream changes; port valuable ones without breaking JAgentDesk features
- [x] typecheck 0: protocol, client, server, app, desktop, plugin, highlight
- [x] cli typecheck 0 (reverted hub/plugin/client to fork HEAD Tailscale-only; deleted 3 hub-cloud files)
- [x] remove `paseo` keywords introduced by the port (only guard-test `@paseo/plugin` kept)
- [x] merge port → `fix/usage-plan-skills` (ff); working tree now on the port source
- [x] `npm install` restored deps; **build:server GREEN** (protocol/client/plugin/server
  /cli + Go tsnet-bridge, 0 TS errors) after fixing `supervisor.ts`
  (signalProcessTree→terminateWithTreeKill)
- [x] **build:desktop GREEN**: expo web/electron export (bundle 20.3 MB) + desktop
  package compiled
- [x] reset `port/paseo-0.7.2` to the fixed HEAD (both branches at the same commit)
- [x] desktop runtime smoke (Playwright + real Electron + Metro + daemon): the app
  boots, renderer loads, and renders the host-picker ("Join your tailnet") in full.
  2 `startup.spec` cases fail expecting `startup-splash` under a mocked pending-daemon
  scenario, but every file those tests exercise (index.tsx, _layout.tsx,
  startup-splash-screen, host-route-bootstrap-boundary, desktop-connection-gate,
  startup-dsl, daemon-port) is **byte-identical to the pre-merge baseline 96a86c7ff**
  → NOT a merge regression (pre-existing/env behavior).
- [x] **mobile EAS iOS build GREEN** (profile production-simulator, account
  jagentdesk20262); installed to iPhone 15 simulator, **app boots + renders the
  JAgentDesk home correctly** (brand, layout, fonts — no crash/error modal). Full
  connected DB/chat smoke needs a live daemon + Tailscale pairing (idb tap tooling
  broken on this host); the pairing/routing files are byte-identical to baseline.
- [x] fixed one latent typecheck error surfaced by the fresh plugin dist
  (`plugins/theme.ts` now maps all 11 v0.7.2 PluginTheme color tokens)
- [x] `main` fast-forwarded to the merged HEAD (`5f50e95e5`); all three branches
  (main, fix/usage-plan-skills, port/paseo-0.7.2) aligned. **Not pushed** (user chose
  FF-only). Port worktree removed.

## Final state

All 8 packages typecheck 0 (fresh dist). `build:server` + `build:desktop` GREEN.
Desktop boots (host-picker). Mobile EAS build GREEN + boots on iOS simulator.
`main` = `5f50e95e5`, local-only.

### Incident: node_modules clobbered on ff-merge (fixed)

The pre-existing WIP port commit (`852ee1c52`, from a prior session) accidentally
**git-tracked node_modules as self-referential symlinks** (top-level + 8 per-package,
each `node_modules -> <its own abs path>`, the `//` double-slash betraying a
`$dir/node_modules` script). node_modules was NOT tracked at `96a86c7ff`. When the
ff-merge checked out those symlinks, git replaced the real (gitignored) node_modules
dirs with ELOOP self-symlinks → every build/typecheck broke.

Fix: `git rm --cached` all 9 node_modules symlinks + removed them from the working
tree (commit `faf67a523`); node_modules stays gitignored and untracked. Real deps
restored with `npm install` (the committed `package-lock.json` was stale — missing
the DB-IDE/K8s/new deps: better-sqlite3, mongodb, mssql, mysql2, oracledb, pg,
@kubernetes/client-node, @replit/codemirror-lang-csharp, … — so `npm ci` refused;
`npm install` regenerated the lock).

## Invariants to preserve

No in-app editor · Tailscale-only (no relay) · orchestration (Supervisor/Lead/Peer) · pairing · DB IDE · K8s cockpit · Skills · Plugins.
