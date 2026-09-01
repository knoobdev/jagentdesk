import type {
  DbColumn,
  DbDatabaseName,
  DbForeignKey,
  DbObject,
  DbSchema,
  QueryResult,
  WriteResult,
} from "./database-dto.js";

/** Opening a connection. The secret lives here only in-memory, in-daemon. */
export interface DbConnectionConfig {
  /** host:port or file path — engine-specific parsing happens in the adapter. */
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** A full connection string (DSN). Overrides the discrete fields when set. */
  dsn?: string;
  /** SQLite: absolute file path. */
  file?: string;
  /** Extra engine options (ssl, etc.). */
  options?: Record<string, unknown>;
}

export interface RunQueryOptions {
  /** Page size. The adapter fetches at most limit+1 rows to set `truncated`. */
  limit?: number;
  offset?: number;
  /** Bound parameters for a parameterized statement (never string-built). */
  params?: ReadonlyArray<string | number | boolean | null>;
}

/**
 * One live connection to a single database. Each engine implements this with its
 * native driver + native introspection (pg_catalog / information_schema / PRAGMA /
 * sys.* / data-dictionary / listCollections). The registry/session/UI never see
 * engine specifics — this is the KubeClient analogue for databases.
 */
export interface DbClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  /** Human-readable server version, e.g. "PostgreSQL 16.2" / "SQLite 3.45". */
  serverVersion(): Promise<string>;

  listSchemas(): Promise<DbSchema[]>;
  /**
   * The databases on this server (postgres/mysql/mssql). Optional — engines with a
   * single logical database (sqlite, oracle service) omit it, so the UI hides the
   * DATABASE switcher. Used to switch which database the connection operates.
   */
  listDatabases?(): Promise<DbDatabaseName[]>;
  listObjects(schema: string): Promise<DbObject[]>;
  listColumns(schema: string, table: string): Promise<DbColumn[]>;
  /** Foreign-key edges within a schema (empty for engines without FKs). */
  listForeignKeys(schema: string): Promise<DbForeignKey[]>;

  /** Read-only query. Adapters must reject writes on this path. */
  runQuery(sql: string, options?: RunQueryOptions): Promise<QueryResult>;
  /** The engine's query plan for a statement (EXPLAIN). Read-only. */
  explain(sql: string): Promise<QueryResult>;
  /** Write path (INSERT/UPDATE/DELETE/DDL). Gated by callers, not here. */
  execWrite(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<WriteResult>;

  /**
   * Explicit transaction control for the data editor's Manual mode. All three
   * run on this connection's single session, so a begin/exec/commit sequence of
   * separate RPCs stays in the same transaction. In Auto mode the editor never
   * calls these — each execWrite autocommits.
   */
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** A statement that mutates data/schema — rejected on the read-only path. */
export function isWriteStatement(sql: string): boolean {
  const head = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trimStart()
    .slice(0, 24)
    .toLowerCase();
  return /^(insert|update|delete|drop|alter|create|truncate|replace|merge|grant|revoke|call|comment)\b/.test(
    head,
  );
}
