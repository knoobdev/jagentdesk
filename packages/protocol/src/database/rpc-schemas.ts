import { z } from "zod";

// Wire schemas for the multi-database feature. Mirrors cluster/rpc-schemas.ts:
// every request carries a `type` literal + `requestId`; every response is
// `{ type, payload: { requestId, ...data, error } }`.

export const DatabaseEngineSchema = z.enum([
  "postgres",
  "mysql",
  "sqlite",
  "mssql",
  "oracle",
  "mongodb",
  "clickhouse",
]);
export type DatabaseEngine = z.infer<typeof DatabaseEngineSchema>;

export const DatabaseConnectionStateSchema = z.enum(["saved", "connecting", "connected", "error"]);

export const DatabaseInfoSchema = z.object({
  id: z.string(),
  engine: DatabaseEngineSchema,
  displayName: z.string(),
  target: z.string(),
  state: DatabaseConnectionStateSchema,
  serverVersion: z.string().optional(),
  lastError: z.string().optional(),
  lastSeen_ms: z.number().optional(),
});
export type DatabaseInfo = z.infer<typeof DatabaseInfoSchema>;

export const DbSchemaSchema = z.object({ name: z.string() });
export const DbObjectSchema = z.object({
  schema: z.string(),
  name: z.string(),
  kind: z.enum([
    "table",
    "view",
    "materialized_view",
    "function",
    "procedure",
    "sequence",
    "collection",
  ]),
  rowCount: z.number().optional(),
});
export const DbColumnSchema = z.object({
  name: z.string(),
  dataType: z.string(),
  nullable: z.boolean(),
  isPrimaryKey: z.boolean(),
  isForeignKey: z.boolean(),
  defaultValue: z.string().nullable().optional(),
});
export const DbForeignKeySchema = z.object({
  table: z.string(),
  column: z.string(),
  refSchema: z.string(),
  refTable: z.string(),
  refColumn: z.string(),
});
export type DbForeignKey = z.infer<typeof DbForeignKeySchema>;
export const ResultColumnSchema = z.object({ name: z.string(), dataType: z.string().optional() });
const CellSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const QueryResultSchema = z.object({
  columns: z.array(ResultColumnSchema),
  rows: z.array(z.array(CellSchema)),
  rowCount: z.number(),
  truncated: z.boolean(),
  elapsedMs: z.number(),
});
export const WriteResultSchema = z.object({ affected: z.number(), elapsedMs: z.number() });

export type DbSchema = z.infer<typeof DbSchemaSchema>;
export type DbObject = z.infer<typeof DbObjectSchema>;
export type DbColumn = z.infer<typeof DbColumnSchema>;
export type ResultColumn = z.infer<typeof ResultColumnSchema>;
export type QueryResult = z.infer<typeof QueryResultSchema>;
export type WriteResult = z.infer<typeof WriteResultSchema>;

/** The secret (password/dsn) travels once at add-time over the encrypted
 *  transport, then lives only encrypted inside the daemon. */
export const DbConnectionConfigSchema = z.object({
  host: z.string().optional(),
  port: z.number().optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  dsn: z.string().optional(),
  file: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});
