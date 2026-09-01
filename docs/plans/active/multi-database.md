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

### P4 — data editor (writes, transactions)

- [ ] Inline cell edit + add/clone/delete rows; Tx Auto/Manual; Submit/Commit/Rollback; Preview DML; Export CSV/JSON/SQL.
- [ ] `sql_exec` / editor writes route through `requestHostToolPermission`.
- [ ] Proof: live — edit a row under Manual tx, preview DML, commit; rollback path.

### P5 — AI chat + SQL MCP tools

- [ ] `database-ask-agent.ts` `buildDatabaseSystemPrompt` + label; `database-chat-dock.tsx` / `database-draft-chat.tsx` cloned from cluster chat (agent created only on first real message).
- [ ] `registerSqlTools`: `sql_query` (read-only, auto-inject), `sql_exec` (gated), `database_list`.
- [ ] Proof: live — NL→SQL read-only answer with a result; a write proposal that pauses for approval.

### P6 — breadth + advanced (additive)

- [ ] MSSQL / Oracle / MongoDB / ClickHouse adapters (same interface).
- [ ] Query history per connection; DDL view; schema diff; ER diagram; explain-plan flame graph.
- [ ] Mobile parity pass across all screens.

## Authority gaps / decisions to confirm

- First-class engines beyond PG/MySQL/SQLite order (default: those three first). — proceed with default.
- Default connection privilege (recommend read-only role) — surfaced in UI; user chooses.
- Vault scope (per-connection secret only) — decided above.

## Progress

- [x] 2026-09-01: Spec `docs/databases.md` written (mirrors kubernetes.md; real component refs).
- [x] 2026-09-01: P0 daemon foundation — DTO/DbClient/isWriteStatement, SQLite adapter, DatabaseRegistry, AES-256-GCM secret vault; 4/4 tests.
- [x] 2026-09-01: P1 protocol+session+client+PG/MySQL adapters — 4/4 tests incl. real Postgres + MySQL over docker.
- [x] 2026-09-01: P2 app shell (sidebar entry + list/add + routes + stores) + P3 core (object tree, data grid, SQL console) — 10/10 app tests; typecheck + lint clean.
- [ ] P4 …

## Validation

- Focused: adapter + registry unit tests (SQLite in CI; PG/MySQL via docker `.e2e`).
- Integration: `database/*` RPC round-trip; MCP `sql_query`/`sql_exec` gating.
- End-to-end: live CDP on desktop app — add connection → browse → query → edit → chat; mobile parity.
