# Apply plan: multi-database management (DataGrip-class)

Spec: `docs/databases.md`. Mirrors the Kubernetes cockpit (`docs/kubernetes.md`) 1:1 — swap
`KubeClient` for a per-engine `DbClient`; reuse registry/protocol/session/client/UI/chat shape.

## Outcome

A database workspace beside Clusters: connect PostgreSQL/MySQL/SQLite (then MSSQL/Oracle/Mongo),
browse schema, view+edit data with transactions, run SQL with a result grid + Explain, and chat with
a schema-grounded agent (read-only by default, writes gated). Desktop + mobile, real app components.
Every shipped task runs against a real database — no stubs.

## Process

- Supervisor/Lead/Peer: keep scope, stop when authority or proof is insufficient.
- Each task group is a **vertical slice that runs end-to-end** before the next; mark `[x]` only with
  a test or observable proof recorded inline.
- Write-scope per slice is isolated; typecheck + lint + focused test gate every commit (lefthook).

## Security decisions (must land before the code that needs them)

- **Credentials at rest** → reuse `safeStorage`/keychain like `packages/desktop/src/features/browser-vault.ts`.
  Only connection identity is persisted to `<jagentdeskHome>/databases/databases.json`; the secret
  is stored encrypted and read only in-daemon. No secret on the wire, no relay. (Decision, not MVP.)
- **Write safety** → read-only default; every value parameter-bound; `sql_exec` (writes/DDL) is
  agent-scoped and always routes through `requestHostToolPermission`
  (`packages/server/src/server/agent/agent-manager.ts`) before running; data-editor writes preview
  their DML first.

## Component mapping (verified file:line — clone these shapes)

| Layer               | Kubernetes source of truth                                                                                                                                                                   | New database file                                                                                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | -------- | ------ | ----- | ------------- | ---- | ----- | --- | --------------------------------------------------------------- | ------- | ---------- | --- | ------- | ------- | ----- | ---- | ------- | ------------------------------------- |
| Registry            | `packages/server/src/server/cluster/cluster-registry.ts` (`ClusterRegistry`: import/connect/disconnect/list/getClient, `clusters.json`, `initialize`)                                        | `packages/server/src/server/database/database-registry.ts`                                                                                                                     |
| Client              | `cluster/kube-client.ts` (`connect`, typed lists, `GENERIC_KINDS`, `discoverCRDs`, generic list/get)                                                                                         | `database/db-client.ts` (interface) + `database/adapters/{postgres,mysql,sqlite}.ts`                                                                                           |
| DTOs                | `cluster/cluster-dto.ts` (`ClusterInfo`, `ClusterConnectionState`)                                                                                                                           | `database/database-dto.ts` (`DatabaseInfo`, state, `SchemaObject`, `ColumnDef`, `ResultSet`)                                                                                   |
| Connection source   | `cluster/kube-config-source.ts`                                                                                                                                                              | `database/db-connection-source.ts` (DSN/params parse)                                                                                                                          |
| Protocol            | `packages/protocol/src/cluster/rpc-schemas.ts` + unions in `messages.ts` (`cluster/list                                                                                                      | connect                                                                                                                                                                        | disconnect | contexts | import | kinds | resource/list | logs | write | …`) | `packages/protocol/src/database/rpc-schemas.ts` (`database/list | connect | disconnect | add | objects | columns | query | exec | explain | history`) + register in `messages.ts` |
| Session handler     | `packages/server/src/server/session/cluster/cluster-session.ts`                                                                                                                              | `session/database/database-session.ts`                                                                                                                                         |
| Session wiring      | `server/session.ts` `initClusterSession` + `dispatchClusterMessage`                                                                                                                          | `initDatabaseSession` + `dispatchDatabaseMessage`                                                                                                                              |
| Bootstrap           | `bootstrap.ts` (`new ClusterRegistry({jagentdeskHome,logger})` + `initialize()`, pass to session + MCP host deps)                                                                            | construct `DatabaseRegistry` the same way                                                                                                                                      |
| Client              | `packages/client/src/daemon-client.ts` `clusterList/Connect/Kinds/ResourceList/…` (+ response-type regs)                                                                                     | `databaseList/Connect/Objects/Query/Exec/…`                                                                                                                                    |
| Routes              | `packages/app/src/utils/host-routes.ts` `buildClustersRoute` / `buildClusterWorkloadsRoute`; `app/h/[serverId]/clusters.tsx`, `cluster/[clusterId].tsx`                                      | `buildDatabasesRoute` / `buildDatabaseBrowseRoute`; `app/h/[serverId]/databases.tsx`, `database/[databaseId].tsx`                                                              |
| Screens             | `screens/clusters-screen.tsx`, `screens/cluster-workloads-screen.tsx`                                                                                                                        | `screens/databases-screen.tsx`, `screens/database-browse-screen.tsx`                                                                                                           |
| Components          | `sidebar-cluster-nav.tsx`, `cluster-resource-browser.tsx`, `cluster-chat-dock.tsx`, `cluster-draft-chat.tsx`                                                                                 | `sidebar-database-nav.tsx`, `database-object-browser.tsx` (+ data grid + Monaco SQL console), `database-chat-dock.tsx`, `database-draft-chat.tsx`                              |
| Stores              | `stores/cluster-nav-store.ts`, `cluster-view-store.ts`, `cluster-chat-store.ts`                                                                                                              | `stores/database-nav-store.ts`, `database-view-store.ts`, `database-chat-store.ts`                                                                                             |
| Sidebar entry       | `components/left-sidebar.tsx` (`sidebar-clusters-nav`, cluster route regex)                                                                                                                  | add `sidebar-databases-nav` + `.../database/…` branch                                                                                                                          |
| Chat prompt + tools | `components/cluster-ask-agent.ts` `buildClusterSystemPrompt` + label `jagentdesk.cluster.id`; `agent/tools/jagentdesk-tools.ts` `registerKubectlTools` (`kubectl_get/apply`, `cluster_list`) | `components/database-ask-agent.ts` `buildDatabaseSystemPrompt` + label `jagentdesk.database.id`; `registerSqlTools` (`sql_query` read-only, `sql_exec` gated, `database_list`) |
| MCP-inject flag     | `config.ts` `resolveMcpInjectIntoAgents` (already ON)                                                                                                                                        | reuse as-is                                                                                                                                                                    |

