import mssql from "mssql";
import type { DbClient, DbConnectionConfig, RunQueryOptions } from "../db-client.js";
import { isWriteStatement } from "../db-client.js";
import type {
  DbColumn,
  DbObject,
  DbSchema,
  QueryResult,
  ResultColumn,
  SchemaObjectKind,
  WriteResult,
} from "../database-dto.js";

const DEFAULT_LIMIT = 200;
const SYSTEM_SCHEMAS = new Set([
  "sys",
  "INFORMATION_SCHEMA",
  "guest",
  "db_owner",
  "db_accessadmin",
  "db_securityadmin",
  "db_ddladmin",
  "db_backupoperator",
  "db_datareader",
  "db_datawriter",
  "db_denydatareader",
  "db_denydatawriter",
]);

/**
 * Microsoft SQL Server adapter — native `mssql` (tedious, pure JS) +
 * `information_schema` introspection. Same `DbClient` contract as the others.
 */
export class MssqlDbClient implements DbClient {
  private pool: mssql.ConnectionPool | null = null;
  private readonly config: DbConnectionConfig;

  constructor(config: DbConnectionConfig) {
    this.config = config;
  }

  private require(): mssql.ConnectionPool {
    if (!this.pool) throw new Error("SQL Server connection is not open");
    return this.pool;
  }

  async connect(): Promise<void> {
    const base: mssql.config = this.config.dsn
      ? mssql.ConnectionPool.parseConnectionString(this.config.dsn)
      : {
          server: this.config.host ?? "127.0.0.1",
          port: this.config.port,
          database: this.config.database,
          user: this.config.user,
          password: this.config.password,
        };
    base.options = { encrypt: false, trustServerCertificate: true, ...base.options };
    this.pool = await new mssql.ConnectionPool(base).connect();
  }

  async close(): Promise<void> {
    await this.pool?.close();
    this.pool = null;
  }

  async serverVersion(): Promise<string> {
    const res = await this.require().request().query<{ v: string }>("select @@version as v");
    const full = res.recordset[0]?.v ?? "";
    const line = full.split("\n")[0]?.trim();
    return line || "SQL Server";
  }

  async listSchemas(): Promise<DbSchema[]> {
    const res = await this.require()
      .request()
      .query<{ name: string }>("select schema_name as name from information_schema.schemata");
    return res.recordset
      .map((r) => ({ name: String(r.name) }))
      .filter((s) => !SYSTEM_SCHEMAS.has(s.name));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const res = await this.require()
      .request()
      .input("schema", schema)
      .query<{ name: string; type: string }>(
        "select table_name as name, table_type as type from information_schema.tables where table_schema = @schema order by table_name",
      );
    return res.recordset.map((r) => ({
      schema,
      name: String(r.name),
      kind: (String(r.type) === "VIEW" ? "view" : "table") as SchemaObjectKind,
    }));
  }

  async listColumns(schema: string, table: string): Promise<DbColumn[]> {
    const res = await this.require()
      .request()
      .input("schema", schema)
      .input("table", table)
      .query<{
        name: string;
        data_type: string;
        is_nullable: string;
        default_value: string | null;
        is_primary_key: number;
        is_foreign_key: number;
      }>(
        `select c.column_name as name,
                c.data_type as data_type,
                c.is_nullable as is_nullable,
                c.column_default as default_value,
                (case when pk.column_name is not null then 1 else 0 end) as is_primary_key,
                (case when fk.column_name is not null then 1 else 0 end) as is_foreign_key
         from information_schema.columns c
         left join (
           select kcu.column_name
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
           where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = @schema and tc.table_name = @table
         ) pk on pk.column_name = c.column_name
         left join (
           select kcu.column_name
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
           where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = @schema and tc.table_name = @table
         ) fk on fk.column_name = c.column_name
         where c.table_schema = @schema and c.table_name = @table
         order by c.ordinal_position`,
      );
    return res.recordset.map((c) => ({
      name: String(c.name),
      dataType: String(c.data_type),
      nullable: c.is_nullable === "YES",
      isPrimaryKey: Number(c.is_primary_key) === 1,
      isForeignKey: Number(c.is_foreign_key) === 1,
      defaultValue: c.default_value == null ? null : String(c.default_value),
    }));
  }

