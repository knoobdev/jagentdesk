// Provider-agnostic database DTOs. Every engine adapter returns these shapes, so
// the protocol/session/UI layers stay engine-agnostic — exactly as the Kubernetes
// cockpit is kind-agnostic (see cluster-dto.ts).

export type DatabaseEngine =
  | "postgres"
  | "mysql"
  | "sqlite"
  | "mssql"
  | "oracle"
  | "mongodb"
  | "clickhouse";

export type DatabaseConnectionState = "saved" | "connecting" | "connected" | "error";

/** Persisted + surfaced connection identity. Never carries the secret. */
export interface DatabaseInfo {
  id: string;
  engine: DatabaseEngine;
  displayName: string;
  /** host:port/database or file path — for display only, never the password. */
  target: string;
  state: DatabaseConnectionState;
  serverVersion?: string;
  lastError?: string;
  lastSeen_ms?: number;
  /** The database currently active on the connection (which db the live client is
   *  in). Lets one connection switch between databases on the same server. */
  currentDatabase?: string;
}

/** One database on the server a connection points at (for the DATABASE switcher). */
export interface DbDatabaseName {
  name: string;
  /** True for the database the connection's live client is currently in. */
  current: boolean;
}

export type SchemaObjectKind =
  | "table"
  | "view"
  | "materialized_view"
  | "function"
  | "procedure"
  | "sequence"
  | "collection";

export interface DbSchema {
  /** Schema/namespace/database name (SQLite has a single implicit "main"). */
  name: string;
}

export interface DbObject {
  schema: string;
  name: string;
  kind: SchemaObjectKind;
  /** Best-effort row estimate; omitted when unknown or expensive to compute. */
  rowCount?: number;
  /** Number of columns (shown next to the table in the explorer). */
  columnCount?: number;
}

export interface DbColumn {
  name: string;
  dataType: string;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  defaultValue?: string | null;
}

export interface ResultColumn {
  name: string;
  dataType?: string;
}

/** A foreign-key edge — the adjacency the relationships/ER view is built from. */
export interface DbForeignKey {
  table: string;
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

/** An index on a table (the Indexes node under a table in the explorer). */
export interface DbIndex {
  name: string;
  /** Columns the index covers, in order. */
  columns: string[];
  unique: boolean;
  /** True for the index backing the primary key. */
  primary: boolean;
  /** Access method / type when the engine exposes it (btree/hash/gin/…). */
  method?: string;
}

/** A stored routine — function or procedure (the Routines node under a schema). */
export interface DbRoutine {
  name: string;
  kind: "function" | "procedure";
  /** Return type for functions; omitted for procedures. */
  returnType?: string;
  /** Rendered argument signature, e.g. "(a integer, b text)". */
  arguments?: string;
}

/** A page of query results. Cells are JSON-safe scalars (or null). */
export interface QueryResult {
  columns: ResultColumn[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  /** True when the engine had more rows than the requested page (paginate). */
  truncated: boolean;
  elapsedMs: number;
}

export interface WriteResult {
  affected: number;
  elapsedMs: number;
}