export type DbConnectionConfig = z.infer<typeof DbConnectionConfigSchema>;

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── list ──
export const DatabaseListRequestSchema = req("database/list", {});
export const DatabaseListResponseSchema = resp("database/list/response", {
  databases: z.array(DatabaseInfoSchema),
});
// ── add ──
export const DatabaseAddRequestSchema = req("database/add", {
  engine: DatabaseEngineSchema,
  displayName: z.string().optional(),
  config: DbConnectionConfigSchema,
});
export const DatabaseAddResponseSchema = resp("database/add/response", {
  database: DatabaseInfoSchema.nullable(),
});
// ── connect / disconnect / remove ──
export const DatabaseConnectRequestSchema = req("database/connect", { id: z.string() });
export const DatabaseConnectResponseSchema = resp("database/connect/response", {
  database: DatabaseInfoSchema.nullable(),
});
export const DatabaseDisconnectRequestSchema = req("database/disconnect", { id: z.string() });
export const DatabaseDisconnectResponseSchema = resp("database/disconnect/response", {});
export const DatabaseRemoveRequestSchema = req("database/remove", { id: z.string() });
export const DatabaseRemoveResponseSchema = resp("database/remove/response", {});
// ── introspection ──
export const DatabaseSchemasRequestSchema = req("database/schemas", { id: z.string() });
export const DatabaseSchemasResponseSchema = resp("database/schemas/response", {
  schemas: z.array(DbSchemaSchema),
});
export const DatabaseObjectsRequestSchema = req("database/objects", {
  id: z.string(),
  schema: z.string(),
});
export const DatabaseObjectsResponseSchema = resp("database/objects/response", {
  objects: z.array(DbObjectSchema),
});
export const DatabaseColumnsRequestSchema = req("database/columns", {
  id: z.string(),
  schema: z.string(),
  table: z.string(),
});
export const DatabaseColumnsResponseSchema = resp("database/columns/response", {
  columns: z.array(DbColumnSchema),
});
// ── query / exec ──
export const DatabaseQueryRequestSchema = req("database/query", {
  id: z.string(),
  sql: z.string(),
  limit: z.number().optional(),
  offset: z.number().optional(),
  params: z.array(CellSchema).optional(),
});
export const DatabaseQueryResponseSchema = resp("database/query/response", {
  result: QueryResultSchema.nullable(),
});
export const DatabaseExecRequestSchema = req("database/exec", {
  id: z.string(),
  sql: z.string(),
  params: z.array(CellSchema).optional(),
});
export const DatabaseExecResponseSchema = resp("database/exec/response", {
  result: WriteResultSchema.nullable(),
});
// ── foreign keys (relationships / ER) ──
export const DatabaseForeignKeysRequestSchema = req("database/foreign-keys", {
  id: z.string(),
  schema: z.string(),
});
export const DatabaseForeignKeysResponseSchema = resp("database/foreign-keys/response", {
  foreignKeys: z.array(DbForeignKeySchema),
});
// ── explain (query plan) ──
export const DatabaseExplainRequestSchema = req("database/explain", {
  id: z.string(),
  sql: z.string(),
});
export const DatabaseExplainResponseSchema = resp("database/explain/response", {
  result: QueryResultSchema.nullable(),
});
// ── transactions (data editor Manual mode) ──
export const DatabaseBeginRequestSchema = req("database/begin", { id: z.string() });
export const DatabaseBeginResponseSchema = resp("database/begin/response", {});
export const DatabaseCommitRequestSchema = req("database/commit", { id: z.string() });
export const DatabaseCommitResponseSchema = resp("database/commit/response", {});
export const DatabaseRollbackRequestSchema = req("database/rollback", { id: z.string() });
export const DatabaseRollbackResponseSchema = resp("database/rollback/response", {});

export const DatabaseRequestSchemas = [
  DatabaseListRequestSchema,
  DatabaseAddRequestSchema,
  DatabaseConnectRequestSchema,
  DatabaseDisconnectRequestSchema,
  DatabaseRemoveRequestSchema,
  DatabaseSchemasRequestSchema,
  DatabaseObjectsRequestSchema,
  DatabaseColumnsRequestSchema,
  DatabaseForeignKeysRequestSchema,
  DatabaseQueryRequestSchema,
  DatabaseExecRequestSchema,
  DatabaseExplainRequestSchema,
  DatabaseBeginRequestSchema,
  DatabaseCommitRequestSchema,
  DatabaseRollbackRequestSchema,
] as const;

export const DatabaseResponseSchemas = [
  DatabaseListResponseSchema,
  DatabaseAddResponseSchema,
  DatabaseConnectResponseSchema,
  DatabaseDisconnectResponseSchema,
  DatabaseRemoveResponseSchema,
  DatabaseSchemasResponseSchema,
  DatabaseObjectsResponseSchema,
  DatabaseColumnsResponseSchema,
  DatabaseForeignKeysResponseSchema,
  DatabaseQueryResponseSchema,
  DatabaseExecResponseSchema,
  DatabaseExplainResponseSchema,
  DatabaseBeginResponseSchema,
  DatabaseCommitResponseSchema,
  DatabaseRollbackResponseSchema,
] as const;
