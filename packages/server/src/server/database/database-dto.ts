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
