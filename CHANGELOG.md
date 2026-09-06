# Changelog

All notable changes to JAgentDesk are documented here. JAgentDesk versions its
own release line (now `0.2.0`); the many `v0.1.x`–`v1.0.x` tags in history are
inherited from the upstream [Paseo](https://github.com/getpaseo/paseo) fork and
do not correspond to JAgentDesk releases.

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
