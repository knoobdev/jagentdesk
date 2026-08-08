# Orchestration UI redesign + live-run fixes

Follow-up to `orchestration-feature.md`. Triggered by user review of the first live run
(README smoke) which surfaced real gaps. Product-contract design image confirmed by the
user (Supervisor-led workspace chat, 3 columns, Lead-plan card, normal composer).

## ORC roles (current)

- Lead / verify: Claude Opus 4.8 (in-process review subagents hang → run inline). Cap 2.
- Coder: DeepSeek `api-box-ds4flash/deepseek-v4-flash[1m]` via `opencode run`.

## Locked design decisions

- **Chat/interaction model** (user-chosen): the workspace composer talks to the
  **Supervisor**. Lead/Peer threads are **view-only while a run is active** (observe
  DeepSeek working without interfering); composer unlocks when the run is idle/complete.
  Rationale: preserves Human→Supervisor→Lead→Peer topology; direct human→Peer chat mid-run
  can derail a bounded assignment / race the running turn.
- **Workspace surface** (from the design image): 3 columns — Workspaces/Projects |
  Agents (role · status · provider/model) | Supervisor chat thread. Composer at the
  bottom, **Enter to send, no separate "Send to Supervisor" button**, no modal/popup.
  A **"Lead plan · N bounded assignments"** card renders in the thread, each assignment
  showing category + `<provider>/<model>` (so DeepSeek vs Claude is visible).

## Server-side fixes (2026-08-08, done + validated via clean daemon restart)

- **#1 inject MCP tools for orchestration agents** — `agent-manager.buildLaunchContext` now
  attaches the JAgentDesk tool catalog when the agent carries `ORCHESTRATION_ROLE_LABEL`,
  regardless of the global `mcp.injectIntoAgents` flag. Built into `dist`, server typecheck green.
- **#2 config persistence** — root cause: the working config lived only in the daemon's memory;
  the dev daemon persists to `.dev/jagentdesk-home/config.json` (not `~/Library/.../daemon/`).
  Triggering one Settings patch flushed the full config (Claude sup/lead, `opencode/api-box-ds4flash/
deepseek-v4-flash[1m]` peer mode=build, `injectIntoAgents:true`) to disk. `daemonConfigStore.patch`
  persists the whole `orchestration` object, so it survives restart.
- **Validation:** restarted the daemon via `window.jagentdeskDesktop.invoke("restart_desktop_daemon")`
  (old pid gone → new pid, home `.dev/jagentdesk-home`). Roster reloaded from persisted config; a
  fresh `/orc` (Vietnamese) then produced real `greet.js`+`greet.test.js` via the DeepSeek peer with
  NO manual patching. Clean-state orchestration confirmed.
- **Mobile form factor** (viewport-emulated): Agents column hidden, "Orchestration" popup button in
  header, Supervisor chat + Lead-plan-in-thread + one composer — all correct.
- **Mobile E2E attempt (2026-08-08) — BLOCKED on two independent environment issues:**
  - _iOS simulator:_ `expo run:ios` → `pod install` fails "Please upgrade XCode". App is React
    Native **0.81.5** (needs **Xcode 16.1+**); host has **Xcode 15.4 on macOS 14.1**, and Xcode 16.1
    itself needs macOS 14.5+. Can't build without a macOS + Xcode upgrade. (Prebuild + the UTF-8
    `pod install` locale fix worked; the version gate is the wall.) `packages/app/ios` is gitignored.
  - _Tailscale:_ daemon tsnet reads the key from the desktop-settings store
    (`daemon-manager.getTailscaleAuthKey` → `JAGENTDESK_TAILSCALE_AUTH_KEY` → `TS_AUTHKEY`). Setting it
    via `patch_desktop_settings` did not land in the store the dev daemon reads, so tsnet came up with
    an empty key + a stale `.dev/jagentdesk-home/tailscale/` state dir → "awaiting interactive login"
    → `tsnet.Up: context deadline exceeded` → bridge exits; daemon stays healthy **local-only**.
  - Desktop app + daemon remain healthy throughout (PID 73791 on :6768). Server fixes unaffected.
  - To finish mobile: either upgrade macOS→14.5+/Xcode→16.1+ for the simulator, OR get the auth key
    into the daemon's env/settings (+ clear the stale tsnet state) and connect from a real device.
