# Changelog

All notable changes to JAgentDesk are documented here. JAgentDesk versions its
own release line (now `0.2.0`); the many `v0.1.x`–`v1.0.x` tags in history are
inherited from the upstream [Paseo](https://github.com/getpaseo/paseo) fork and
do not correspond to JAgentDesk releases.

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
  the scrollbar sat at the right edge of the *content* (only reachable after scrolling
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
  attaching to the react-native-web `ScrollView` *instance* instead of its scrollable
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
