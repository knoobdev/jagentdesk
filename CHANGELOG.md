# Changelog

All notable changes to JAgentDesk are documented here. JAgentDesk versions its
own release line (now `0.9.14`); the many `v0.1.x`–`v1.0.x` tags in history are
inherited from the upstream [Paseo](https://github.com/getpaseo/paseo) fork and
do not correspond to JAgentDesk releases.

## v0.9.35 — 2026-09-18

Team mode one-shot arming: toggling Team mode on a brand-new workspace now turns the
very first message into a team, instead of silently running it as a solo agent.

### Fixed

- **One-shot Team mode on a new workspace.** Previously, arming Team mode on the
  new-workspace composer and sending the first message created a lone agent and ran the
  prompt as an ordinary turn — the forum never opened. The arming state lived under the
  new-workspace composer's draft key, but the agent is actually provisioned later by the
  workspace draft tab under a different key, so the flag was lost across that handoff. The
  fix carries the armed flag across the handoff and provisions the team correctly:
  - The workspace draft tab now performs the one-shot itself — it creates the real agent
    first, then (when Team mode is armed) opens a forum topic with that **real** agent as
    origin/lead via `forumCreate({ bootstrapLead: true })`, rather than running the prompt
    as a solo turn. Verified live: first message → real agent created → forum topic opened
    with that agent as origin → team bootstrap dispatched → lead starts planning.
  - The composer's team-mode short-circuit is now skipped for parent-managed create
    (draft) composers. A draft has no real agent yet, so routing there would have opened a
    forum whose origin points at a non-existent draft id; team routing now happens after
    the agent exists.
  - The new-workspace screen transfers the armed flag from the composer's draft key onto
    the draft id the workspace tab reads, so the one-shot survives the navigation handoff.
  - Once consumed, the flag is cleared so a follow-up solo agent on the same tab is never
    silently forced into a forum.
- **Team-lead tab stuck on "loading agent title".** A one-shot lead never runs the prompt as
  its own turn, so the usual first-message title generation never fired and its workspace tab
  sat on the loading skeleton forever. The lead is now created with an explicit title derived
  from the brief (same first-line/120-char rule as the forum topic), so the tab reads
  correctly the moment it opens.

### Changed

- Removed a dead `Button` import and marked an unreferenced orchestration handler in the
  new-workspace screen intentionally-unused, clearing two latent lint errors in the file.

## v0.9.34 — 2026-09-18

Team mode follow-up: a live "virtual office", code review integrated into the daemon
core (open-code-review), an in-thread + native "ask the boss" flow, mobile responsive,
and workspace/agent-creation fixes.

### Added

- **Virtual office (OFFICE tab)** — a live, animated scene of the team working: each
  participant is an original vector character at a desk whose pose + status badge are
  derived from the topic (working with a lit monitor + typing bob, reviewing, waiting on
  the boss, talking, shipped ✓, or idle). Built with react-native-svg so it runs on
  desktop and mobile without a GPU dependency (a team is only a handful of agents).
  Architecture informed by petdex/archify (state-machine + lifecycle→pose mapping).
- **Structured code review in the core (open-code-review methodology).** New protocol
  types `ForumReviewFinding` (path + line range + category + severity + content +
  suggestion) and `ForumTaskReview` (role, findings, coverage, verdict); tasks carry
  `reviews[]`. `forum.review_task` now takes structured findings + coverage — the agent no
  longer sets the verdict. The **daemon derives it**: any critical/high finding, or a
  medium in the role's own dimension (BA = maintainability/docs, Tester = test/bug,
  Pentester = security) → `request_changes`; otherwise `approve`. A task is `done` only
  when BA, Tester **and** Pentester all approve; one `request_changes` returns it to
  `in_progress`. The task detail renders a real review panel (per-role verdict + coverage;
  each finding a severity badge + category + file:line + issue + suggestion).
- **Ask the boss** — the team lead now escalates human decisions two ways at once:
  `forum.ask_human` posts the question into the thread (board shows "waiting on boss") and
  the native **AskUserQuestion** tool pops a real prompt in the agent chat. Recording the
  boss's answer as a `decision` clears the pending state.

### Changed

- **Mobile responsive Team screen** (Unistyles `xs`/`md`): the dashboard stats wrap, the
  status donut + legend stack, the kanban goes one-column, the postbit/avatar shrink, post
  headers wrap, and the task-detail modal becomes a near-full-height bottom sheet.