- **Mobile E2E DONE via EAS cloud build (2026-08-08):** bypassed the local Xcode wall by building the
  `development-simulator` profile on EAS (`eas build -p ios --profile development-simulator`, build
  `acb90477`), then `eas build:run` installed + launched `app.jagentdesk.mobile.debug` on the iPhone 15
  simulator; dev client loaded JS from Metro (:8082) so the uncommitted UI changes applied. The onboarding
  offers a **"Direct connection"** (Host `localhost` / Port `6768`) that bypasses Tailscale — the sim
  shares the Mac's loopback, so it connected to the local daemon (serverId `srv_DbuiiWdoOsEj`). Deep-linked
  to the orchestration workspace: the mobile app rendered the full feature — "Orchestration" header button,
  Supervisor chat thread, **"Lead plan · 3 bounded assignments"** all on `opencode/api-box-ds4flash/
deepseek-v4-flash[1m]`, single composer. Feature confirmed working on the real mobile app. (Typing a
  fresh /orc into the mobile composer wasn't automatable — RN TextInput needs a real touch, not synthetic
  CGEvent clicks; Pressables like Direct-connection/Connect worked fine. A real finger-tap focuses it.)

## Findings from the first live run (diagnosed)

1. **`mcp.injectIntoAgents` defaulted false** → Supervisor had the contract but not the
   orchestration MCP tools → chain inert. Enabled at runtime for the test. FIX NEEDED:
   orchestration-role agents must always receive the orchestration MCP tools regardless of
   the global inject setting.
2. **DeepSeek peer used an unauthenticated model.** Default/snapshot listed
   `opencode-go/deepseek-v4-flash` (opencode.ai Zen gateway) → HTTP 401 AuthError → fell
   back to Claude peer. The authenticated model is `api-box-ds4flash/deepseek-v4-flash[1m]`
   (user's opencode provider; verified replies "OK"). Config patched to use it. FIX: the
   default orchestration config peer model must be a valid/authenticated id, and the
   Settings UI must let the user pick from the live catalog (below).

## Work items

- [x] DeepSeek config → peer `opencode/api-box-ds4flash/deepseek-v4-flash[1m]` (runtime patch)
- [ ] Settings: provider+model **dropdowns** from live provider snapshot (custom = manual) + scroll fix so profile/route selects aren't hidden under the footer. (DeepSeek)
- [x] Workspace: desktop shows the inline 3-column layout — Workspaces | **Agents column**
      (`OrchestrationAgentsColumn`, role · provider/model · status, tap a role to open its
      thread) | Supervisor chat with the **one normal composer**. No header button, no modal,
      no second composer on desktop; start a run via `/orc …` in the composer. Column mounts
      only when the workspace has ≥1 orchestration-role agent (`useWorkspaceOrchestrationRosterCount`).
      Verified live via CDP: Supervisor(claude) / Lead(claude) / Peer·impl(**deepseek**,
      `api-box-ds4flash/...`) + Lead-plan card all visible; single composer at the bottom.
      Mobile keeps the `WorkspaceOrchestrationPanel` sheet (3 columns don't fit).
      REMAINING refinements (deferred, confirm with user): (a) Lead-plan card currently lives
      in the Agents column, not inline in the thread; (b) Lead/Peer composer is not yet
      forced view-only while a run is active.
- [ ] (code) orchestration agents always get their MCP tools (finding #1) so it works
      without manually flipping `mcp.injectIntoAgents`.
- [ ] Rebuild desktop dev; live E2E with a Vietnamese prompt to build a todo web app;
      confirm the Peer is actually DeepSeek (`api-box-ds4flash/...`), capture screenshots.

## Evidence bar

Live run driven from the app: Supervisor(claude) → Lead(claude) → Peer(**deepseek**,
authenticated) → handback → accept, with the Peer's provider visible in the UI and the
todo app files actually produced. No faked green.

## Live E2E result (2026-08-08, todo web app, Vietnamese prompt)

Driven entirely from the desktop app via `/orc` (composer → Supervisor). PROVEN:

- Topology enforced end to end: Supervisor(claude-opus-5) relayed via `bootstrap_lead`;
  Lead(claude-opus-5) created a bounded Peer via `create_peer` routeCategory `impl` →
  **DeepSeek `opencode/api-box-ds4flash/deepseek-v4-flash[1m]`** (2nd Peer row + a 2nd Lead-plan
  assignment "Vanilla JS To-Do app (todo.html/css/js)" both visible in the UI).
- Supervisor explicitly did NOT touch the files (thread: "I have not touched todo.html,
  todo.css, or todo.js"); Lead ran an independent validation pass before `accept_result`.
- Real files produced by the DeepSeek Peer in the workspace dir: `todo.html` (form + list),
  `todo.js` (add/toggle/delete + localStorage), `todo.css`. `node --check todo.js` OK;
  HTML wires both assets. Not mock, not placeholder.
- UI verified live: 3-column workspace (Workspaces | Agents roster | Supervisor chat),
  Lead-plan card renders in the Supervisor thread (moved out of the column), single composer,
  no popup/header button. Lead/Peer composer view-only wiring in place.
