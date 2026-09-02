# Multi-database management

JAgentDesk ships a database cockpit — a full schema/object browser, a data editor grid, a SQL
console, and a per-connection AI chat — that runs identically on the **Electron desktop app** and
the **iOS/Android app**. It talks to your databases through the daemon's database clients, so the
app never needs a local `psql`/`mysql` and the agent can operate a database the user's laptop can't
reach.

It is built as a **second kind of workspace beside Kubernetes** (`docs/kubernetes.md`): the same
left-sidebar entry pattern, the same three-pane desktop / slide-in mobile shell, and the same
per-resource AI chat dock. Where the Kubernetes cockpit talks to clusters through `KubeClient`, this
talks to databases through a per-engine `DbClient`.

> Browsing a database requires **no project**. Only the AI chat needs a working directory (a
> project), because the agent runs there — identical to the Kubernetes cockpit.

---

## 1. Connect a database

1. Open **Databases** from the left sidebar (a top-level entry beside **Clusters**).
2. The screen lists saved connections. Press **Add connection**.
3. Pick an **engine** (PostgreSQL, MySQL/MariaDB, SQLite, SQL Server, Oracle, MongoDB, ClickHouse),
   then enter host/port/database/user/password — or paste a **connection string (DSN)**, or, for
   SQLite, a **file path**.
4. **Test connection** verifies reachability and reports the server version; **Save & connect**
   stores the connection.

**Credentials never leave the daemon.** The password/DSN is encrypted at rest in the OS keychain
(`safeStorage`, the same store used by the browser vault — `packages/desktop/src/features/browser-vault.ts`)
and is only read inside the daemon to open a connection. Only connection **identity** (id, engine,
display name, host, database, user — never the secret) is persisted to
`<jagentdeskHome>/databases/databases.json`, mirroring how `ClusterRegistry` persists cluster
identity to `clusters/clusters.json`.

A green dot marks a connection **connected**; a failed connection shows the error inline and a
**Retry**. Connection state is `saved | connecting | connected | error`, mirroring
`ClusterConnectionState`.

---

## 2. Browse the schema

Press **Open** to enter the database view. Desktop shows three columns: the **object explorer**
(left rail), the **editor + results** area (center), and the **AI chat dock** (right). Mobile slides
in the object explorer; the chat is a floating button — identical to the Kubernetes cockpit.

The object explorer is a tree: **connection → schemas/databases → tables · views · materialized
views · routines (functions/procedures) · sequences**, and each table expands to its **columns**
with a type and a **PK / FK / NOT NULL** marker, plus its **keys and indexes**. The tree is
searchable and lazily loaded per level (large catalogs do not block).

Introspection is per-engine (PostgreSQL `pg_catalog`, MySQL `information_schema`, SQLite
`PRAGMA table_info`, SQL Server `sys.*`, Oracle data-dictionary views, MongoDB `listCollections`),
returned as a uniform object model — the browser code is engine-agnostic, exactly as the Kubernetes
resource browser is kind-agnostic.

The view opens on an **Overview**: object counts, size, server version, connection health — a
database-at-a-glance landing page before drilling into a table.

---

## 3. View and edit data

Selecting a table (or running a `SELECT`) opens the **data editor grid**.

- **Paginated, never full-table.** Large tables are streamed page by page through a server-side
  cursor with keyset pagination; the toolbar has **first / prev / next / last** and a page-size
  control. Loading a million-row table never hangs the app.
- **Sort and filter** per column; a local filter row; text search on the current page.
- **Inline edit.** Double-click a cell to edit; **add / clone / delete** rows from the toolbar.
- **Transaction control.** A **Tx: Auto / Manual** toggle. In Manual mode edits accumulate as
  pending changes (added / modified / deleted rows are marked) and are applied only on **Submit**,
  committed on **Submit & Commit**, or discarded on **Rollback**. **Preview pending changes** shows
  the exact DML before it runs.