- Team-lead brief rewritten: reviewers follow the open-code-review dimensions with
  evidence-carrying findings, precision-over-recall, a reflection pass, and no
  workspace/cwd argument when spawning peers (peers inherit the lead's workspace).

### Fixed

- **Team-mode peers scattering into duplicate workspaces** — workspace provisioning now
  reuses an existing active workspace for a directory instead of always minting a new one
  when a create resolves via cwd (e.g. an agent-to-agent `create_agent`).
- **Creating a workspace could spawn two agents** — `createAgent` is now idempotent by
  `clientMessageId`; a double dispatch / WS resend returns the already-created agent.
- **Team-mode toggle missing on a new workspace** — the draft composer now renders the
  Team-mode toggle (gated by the `agentForum` host feature).

## v0.9.33 — 2026-09-18

Team mode (Agent Forum) — hand a coding request to a team of agents that plan it,
split it into tasks, assign to each other, and build it, all visible on a new
forum + task-board screen.

### Forum overhaul (vBulletin + Jira feel)

- **vBulletin-style discussion** — posts render Markdown (fenced **code blocks** with a
  clean renderer, inline code, quotes, links, images), with reply/quote, @mentions, and
  👍/👎 **reactions** + a rep score (`forum.vote`). Status/review events are no longer
  posts — they fold into a separate, independently-**paginated activity** stream below the
  opening post. Threads, posts, and activity each paginate on their own, with smooth
  fade-in + skeleton loading.
- **Team dashboard** on the forum index — overview stats plus a tasks-by-status **donut**
  and a tasks-by-epic bar chart (react-native-svg), aggregated from topic summaries.
- **Jira-style board** — all six columns incl. **Done** (wrap-to-fit), epic filter, and a
  **task detail** modal: status, epic, assignee, **reporter**, **hour estimates**
  (~1h/~2h/~4h/~1d/~2d), Markdown description, a **comment thread** (`forum.comment_task`,
  and every role review lands here), and **re-open tracking** (count + reasons from history).
- **Human tone** — the team-lead brief is a human-persona vibe: discuss in the **user's
  language**, real personality + emoji, cite sources when researching, vote when a point
  lands — encouraged, never mandated.
- **Human in the loop** — the lead asks the human through the native **AskUserQuestion**
  prompt (shows in chat) and records the answer back in the thread; `forum.ask_human` +
  `pendingHumanQuestion` back this on the wire.
- **Human management** — delete/manage old topics from the index (`forum/delete`); the
  human can also post + vote in a thread (`forum/post`, `forum/vote`).

### Added

- **Team mode toggle** in the chat composer (Users icon). Turn it on and your next
  coding request opens a **topic**: the daemon hands the agent a team-lead brief and
  it plans the work, breaks it into tasks/subtasks, spawns peer agents, assigns,
  estimates, and moves task status — reusing the existing Supervisor/Lead/Peer
  orchestration + `create_agent`/`send_agent_prompt`. Opt-in per session; combine with
  the Autonomous (∞) toggle for continuous drive within the existing cost caps.
- **"Team" screen** in the main menu (docs/plans/active → completed): a topic list
  (per host, live) and a topic detail with a **kanban task board** (Backlog / To do /
  In progress / Review / Blocked / Done, with assignee + estimate + subtasks) and the
  agents' **discussion thread**. Updates live via `forum.stream`.
- **Agent forum tools** (`forum.post_message`, `create_task`, `create_subtask`,
  `assign_task`, `claim_task`, `estimate_task`, `set_task_status`, `get_topic`) so
  agents run the shared board like a human team. Task status transitions are
  idempotent and the topic status is derived from its tasks (open-code-review
  discipline). Topics persist under `~/.jagentdesk/forums/{topicId}.json`.
- Daemon advertises the new `agentForum` feature; the composer toggle only appears on
  supporting hosts.

## v0.9.32 — 2026-09-17

Session sharing v2 polish — live capability toggles, guest notifications, and management-card
styling.

### Added

- **Live capability toggles reach connected guests** — when the host grants a capability (Files,
  Terminal, Artifacts, model/mode, read-only) from the share sheet, the daemon re-scopes the live
  guest session AND pushes the new capabilities to the guest surface. Tabs appear/disappear and the
  granted panels work immediately — no page reload.
- **Guest access banner** — the guest sees a brief in-app notice ("The host enabled Files &
  changes", "The host made this chat read-only", …) whenever the host changes their access. If the
  active tab's capability is revoked, the guest falls back to Chat instead of a dead panel.

### Fixed

- **Toggling one capability no longer resets the others** — the set-options request used
  `SessionShareCapabilitiesSchema.partial()`, which keeps the `.default(false)` on `readOnly`/
  `artifacts` (zod default trap), so a `{ files: … }` patch silently reset those siblings. Partial
  capability requests now use an explicit no-default schema, so each toggle changes only itself
  (e.g. turning Files off no longer turns Read-only off).
- **"Session is not authorized" after a live grant** — a guest who was already connected kept its
  connect-time scope, so a newly-granted tab's request was denied until reload. The daemon now
  re-scopes live guest sessions on toggle.
- **Shared sessions card styling** — the card's title/rows had no inner padding, so text sat flush
  against the card background and overflowed. It now uses the standard settings row padding. The
  redundant copy inside Settings → Agents is removed (management lives on the dedicated Shared
  sessions page).

## v0.9.31 — 2026-09-17

Session sharing v2 — the guest joins the **real app** (scoped to one agent by the daemon), instead
of a bespoke mini-page (ADR-0019). This supersedes the v0.9.14 guest surface and rolls up the whole
v2 line (0.9.15–0.9.31).

### Added

- **Real-app guest surface (ADR-0019)** — a guest connects a real client to a scoped `/ws` on the
  per-share server using the guest token; the daemon confines it by capability scope + per-agent
  guard + workspace path-containment. The guest sees the same chat, panels, and composer the host
  uses — not a hand-rolled page.
- **Per-share capabilities** — beyond chat (always on), the host can grant **Files**, **Changes**,
  **Terminal**, **model/mode**, **read-only** (chat-only, composer hidden), and **Artifacts**. Each
  defaults **off**. The guest scope gates both inbound requests and outbound frames; file/terminal
  access is contained to the shared agent's workspace.
- **Artifacts canvas** — a dedicated panel that live-renders the substantial fenced blocks the agent
  produces (HTML/SVG in a sandboxed iframe, Mermaid diagrams, Markdown, code), derived from the
  timeline the guest already has — no extra daemon scope.
- **Dedicated "Shared sessions" page** — manage every live share across connected hosts from the
  main menu (outside a chat and outside Settings), showing each guest's device and a live
  **typing…** indicator per agent.
- **Pairing code countdown** — the 6-digit code shows a live expiry countdown with a refresh path.

### Changed

- **Guests cannot fork or re-share** — the assistant fork menu (both the completed-turn and
  in-flight-turn footers) and the Share button are hidden on the guest surface; `fork_context` and
  the host share RPCs are out of the guest scope regardless.
- **Presence typing reaches the host** — the guest signals typing from the composer draft; the
  daemon flips `member.typing` and re-emits the share so the host (chat manage sheet and the global
  Shared sessions page) sees who is typing on which agent.

### Fixed

- **Model/mode change no longer fails** with `Session is not authorized for
switch_agent_provider_request` when the host granted "change model & mode" — the guest scope now
  includes the provider/thinking/feature switch request+response types.
- **Guest reconnects** through idle, screen-lock, network changes, and browser refresh (F5): the
  guest token persists and remote (tunnel) guests are exempt from the non-tailnet local-retry cap
  that used to disable reconnect after three tries.
- **Shared sessions screen renders the full app shell** — the left sidebar (and every nav entry:
  Home, Schedules, Settings, workspaces, …) stays mounted on `/shared-sessions`, matching
  `/sessions` and `/schedules`. It was previously a full-screen page with no sidebar and no way back
  (the route was missing from the layout's app-chrome allowlist); now you can navigate away normally.
- **Artifacts tab no longer crashes the app** (React #185 infinite render loop) when opened over a
  non-empty timeline — the canvas now selects a stable store reference and derives artifacts in a
  memo instead of returning a fresh array from the store selector each render.
- **Windows desktop build** — the desktop `build:renderer` script set its env var with bash-only
  inline syntax (`VAR=value cmd`), which npm runs through `cmd.exe` on Windows and fails; it now uses
  `cross-env`, so the Windows release binary builds again (macOS/Linux were unaffected).

## v0.9.14 — 2026-09-16

Session sharing — hand one agent chat to someone outside your tailnet through a
web link, with your approval and a 6-digit code.

### Added

- **Session sharing (spec §21 / ADR-0018)** — a **Share button** in the chat
  composer turns the current agent's chat into a public **Cloudflare quick-tunnel
  web link**. A guest opens it **in any browser — no app install** — asks to join,
  and (once you approve) enters a **6-digit code** to chat in that session. Default
  **OFF**; enable it in **Settings → Host** (takes effect after the daemon restarts).
- **Host approves every guest** — when someone asks to join, an **Accept/Reject
  dialog pops up automatically on every one of your devices** (desktop + mobile).
  The 6-digit code is minted by the **daemon** (single source) so the dialogs never
  hand out conflicting codes. Reject, or **Kick** / **Stop sharing** at any time.
- **Presence** — you see each guest viewing, and who is **typing…**, live; the guest
  sees the agent's turns stream in as you do.
- **Scoped by construction** — the tunnel exposes only a bespoke, minimal guest
  surface for that **one agent** (read its transcript, send prompts, presence) — not
  the daemon's main `/ws`, no other agent, no files/terminal/git/config.
- **Dangerous actions still ask you** — a guest-triggered turn runs under the real
  agent; any permission request routes to the **host app**, never the guest (the
  guest isn't a trusted session).
- **Model/mode stays yours by default** — guests can't change the agent's model or
  mode unless you flip **"Let guests change the agent's mode"** in the share sheet
  (`allowGuestModelMode`, off by default). Even then the daemon re-checks the grant
  on every change — the hidden control isn't the guard.
- **Ephemeral + revocable** — the tunnel is a child process of the daemon: stopping
  the share or the daemon kills it and the URL dies; shares expire after 60 minutes.
  Needs `cloudflared` on the host; if it's missing, sharing reports `cloudflared_missing`
  with install guidance.

## v0.9.13 — 2026-09-16

Autonomous run — keep an agent working unattended, reacting to events over time.

### Added

- **Autonomous run (spec §20 / ADR-0017)** — a **∞ toggle** in the chat composer
  turns on _autonomous mode_ for the current agent. The daemon re-invokes the
  **same agent/session** turn after turn (keeping its open browser tab + context)
  so it keeps working toward what you asked — one agent driven back-to-back, **not**
  cron/schedule.
- **Reacts over time, not one batch** — when the agent reports "nothing to do
  right now" (e.g. waiting for replies) the run does **not** stop; it stays alive,
  re-checks on a growing backoff (30s→5m), and acts when something new appears.
  Only a genuine `done`, the user turning it off, repeated errors, or hidden safety
  caps (2000 turns / 12h / \$50) end it.
- **Never repeats work** — a compact, durable `doneItems` record lives on disk
  (`$JAGENTDESK_HOME/autoruns/{agentId}.json`), is fed back into every turn, and
  survives context compaction + daemon restart, so the agent skips what it already did.
- **User keeps control** — off by default (`daemon.autorun.enabled`, Settings toggle,
  restart to apply); autonomous never changes the model or mode you chose in the composer.
- **Protocol/UI** — `autorun.start/stop/get {agentId}` + `autorun.list` + `autorun.stream`
  events; capability `features.autorun` (+ `features.autorunApproval`); a per-agent toggle
  in the composer (`AutonomousControl`), a Settings opt-in card, and a stopped-run push.

## v0.9.12 — 2026-09-15

Forge Hub readability + a workspace-creation fix.

### Fixed

- **New workspace no longer occasionally creates two agents** — a submit race
  (two events both passing the async guard) could create a duplicate
  workspace/agent; the submit is now guarded synchronously.
- **Pipeline logs are readable** — the raw runner output (ANSI colour codes like
  `\x1b[0;m`, erase-line codes, GitLab `section_*` fold markers) is now parsed and
  rendered with real colours, a line-number gutter, and a **Refresh** button; the
  Copy action emits clean, escape-free text.
- **Code viewer has line numbers** — the file viewer shows a line-number gutter
  alongside syntax highlighting, and the code font is a bit larger.
- **Pull requests show real conflict status** — merge/conflict now comes from the
  forge (previously it only checked "is the PR open"), with a conflict banner in the
  detail and a "conflict" chip in the list; the Merge button is disabled on conflict.
- **Pull request tab counts show up front** — Commits / Files-changed counts come
  from the list where the forge provides them, instead of only after opening a tab.
- **Switch-repo loading placeholder on mobile** — the skeleton shows whenever repos
  are still loading and an account is connected.

### Added

- **Author on Pipelines & Releases** — the run-detail shows who triggered a pipeline
  (GitHub + GitLab); releases show who published them.
- **Resizable Forge assistant** — the desktop assistant is a first-class right dock,
  open by default, with a drag handle to resize and a toggle to collapse it.

## v0.9.11 — 2026-09-13

Repository Members management, plus mobile Forge navigation upgrades.

### Added

- **Members** — a new per-repo section to manage who has access: list members
  (avatar · name · handle · role) and **invite** by username with a neutral role
  (Read · Triage · Write · Maintainer · Admin), or remove a member. Works across
  GitHub and GitLab (Bitbucket lists best-effort); driven by new
  `forge.member.list/add/remove` RPCs. Reachable from the sidebar, the mobile
  section tabs, and an Overview quick-link.
- **Always-visible section tabs on mobile** — a horizontal, scrollable tab strip
  (Overview · Code · Commits · Pull requests · Pipelines · Releases · Issues ·
  Members) now sits in the content header on every repo screen, so switching
  sections no longer means backing out to the nav menu. Opening a repo still lands
  on Code.

### Fixed

- **Clearer "Switch repo" loading state** — the sidebar quick-switch list now shows
  a repo-shaped skeleton (badge block + name bar) while repositories load, on both
  desktop and mobile, instead of appearing empty.

## v0.9.10 — 2026-09-13

Forge Hub polish: Issues get real bodies and comments, and a batch of mobile
layout fixes across Pipelines, Pull requests, Commits, Connections, and the chat
assistant.

### Added

- **Issue detail — body + comments** — opening an issue now shows its full
  description and the comment thread (rendered as markdown), across GitHub, GitLab
  and Bitbucket, instead of just the title. Backed by a new `forge.issue.get` RPC.
  The issues list also shows number, age, author, labels and comment count per row.

### Fixed

- **Issue detail RPC never answered** — `forge.issue.get.request` was missing from
  the daemon's forge-request allowlist in `session.ts`, so the request reached the
  daemon but was never routed to `ForgeHubSession.handle()` — no response was
  emitted and the client timed out (detail showed title only). Now routed.
- **Mobile Pipelines are usable** — pipeline title is legible, the run detail shows
  a stage → job graph, an in-app log viewer (auto-scroll + copy), a clean
  retry/rerun/cancel toolbar and a "Rerun failed jobs" action bar.
- **Mobile Pull request tabs** — Conversation / Commits / Files changed counts now
  populate up front (no tap required) and the tab row scrolls horizontally so the
  last tab is no longer clipped.
- **Mobile Commits** — long commit titles wrap inside the card instead of
  overflowing off the right edge.
- **Mobile Connections** — the accounts table no longer overflows (badge/text
  overlap, cut-off buttons); on compact it stacks into a card. The connection-list
  footer is redesigned into a slim "N connected · Manage" row on desktop and mobile.
- **Loading placeholders** — repo/commit/code lists now show skeletons while
  loading instead of a bare "loading repository" string.
- **Forge assistant repo scope** — after switching repositories, opening the chat
  now targets the currently selected repo with a fresh context, instead of reusing
  the previously selected repo's assistant.

## v0.9.9 — 2026-09-12

Forge Hub: manage GitHub / GitLab / Bitbucket from afar — plus a Forge chat
assistant, mobile support, and a selective port of new features from Paseo 0.8.0.

### Added

- **Forge Hub** — manage **GitHub · GitLab · Bitbucket** (cloud + self‑hosted)
  remotely, like their web apps but inside JAgentDesk: connections (OAuth device
  flow via `gh`/`glab`, or PAT/API token stored encrypted in the daemon secret
  store), a repositories browser across all accounts, **Code** (server‑side file
  tree), **Commits**, **Pull/Merge requests** (list · review · merge/squash/rebase
  · auto‑merge), **Pipelines/CI** (run → stage → job → log, rerun/cancel,
  artifacts), **Releases & tags**, and **Issues**. Not local git — it drives the
  forges' own APIs (`gh`/`glab` CLIs + Bitbucket REST) from the daemon; tokens
  never leave it.
- **Forge assistant (chat agent)** — a chat panel inside Forge that operates the
  forges via `forge_*` agent tools (list repos/PRs/pipelines/issues, read files &
  commits; and gated writes: comment, create issue, rerun pipeline, merge PR,
  create PR — each write asks for pairing approval). The `forge_*` tools are in the
  shared agent tool catalog, so any workspace agent can use them too. On mobile a
  floating chat widget opens the assistant from anywhere in Forge.
- **Paseo 0.8.0 selective port** — Gajae Code ACP provider, Android Studio editor
  target, and a `workspace rename` CLI command (rebranded; additive only). Full
  gap analysis + remaining plan tracked separately.

### Fixed

- **Forge on mobile now renders** — the compact layout stacked the nav over the
  content pane and squeezed it to zero height, so opening a repo showed nothing;
  compact now uses a master‑detail (nav ⟷ content) and the repo Code/Commits views
  render. The sign‑in/card/log backgrounds were hard‑coded to the mockup's dark
  colours and showed as black boxes on the light theme — they now use theme tokens
  and adapt. The detail toolbar clears the status bar, and the wide repo/commit
  tables collapse into readable stacked rows on phones.
- **Removing a Forge connection clears its repos** — the Switch‑repo list, the
  jump‑to‑repo filter, and any open repo from the removed account are now reset
  instead of leaving a stale list.

## v0.2.8 — 2026-09-08

Data-grid column correctness + sidebar record counts.

### Fixed

- **Values are under the right columns** — the grid built its headers from schema
  introspection (`databaseColumns`) but its rows from `select *`, and the two can
  return columns in different orders, so cells landed under the wrong headers (and
  PK-keyed edits/deletes could target the wrong cell). The grid now orders columns by
  the actual query result and looks up type/PK/FK metadata by name, so header ↔ cell
  always match. This was a data-ordering bug, not the earlier scroll issue.
- **Sidebar shows the record count, not the column count** — each table/view in the
  object tree showed its _column_ count, which read as a wrong row count. It now shows
  the estimated **record** count (Postgres planner estimate, DataGrip-style, compact
  like `12.3k`), falling back to the column count on engines that don't report one yet.

## v0.2.7 — 2026-09-08

Database explorer: an interactive ER canvas and DataGrip-style open-object tabs.

### Added

- **ER diagram is a real canvas** — plain mouse-wheel zooms centered on the cursor (no
  modifier), dragging empty space pans, and dragging a table card moves just that table
  (its foreign-key edges follow while the others stay put). Mobile gets pinch-to-zoom,
  one-finger pan, and card dragging. Built on a single viewport transform (translate +
  scale) instead of nested scroll views; the +/−/reset buttons remain.
- **Open tables/views as tabs** — opening a table, the SQL console, the ER diagram, or
  search now adds a tab to a strip above the content pane; click a tab to switch back,
  and ✕ to close it (closing the active tab moves to a neighbour, or the overview when
  none are left). Data/Structure stays as the sub-toggle within a table tab.

## v0.2.6 — 2026-09-08

Data-grid correctness + right-click menu (follow-ups to the v0.2.5 scroll rewrite).

### Fixed

- **Columns no longer misalign when scrolled sideways** — v0.2.5 pinned the header
  with `position:sticky`, which did NOT track horizontal scroll, so once you scrolled
  right the values drifted under the wrong headers. The header now lives in its own
  horizontal viewport whose scroll offset is driven to match the body, so header and
  rows share the exact same horizontal position and columns always line up (both
  scrollbars still pin to the viewport edges).
- **No more green focus ring / selected-cell box** — the focus outline on the grid is
  suppressed, and a selected cell now shows a subtle tint instead of an accent border.
- **Clicking a row number after a cell no longer leaves two selections** — a plain row
  select clears the single-cell marker, so you don't end up with a highlighted cell in
  one row and a selected different row.

### Added

- **Right-click menu on the grid (web)** — replaces Electron's default page menu with a
  DataGrip-style menu: Copy value, Copy row, Go to referenced row (on a foreign key),
  Open record, and (editable tables) Set NULL / Delete row.

## v0.2.5 — 2026-09-08

Database grids scroll like DataGrip, and the SQL console got a real UI.

### Fixed

- **Vertical scrollbar is pinned to the viewport (both grids)** — the table data view
  and the SQL result table nested a vertical scroller inside the horizontal one, so
  the scrollbar sat at the right edge of the _content_ (only reachable after scrolling
  fully right). On web both grids now use a single `overflow:auto` container with a
  `position:sticky` header, so both scrollbars pin to the viewport edges, the header
  stays pinned, and columns stay aligned. (Native keeps nested scrollers.) Extracted
  to a shared `GridScroll`.
- **SQL console query editor** — no longer a naked, unbounded textarea that overflowed
  upward; it's a fixed-height, bordered, scrollable editor box.
- **SQL console shows results with a footer** — row count, elapsed ms, column count
  (and a truncated marker) show under the result grid, so you no longer have to switch
  to the Output tab to see how many rows came back. Result rows now have a number
  gutter (`#`).
- **SQL console autocomplete is a vertical dropdown** — columns/tables/keywords in a
  proper list under the editor (↑/↓ to move, Enter/Tab to accept, Esc to close),
  replacing the horizontal chip strip that only worked on the first token.

## v0.2.4 — 2026-09-08

Database-grid follow-ups after v0.2.3 — make the fixes actually land on the desktop.

### Fixed

- **Data grid shows a scrollbar and fills the pane** — the row body's viewport height
  measured 0 via RN `onLayout` inside the horizontal scroll on the packaged desktop
  build, so it fell back to a `70vh` cap: the table ended short with dead space below
  and (on macOS) the overlay scrollbar stayed hidden. The body is now measured with a
  `ResizeObserver` (native keeps `onLayout`), so it fills the available height, and a
  classic always-visible scrollbar is forced for the grid body on web.
- **WHERE filter autocomplete is now context-aware (DataGrip-style)** — instead of a
  flat chip bar mixing column names with literals, the filter shows a vertical dropdown
  that adapts to where the caret is: **columns** at the start / after `AND`/`OR` / after
  `(`, **operators** (`=`, `LIKE`, `IN`, `IS NULL`, …) right after a column, and
  `AND`/`OR` after a complete condition. Picking a column immediately offers operators;
  ↑/↓ navigate, Enter/Tab accept, Esc closes. The phase logic is unit-tested.

## v0.2.3 — 2026-09-07

Database-grid usability + skill auto-load precision.

### Fixed

- **Database grid scrolls vertically on desktop** — the mouse-wheel handler was
  attaching to the react-native-web `ScrollView` _instance_ instead of its scrollable
  DOM node (`getScrollableNode()`), so `scrollTop`/the `wheel` listener silently
  no-op'd and rows couldn't be scrolled down (only sideways). It now targets the real
  node, and on web the row body keeps a bounded height even before the viewport is
  measured, so it always overflows and scrolls.
- **WHERE filter now has autocomplete and a real input** — typing in the filter bar
  suggests the current table's **column names** first, then WHERE operators/keywords
  (`and`, `or`, `is null`, `in`, `like`, `between`, …); picking one inserts it (quoting
  mixed-case/reserved identifiers). The field is now a proper bordered input instead of
  a bare label + naked text field.
- **Skill auto-load no longer injects unrelated skills** — auto-matching fired on a
  single incidental description-word overlap (and was uncapped), so a skill used in one
  chat (e.g. the database chat) could bleed its context into an unrelated workspace
  chat. Auto-load now requires a strong signal — a tag or name hit, or ≥2 description
  hits — and is capped to 3 skills per message. Manual attachment is unchanged.

## v0.2.2 — 2026-09-07

Usage-cost clarity + agentic-browser extension fixes.

### Added

- **Prompt-cache savings in Usage & Cost** — the dashboard now shows how much prompt
  caching saved: an aggregate "served N tokens from cache · saved ≈ $X (estimated)"
  line, plus per-model and per-agent cached-token counts and estimated savings.
  Estimate-only (from a static per-model price table keyed on cache-read ≈ 0.1–0.5×
  input); the headline COST stays provider-reported. Deep research (Claude Code
  harness + provider docs) confirmed the CLIs already auto-optimize caching/TTL, so
  JAgentDesk surfaces the benefit rather than overriding the CLI (which would raise
  cost for API-key users) — see docs.

### Fixed

- **Agent-loaded extensions now inject** — after `browser_load_extension` (or a
  profile with extensions activates), the open browser guests are reloaded so the
  extension's content scripts actually run; previously they only applied to a tab
  opened afterwards.
- **Usage & Cost no longer looks inflated** — cache-READ tokens (the cached context
  re-read every turn) are excluded from the TOKENS total and shown separately, so a
  session no longer reads tens of millions of tokens next to a ~200k context window.
- **Fingerprint-profile detail box** — the expanded profile details (User-Agent,
  WebGL, etc.) stack cleanly instead of overflowing a fixed-width label column.

## v0.2.1 — 2026-09-06

Agentic-browser follow-ups: more agent tools, browser tools on by default, and a
batch of fixes found testing v0.2.0.

### Added

- **Agent browser customization tools** — `browser_cdp` (raw Chrome DevTools
  Protocol: inject scripts before page load to bypass CSP, intercept requests, drive
  any DevTools domain), `browser_scaffold_extension` (write a working MV3 extension
  skeleton) + `browser_load_extension` (load it), so an agent can author and run its
  own Chromium extension for event-driven page work instead of cron polling.
- **More fingerprint-profile tools** — `browser_profile_update` (change proxy /
  timezone / locale / extensions / init scripts / spoofing / WebRTC on an existing
  profile) and `browser_profile_delete`.
- **Fingerprint profiles UI** now shows each profile's fingerprint (User-Agent,
  WebGL, timezone, screen, seeds, …), lets you configure a **proxy** (server + auth),
  toggle spoofing, and cycle the WebRTC policy.
- **Browser tools are ON by default** — agents can drive the agentic browser out of
  the box (set `browserTools.enabled: false` to turn off).

### Fixed

- **Browser tools no longer disable themselves** — editing/selecting/deleting a
  fingerprint profile patched the daemon config in a way that silently reset
  `browserTools.enabled` to false (a `.partial()` schema still applied the field
  default), so any action in the profiles box turned browser tools off. Config
  patches now leave `enabled` untouched unless explicitly set.
- **Fingerprint profiles card** layout/text no longer overflows.
- **Default/starter skills removed** — the store no longer seeds K8s Doctor / PR
  Reviewer / E2E Browser Tester, and pristine leftovers from older builds are
  removed once on upgrade (a starter you trained is kept). `create_skill`'s
  description now steers agents to create a JAgentDesk skill (shown in the Skills
  screen) instead of a model-native skill file.
- **Database grid — clear selection by tapping outside** now works on mobile
  (native tap), not just desktop.
- **Mobile Tailscale reconnect** — returning to the app after the screen was off no
  longer sticks on "reconnecting"; a resume now force-reconnects (drops the stale
  socket + frozen backoff timer) instead of waiting on a suspended timer.

## v0.2.0 — 2026-09-06

The agentic-browser anti-detect release: coherent fingerprint profiles the agent
or user can create, reuse, and switch — plus database-grid and usage fixes.

### Added — Agentic browser fingerprint profiles

- **Coherent fingerprint profiles** — a per-profile device identity (User-Agent +
  UA Client Hints, WebGL vendor/renderer, timezone, locale, screen, hardware,
  seeded canvas/audio noise) generated from real-device templates so no signal
  contradicts another. Stored in the daemon config (`browserTools.profiles` /
  `activeProfileId`).
- **Engine-level spoofing** — the desktop host applies the active profile via CDP
  `Network.setUserAgentOverride` (UA + UA-CH), `Emulation.setTimezoneOverride` /
  `setLocaleOverride`, and a before-page init script (webdriver/navigator/WebGL/
  screen + canvas/audio noise) that masks itself as native code.
- **Proxy & WebRTC** — per-profile proxy (the only real way to change the observed
  IP) with authenticated-proxy support, and a WebRTC IP-leak guard
  (`force-proxy` / `disable`).
- **Extensions & custom init scripts** — load unpacked Chromium extensions and
  inject custom JS so the agent can fully customise the browser.
- **UI + agent tools** — manage profiles under **Settings → Host** (list / create
  per-OS / select / delete / “Real identity”); agents get `browser_profile_list`,
  `browser_profile_create`, and `browser_profile_use`.
- **Verified** in real Chromium (playwright) and a real Electron webContents
  (`scripts/verify-fingerprint-electron.cjs`).

### Fixed

- **Database grid selection** — selection and staged deletes are keyed by a stable
  row identity (primary key), so they persist correctly across pages instead of
  “ghosting” onto whatever row reuses an index; clicking outside the table now
  clears the selection (including the last row).
- **Usage & Cost token totals** — `formatTokenCount` kept one fractional digit, so
  large totals no longer collapse (e.g. 1.0m–1.49m all showing “1m”); the headline
  TOKENS, per-model rows, and avg/agent now read at full precision.

### Security

- Removed a hardcoded absolute repo path (username) from `orc/k8s/verify-k8s-e2e.sh`
  and genericised real tailnet/device names in test fixtures.

## v0.0.4 — 2026-09-02

The multi-database (IDE-class) release, plus first-run and mobile
connection fixes.

### Added — Multi-database workspace

- **Multiple databases per connection** — list, switch, and cross-database
  compare (structure + data) on a single server.
- **Seven engines live** — PostgreSQL, MySQL, SQLite, SQL Server, Oracle,
  MongoDB, ClickHouse, behind one provider-agnostic `DbClient` contract.
- **IDE-style explorer** — schemas, tables, columns, indexes, foreign
  keys, views, sequences, routines, with per-node counts (tables per database,
  columns per table).
- **Data grid** — inline cell editing, `WHERE` filter bar, column sort, two-axis
  scroll, clone row, CSV import, export to CSV/JSON/SQL, aggregate view, record
  view, and transaction isolation levels.
- **SQL console** — schema-aware autocomplete, inspections, multiple result
  tabs, `EXPLAIN` / query plan, and query history.
- **Foreign-key navigation** and **full-text search** across textual columns.
- **Graphical ER diagram** (react-native-svg), **DDL view**, and **schema diff**.
- **AI chat with SQL MCP tools** grounded on the live schema.
- **Value editor** as a bottom-docked panel for long text / JSON / BLOB.

### Fixed

- **Desktop host picker draggable** — the first-run Tailscale/Local connect
  screen was the only top-level screen missing a titlebar drag region, so the
  window could not be moved until a host was chosen. It is now draggable.
- **Mobile DB cold-connection race** — over Tailscale the schema tree fired
  introspection (`schemas`/`objects`) before the connection was ready, so tables
  showed empty (only the Routines placeholder) until a manual refresh.
  Introspection now retries while the connection is coming up and the tree fills
  on first open.
- **SQLite in the packaged app** — upgraded better-sqlite3 11 → 13 (N-API).
- **SQL console** infinite-render loop.
- **Mobile deep-link** — load schema/tables after connect lands; gate browse and
  nav fetches on a live host session.
- **Data grid** scrolls on both axes; **SQL console toolbar** wraps instead of
  clipping Query Plan / Output.
- **Chat empty-state** names only what is actually missing.

### Contributors

- **[knoobdev](https://github.com/knoobdev)** — maintainer.
- **Claude** (Anthropic) — feature development & engineering.
- **DeepSeek** — engineering support.