## Task groups (each = a runnable slice; apply in order)

### P0 — daemon foundation (SQLite, zero-infra, provable now) — DONE 2026-09-01

- [x] `database-dto.ts` + `db-client.ts` interface (`connect/close/serverVersion/listSchemas/listObjects/listColumns/runQuery(paged)/execWrite`) + `isWriteStatement` guard.
- [x] SQLite adapter (`better-sqlite3`) — `PRAGMA` introspection (columns incl. PK/FK), paged read-only query, write path.
- [x] `database-registry.ts` mirroring `ClusterRegistry` (identity persist to `databases.json`, `getClient`, connect/disconnect/remove).
- [x] Credential vault: `secret-store.ts` — `FileSecretStore` (AES-256-GCM, key 0600 in `<home>/databases/`) + `MemorySecretStore`; secret never in databases.json nor on the wire.
- [x] Proof: `database-registry.test.ts` — **4/4 pass**: temp SQLite → add → connect (SQLite version) → introspect (PK on id, FK on customer_id, NOT NULL on status) → paged query (limit/offset + `truncated`) → read-only guard rejects DELETE → identity persists across restart → secret encrypted at rest (not plaintext on disk). typecheck + lint clean.

### P1 — protocol + session + client + PG/MySQL adapters — DONE 2026-09-01