- **Export** the result to CSV / JSON / SQL `INSERT`s.

All edits use **parameter binding** (never string interpolation). Writes obey the safety policy in
§6.

---

## 4. SQL console

A per-connection SQL console (a tab, stored beside the connection like a query file):

- **Editor** with a line-number gutter, a run-statement gutter arrow, syntax highlighting, and
  **schema-grounded completion** (tables, columns, functions from the live introspection). The app's
  existing Monaco editor is reused.
- **Run** the statement (or the selection). Results land in a docked **Services** panel with
  **Output**, **Result**, and **Query Plan** tabs. `SELECT` opens a Result grid (§3); non-data
  statements report affected rows, duration, and errors in Output.
- **Explain plan** renders the plan as an operations tree.
- **Query history** is kept per connection.

---

## 5. AI chat about a database

Every database view has a right-hand **chat dock**, identical in behaviour to the Kubernetes chat
dock (`packages/app/src/components/cluster-chat-dock.tsx`): it shows the **full agent composer**
(model / thinking / permission / @files / commands / skills), creates the agent only when the user
sends a real message, and titles it from that message plus the connection.

The agent is **grounded in the schema**. Its hidden system prompt states which connection it
operates and pins it to the dedicated MCP tools (mirroring how the cluster agent is pinned to
`kubectl_get`/`kubectl_apply`):

- `mcp__jagentdesk__sql_query` — **read-only** SELECT/EXPLAIN against the connection, auto-injected.
- `mcp__jagentdesk__sql_exec` — writes (INSERT/UPDATE/DELETE/DDL); **agent-scoped and gated** (§6).
- `mcp__jagentdesk__database_list` — discover connection ids to pass to the tools.

So the agent turns natural language into SQL, runs it read-only, shows the result, explains a query,
or drafts an index — and any write pauses for the user's approval. Agents are bound to a connection
by the label `jagentdesk.database.id`, mirroring `jagentdesk.cluster.id`.

---

## 6. Safety

- **Read-only by default.** New connections and every AI `SELECT` run read-only. `sql_exec` (any
  write or DDL) is a separate, agent-scoped tool that **always requests the user's permission**
  through the existing host-tool permission gate (`requestHostToolPermission`) before it runs.
- **Parameter binding** on every value; no string-built SQL, no injection surface.
- **Least privilege** is encouraged (connect with a read-only role for browsing).
- **Preview before write.** Data-editor changes show their DML; `sql_exec` shows the statement for
  approval.
- **Audit.** Executed writes are logged.

---

## 7. Supported engines

Shipped as per-engine adapters behind one `DbClient` interface (not an ORM), so vendor SQL and
introspection stay exact:

| Engine          | Driver               | Notes                                     |
| --------------- | -------------------- | ----------------------------------------- |
| PostgreSQL      | `pg` + `pg-cursor`   | streaming server-side cursor              |
| MySQL / MariaDB | `mysql2`             | prepared statements, pooling              |
| SQLite          | `better-sqlite3`     | local file, zero-infra                    |
| SQL Server      | `mssql` (tedious)    |                                           |
| Oracle          | `node-oracledb`      | requires the Oracle client libraries      |
| MongoDB         | `mongodb`            | collections + documents, cursor streaming |
| ClickHouse      | `@clickhouse/client` | streaming                                 |

PostgreSQL, MySQL and SQLite are the first-class set; the rest are additive adapters implementing the
same interface.

---

## 8. Desktop vs mobile

- **Desktop** is the three-column cockpit: object explorer · editor+results · chat dock, with the
  breadcrumb, transaction badge, dense data-editor toolbar, and a status bar.
- **Mobile** slides in the object explorer, shows the result grid full-width, and floats the chat as
  a button — the same responsive rules as the Kubernetes cockpit.

The whole feature is shared app code plus daemon adapters, so desktop and mobile behave identically.
