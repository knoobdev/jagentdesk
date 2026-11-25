# Databases

The Databases screen is a schema browser, data grid, SQL console and per-connection agent chat,
the same on desktop and mobile. The daemon opens the connections, so the app needs no local
`psql` or `mysql` and the agent can reach a database your phone cannot. It is the `databases`
[built-in](builtin-plugins.md) (on by default). It follows the layout and chat model of
[Kubernetes clusters](kubernetes.md).

Browsing needs no project. Only the chat needs one, because the agent runs in a working directory.

Code: `plugins/databases/` (screens, `database/*` handlers, agent tools). The registry, engine
adapters and secret store stay in `packages/server/src/server/database/` because SSH remote
databases use them.

## Connect

1. Open **Data** from the sidebar's Tools group.
2. Press **Add connection**, pick an engine, and enter host, port, database, user and password,
   or a connection string (DSN), or for SQLite a file path.
3. **Save & connect**. A green dot marks a connected database; errors show inline with **Retry**.

A database reachable only from a remote machine can be added through an SSH server
("Add database via this server"); see [SSH servers](ssh.md).

Passwords and DSNs never leave the daemon. They are encrypted with AES-256-GCM under a key file in
`$JAGENTDESK_HOME/databases/` (`FileSecretStore`). Only connection identity and non-secret fields
are written to `$JAGENTDESK_HOME/databases/databases.json`, and nothing secret goes on the wire.

## Engines

Each engine is an adapter behind one `DbClient` interface in
`packages/server/src/server/database/adapters/`, so SQL and introspection stay vendor-exact.

| Engine     | Driver                 | Notes                             |
| ---------- | ---------------------- | --------------------------------- |
| PostgreSQL | `pg` + `pg-cursor`     | server-side cursor                |
| MySQL      | `mysql2`               |                                   |
| SQLite     | `better-sqlite3`       | local file                        |
| SQL Server | `mssql`                |                                   |
| Oracle     | `oracledb` (thin mode) | no Oracle client libraries needed |
| MongoDB    | `mongodb`              | collections and documents         |
| ClickHouse | `@clickhouse/client`   |                                   |

## Browse

**Open** a connection to enter its view. Desktop shows the object explorer, the editor and results,
and the chat dock side by side. Mobile slides in the explorer and opens the chat from a floating
button.

The explorer is a lazily loaded tree: schemas or databases, then tables, views, routines and
sequences; a table expands to columns (type, PK / FK / NOT NULL) and keys and indexes. A table opens
on **Data**; **Structure** shows its definition. The view also has an ER diagram and a full-text
search across tables.

## Edit data

- The grid pages through rows; it never loads a whole table.
- Filter with a WHERE bar that completes columns, operators and connectors. Sort per column.
- Double-click (double-tap on native) a cell to edit. **Add rows**, **Clone**, **Delete**, **Set
  NULL** and **Import CSV** stage changes; the preview shows the DML before it runs.
- **Submit** applies staged changes. In **Manual** transaction mode, pick an isolation level and
  finish with **Commit** or **Rollback**; **Auto** commits each submit.
- **Copy as CSV**, **Copy as JSON** and **Copy as SQL INSERT** copy the result.

Every value is bound as a parameter; no SQL is built by string interpolation.

## SQL console

The console completes table and column names from live introspection. **Run** executes the
statement; a `SELECT` opens a result grid, other statements report affected rows, duration and
errors in **Output**. **Explain** fills **Query Plan**. **History** keeps statements per
connection. A write statement is refused until you turn on **Allow writes**.

## Ask an agent

The chat dock behaves like the cluster chat: the full agent composer, the agent is created on the
first real message, and its title comes from that message and the connection. Database agents carry
the label `jagentdesk.database.id` and are pointed at these tools on the `jagentdesk` MCP server:

| Tool            | Does                                                                          |
| --------------- | ----------------------------------------------------------------------------- |
| `sql_query`     | read-only `SELECT` / `EXPLAIN`                                                |
| `sql_exec`      | writes and DDL; agent-scoped, asks for your approval with the statement shown |
| `database_list` | lists connection ids                                                          |
| `sql_connect`   | registers and opens a connection so it appears in Databases                   |

Connect with a read-only role when you only browse.
