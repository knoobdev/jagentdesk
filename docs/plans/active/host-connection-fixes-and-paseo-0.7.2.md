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

- [ ] fetch upstream tags; get exact current base; diff base..v0.7.2 --stat
- [ ] triage upstream changes; port valuable ones without breaking JAgentDesk features (DB IDE, K8s, Skills, Tailscale transport, pairing, orchestration, no-editor)
- [ ] remove `paseo` keywords introduced by the port (brand map: getpaseo→jagentdesk, Paseo→JAgentDesk, etc.)
- [ ] typecheck + build + smoke test

## Invariants to preserve

No in-app editor · Tailscale-only (no relay) · orchestration (Supervisor/Lead/Peer) · pairing · DB IDE · K8s cockpit · Skills · Plugins.