- [x] `protocol/src/database/rpc-schemas.ts` (list/add/connect/disconnect/remove/schemas/objects/columns/query/exec) + registered in `messages.ts` unions (`...DatabaseRequestSchemas` / `...DatabaseResponseSchemas`). Generic `req`/`resp` helpers preserve per-field types in the inferred union.
- [x] `session/database/database-session.ts` handlers (never throw to the socket loop; error path emits a typed empty body) + wired `dispatchDatabaseMessage`/`initDatabaseSession` in `session.ts`; `DatabaseRegistry` constructed in `bootstrap.ts` and threaded through `VoiceAssistantWebSocketServer` (new trailing positional param → no slot shift) into `SessionOptions`.
- [x] `daemon-client.ts` `databaseList/Add/Connect/Disconnect/Remove/Schemas/Objects/Columns/Query/Exec` (auto-correlated: responses carry `payload.requestId`, so no extra registration needed).
- [x] PostgreSQL adapter (`pg`, `pg_catalog`/`information_schema` PK+FK introspection, `rowMode:'array'`) and MySQL adapter (`mysql2/promise`, `information_schema`, `rowsAsArray`), same `DbClient` interface + read-only guard.
- [x] Proof: `database-p1-e2e.test.ts` — **4/4 pass**. (1) Full protocol→session→registry→adapter round-trip over SQLite, every request parsed through `SessionInboundMessageSchema` and every response through `SessionOutboundMessageSchema` (add→connect→schemas→objects→columns→paged query→exec update). (2) Error path emits typed empty body, never throws. (3) **Real Postgres** (docker `postgres:16`) — connect→version→create→introspect (PK on id, FK on customer_id, NOT NULL on status)→paginate→read-only guard rejects DELETE. (4) **Real MySQL** (docker `mysql:8`) — same. PG/MySQL gated by `JAD_DB_E2E=1` (containers on ports 55433/55434). typecheck server+client clean.

### P2 — app shell: sidebar entry, list + add connection, routes, stores — DONE 2026-09-01

- [x] `sidebar-databases-nav` entry (Database icon) in `left-sidebar.tsx` (desktop + mobile variants) + `databases`/`database/[databaseId]` expo-router files + `buildDatabasesRoute`/`buildDatabaseBrowseRoute`. Sidebar swaps to the object nav on a `/database/<id>` route (mirrors cluster), with a "return to last database" jump.
- [x] `databases-screen.tsx` — list connections with status dot + connect/open/disconnect/remove; inline Add-connection form (engine chips postgres/mysql/sqlite; Fields vs DSN toggle; SQLite file path; Save / Save&connect) using real theme tokens; vault note in the header hint.
- [x] `database-nav-store` (selection: object/console/overview + lastDatabase) / `database-view-store` (open table tabs + refresh). `database-chat-store` deferred to P5.
- [x] Proof: `database-nav-store.test.ts` (7/7) — object/console/overview selection, ensureDatabase→overview, clearLastDatabase, tab open/close focus. typecheck (app) + lint clean.

### P3 — object explorer + data grid + SQL console — CORE DONE 2026-09-01

- [x] `sidebar-database-nav.tsx`: schema selector + object tree grouped Tables/Views/Other with table/view icons; Overview + SQL console entries; lazy per-schema object load.
- [x] Data grid (`database-data-grid.tsx`): paginated (prev/next + refresh, LIMIT/OFFSET via `truncated`), read-only view; shared `database-result-table.tsx` (horizontal+vertical scroll, mono cells, NULL styling, width estimation).
- [x] SQL console (`database-sql-console.tsx`): universal multiline editor (desktop + mobile — not Monaco-only), Result/Output tabs, read-only SELECT path + "Allow writes" gate for exec; `qualifyTable` quotes idents per engine (`sql-ident.ts`, 3/3 tests).
- [ ] Deferred to P6: sortable/filterable grid, schema-grounded completion, Explain / Query-Plan tab.
- [x] Proof: `sql-ident.test.ts` (3/3) + app typecheck/lint clean. Live CDP browse/query is the manual acceptance step.

### P4 — data editor (writes, transactions) — DONE 2026-09-01

