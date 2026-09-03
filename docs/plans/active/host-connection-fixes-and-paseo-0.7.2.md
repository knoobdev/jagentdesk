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
- [ ] build all packages + build desktop app + build mobile; runtime smoke test
- [ ] merge `port/paseo-0.7.2` → main

## Invariants to preserve

No in-app editor · Tailscale-only (no relay) · orchestration (Supervisor/Lead/Peer) · pairing · DB IDE · K8s cockpit · Skills · Plugins.
