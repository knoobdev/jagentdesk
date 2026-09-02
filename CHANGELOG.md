# Changelog

All notable changes to JAgentDesk are documented here. JAgentDesk uses its own
`0.0.x` version line; the `v1.0.x` tags in history are inherited from the
upstream [Paseo](https://github.com/getpaseo/paseo) fork.

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