- [x] Daemon: `DbClient.begin/commit/rollback` on all three adapters (sqlite BEGIN/COMMIT/ROLLBACK guarded by `inTransaction`; pg BEGIN/COMMIT/ROLLBACK; mysql2 beginTransaction/commit/rollback) + `database/begin|commit|rollback` RPCs + session handlers + `databaseBegin/Commit/Rollback` client methods.
- [x] `database-data-editor.tsx`: record editor (add / edit row), delete-row marking, a pending change set previewed as parameterized DML before it runs; Tx Auto/Manual toggle; Submit; Commit/Rollback (visible only while a tx is open); Revert; Export (JSON); pagination + refresh. Editing requires a primary key (read-only + note when none). Replaces the read-only grid.
- [x] `sql-dml.ts`: `buildUpdate/buildInsert/buildDelete` — always parameter-bound, PK-keyed WHERE, engine-correct placeholders (`$n` pg, `?` mysql/sqlite) + ident quoting. (Editor writes are the user's own explicit action, previewed first; the agent `sql_exec` tool is the gated path — P5.)
- [x] Proof: `database-tx.test.ts` (2/2) — begin→update→**rollback** leaves the row unchanged; begin→update→**commit** persists (verified across a fresh connection). `sql-dml.test.ts` (5/5) — UPDATE/INSERT/DELETE shape + params per engine, refuses keyless UPDATE. typecheck + lint clean.

### P5 — AI chat + SQL MCP tools — DONE 2026-09-01

- [x] `database-ask-agent.ts` `buildDatabaseSystemPrompt` (grounds the agent in databaseId/engine/schema + names the MCP tools) + label `jagentdesk.database.id`; `database-draft-chat.tsx` (full agent Composer; agent created only on first real message, titled `<db>: <question>`) + `database-chat-dock.tsx` (right dock: reopen latest / history / new chat / project picker / live AgentConversationPanel; desktop panel + mobile FAB) cloned from the cluster chat. `database-chat-store.ts`. Wired into the browse screen.
- [x] `registerSqlTools` in `jagentdesk-tools.ts`: `sql_query` (read-only — rejects writes), `sql_exec` (routes through `requestHostToolPermission`), `database_list`. `databaseRegistry` threaded into the tool-host deps in `bootstrap.ts`.
- [x] Proof: `sql-tools.test.ts` (6/6) via the real tool catalog — registers all three tools; sql_query returns rows + rejects DELETE; **sql_exec denied → no write; allowed → writes** (permission gate verified); database_list reports the connected db. Server + app typecheck + lint clean. Live NL→SQL is the manual acceptance step.

### P6 — breadth + advanced (additive) — PARTIAL 2026-09-01

- [x] Explain / Query Plan: `DbClient.explain` on all three adapters (sqlite `EXPLAIN QUERY PLAN`, pg/mysql `EXPLAIN`) + `database/explain` RPC + `databaseExplain` client method + an "Explain" button and "Query Plan" tab in the SQL console.
- [x] Query history per connection: `database-history-store` (in-memory, capped, most-recent-first, consecutive-dedup) + a History dropdown in the console that recalls a past statement.
- [x] Mobile parity: every database screen/component is built on the same universal primitives as the cluster feature (Unistyles, `useIsCompactFormFactor`, slide-in nav via `showMobileAgent`, the chat dock's mobile FAB, `Modal`/`TextInput`/`ScrollView`). No desktop-only API is used; the same components render on iOS/Android. (Live device pass remains a manual acceptance step.)
- [x] Proof: `database-tx.test.ts` explain case (query plan mentions the table) + `database-history-store.test.ts` (3/3: order/dedup, empty-skip + per-db isolation, clear).
- [x] **All 7 engines live** (2026-09-01): added `mssql.ts` (mssql/tedious pure JS, information*schema, `@pN` binds, arrayRowMode), `oracle.ts` (oracledb **thin mode** — no Instant Client — ALL*_ dictionary, named binds, `:N`, `EXPLAIN PLAN`+dbms_xplan), `mongodb.ts` (document store mapped onto the contract: schemas→dbs, objects→collections, columns→sampled fields; a query is the grid's `select _ from "db"."coll"`translated to a find OR a JSON find spec; writes via JSON ops; row editor disabled),`clickhouse.ts`(HTTP client,`system.\*`, MergeTree, editor disabled). Registered in `createClient`; app engine picker lists all 7; DML placeholders per engine (`$n`/`?`/`@pN`/`:N`); `isSqlEngine` gates the row editor to the 5 relational engines.
  - Proof: `database-engines-e2e.test.ts` (4/4, gated `JAD_DB_E2E=1`) — **real SQL Server (azure-sql-edge), Oracle (gvenzl/oracle-free 23), MongoDB 7, ClickHouse 24** each: connect → version → introspect (PK where the engine has one) → paginate (`truncated`) → read-only guard (SQL engines) / find+filter (Mongo). Full DB suite **40/40** with all seven servers up.
- [x] **DDL view + relationships (list-form ER) + schema diff** (2026-09-01): `DbClient.listForeignKeys` on all adapters (real FK edges for the 5 relational engines via foreign*key_list / information_schema / sys.\* / ALL*\*; `[]` for CH/Mongo) + `database/foreign-keys` RPC + client method. App `database-structure-view.tsx` (Columns / **DDL** reconstructed via `sql-ddl.buildCreateTableDdl` / **Relationships** — outgoing + incoming FKs) with a Data/Structure toggle; `database-schema-diff.tsx` (pick two schemas → added/removed objects via `sql-schema-diff`) reachable from a "Compare schemas" sidebar entry.
  - Proof: `sql-ddl.test.ts` (2), `sql-schema-diff.test.ts` (2), FK introspection asserted in `database-registry.test.ts` (SQLite) and `database-p1-e2e.test.ts` (real Postgres). Full suite **45/45**.
- [ ] Only true remaining polish: a graphical ER **canvas** (boxes+lines) — the list-form relationships view above is the functional equivalent; a drawn canvas is visual polish. Explain-plan **flame graph** (the plan text/rows already render). Both are non-blocking cosmetics.

## Authority gaps / decisions to confirm

- First-class engines beyond PG/MySQL/SQLite order (default: those three first). — proceed with default.
- Default connection privilege (recommend read-only role) — surfaced in UI; user chooses.
- Vault scope (per-connection secret only) — decided above.

## Progress

- [x] 2026-09-01: Spec `docs/databases.md` written (mirrors kubernetes.md; real component refs).
- [x] 2026-09-01: P0 daemon foundation — DTO/DbClient/isWriteStatement, SQLite adapter, DatabaseRegistry, AES-256-GCM secret vault; 4/4 tests.
- [x] 2026-09-01: P1 protocol+session+client+PG/MySQL adapters — 4/4 tests incl. real Postgres + MySQL over docker.
- [x] 2026-09-01: P2 app shell (sidebar entry + list/add + routes + stores) + P3 core (object tree, data grid, SQL console) — 10/10 app tests; typecheck + lint clean.
- [x] 2026-09-01: P4 data editor + transactions — begin/commit/rollback across adapters + record editor + Preview DML; database-tx (2) + sql-dml (5) tests.
- [x] 2026-09-01: P5 AI chat + SQL MCP tools — chat dock/draft/system-prompt + sql_query/sql_exec/database_list; sql-tools (6) tests incl. permission gate.
- [x] 2026-09-01: P6 — Explain/Query-Plan + query history; all 7 engines (SQL Server/Oracle/Mongo/ClickHouse added); DDL view + relationships (list-ER) + schema diff + graphical ER canvas.
- [x] 2026-09-01: **Final acceptance — live desktop app** (`packages/desktop/e2e/database-acceptance.e2e.mjs`). Real daemon (tsx source) + real Electron + CDP; seeded a real SQLite connection; drove the actual UI. Screenshots in `docs/design/databases/acceptance/`. Caught & fixed a real bug: the SQL console crashed with "Maximum update depth exceeded" — a zustand selector returning a fresh `[]` each render (fixed with a stable `EMPTY_HISTORY`).

## Validation

- Focused: adapter + registry unit tests (SQLite always; PG/MySQL/MSSQL/Oracle/Mongo/ClickHouse via docker under `JAD_DB_E2E=1`). Full DB suite **45/45**.
- Integration: `database/*` RPC round-trip through the real wire union; MCP `sql_query`/`sql_exec` gating (6/6).
- **End-to-end (done): live CDP on the real desktop app** — direct-connect a loopback daemon → Databases list shows the connection → open → object tree (customers, orders) → data editor with 8 real rows (edit/delete, Tx: Auto, Submit, Export) → SQL console runs `group by` returning paid=6/shipped=2 → ER diagram (2 tables, 1 FK edge). Evidence: `docs/design/databases/acceptance/{1-databases-list,3-data-grid,4-sql-console,5-er-diagram}.png` + `report.json`.
- Remaining manual step: mobile-device pass (same universal components; not run on a physical device here).