  async runQuery(sql: string, options?: RunQueryOptions): Promise<QueryResult> {
    if (isWriteStatement(sql)) {
      throw new Error("Read-only query path received a write statement");
    }
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const offset = options?.offset ?? 0;
    const started = nowMs();
    const req = this.require().request();
    req.arrayRowMode = true;
    bindParams(req, options?.params);
    const res = await req.query(wrapPaged(sql, limit + 1, offset));
    return finishRows(res, limit, started);
  }

  async explain(sql: string): Promise<QueryResult> {
    const started = nowMs();
    const pool = this.require();
    await pool.request().batch("SET SHOWPLAN_ALL ON");
    try {
      const req = pool.request();
      req.arrayRowMode = true;
      const res = await req.query(sql.trim().replace(/;\s*$/, ""));
      return finishRows(res, Number.MAX_SAFE_INTEGER, started);
    } finally {
      await pool.request().batch("SET SHOWPLAN_ALL OFF");
    }
  }

  async execWrite(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<WriteResult> {
    const started = nowMs();
    const req = this.require().request();
    bindParams(req, params);
    const res = await req.query(sql);
    const affected = Array.isArray(res.rowsAffected) ? (res.rowsAffected[0] ?? 0) : 0;
    return { affected, elapsedMs: nowMs() - started };
  }

  async begin(): Promise<void> {
    // A single-connection transaction model isn't exposed by the pool the same way;
    // the data editor gates Manual tx to SQL engines with per-connection sessions.
    await this.require().request().batch("BEGIN TRANSACTION");
  }

  async commit(): Promise<void> {
    await this.require().request().batch("COMMIT TRANSACTION");
  }

  async rollback(): Promise<void> {
    await this.require().request().batch("ROLLBACK TRANSACTION");
  }
}

function bindParams(
  req: mssql.Request,
  params?: ReadonlyArray<string | number | boolean | null>,
): void {
  if (!params) return;
  params.forEach((p, i) => req.input(`p${i + 1}`, p));
}

/** SQL Server needs an ORDER BY for OFFSET/FETCH; (SELECT NULL) keeps input order. */
function wrapPaged(sql: string, limit: number, offset: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  return `select * from (${trimmed}) as _paged order by (select null) offset ${Math.max(0, offset)} rows fetch next ${Math.max(0, limit)} rows only`;
}

function finishRows(res: mssql.IResult<unknown>, limit: number, started: number): QueryResult {
  const recordset = (res.recordset ?? []) as unknown as unknown[][];
  // In arrayRowMode, `recordset.columns` carries the ordered column metadata
  // (an array or a name-keyed record depending on version) — normalize to names.
  const rawColumns = (res.recordset as { columns?: unknown } | undefined)?.columns;
  const colMetas = Array.isArray(rawColumns)
    ? (rawColumns as Array<{ name?: string }>)
    : Object.values((rawColumns ?? {}) as Record<string, { name?: string }>);
  const columns: ResultColumn[] = colMetas.map((c) => ({ name: c.name ?? "" }));
  const truncated = recordset.length > limit;
  const kept = (truncated ? recordset.slice(0, limit) : recordset).map(toCells);
  return { columns, rows: kept, rowCount: kept.length, truncated, elapsedMs: nowMs() - started };
}

function toCells(row: unknown[]): Array<string | number | boolean | null> {
  return row.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Buffer) return `\\x${v.toString("hex")}`;
    if (typeof v === "object") return JSON.stringify(v);
    return v as string | number | boolean;
  });
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
