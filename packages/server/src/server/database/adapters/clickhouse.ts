import { createClient, type ClickHouseClient } from "@clickhouse/client";
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
const SYSTEM_SCHEMAS = new Set(["system", "INFORMATION_SCHEMA", "information_schema"]);

interface JsonCompact {
  meta: Array<{ name: string; type: string }>;
  data: unknown[][];
}

/**
 * ClickHouse adapter — official HTTP `@clickhouse/client` + `system.*`
 * introspection. ClickHouse is analytical/append-oriented and has no relational
 * PK/FK or interactive transactions, so those are reported empty / are no-ops;
 * the row editor is disabled for it (SQL console + read grid still work).
 */
export class ClickhouseDbClient implements DbClient {
  private client: ClickHouseClient | null = null;
  private readonly config: DbConnectionConfig;

  constructor(config: DbConnectionConfig) {
    this.config = config;
  }

  private require(): ClickHouseClient {
    if (!this.client) throw new Error("ClickHouse connection is not open");
    return this.client;
  }

  async connect(): Promise<void> {
    const url =
      this.config.dsn ?? `http://${this.config.host ?? "127.0.0.1"}:${this.config.port ?? 8123}`;
    this.client = createClient({
      url,
      username: this.config.user ?? "default",
      password: this.config.password ?? "",
      database: this.config.database ?? "default",
    });
    // Fail fast so connect() surfaces auth/host errors instead of the first query.
    await this.client.query({ query: "select 1", format: "JSONCompact" });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  private async queryCompact(sql: string): Promise<JsonCompact> {
    const rs = await this.require().query({ query: sql, format: "JSONCompact" });
    return (await rs.json()) as unknown as JsonCompact;
  }

  async serverVersion(): Promise<string> {
    const res = await this.queryCompact("select version()");
    const v = res.data[0]?.[0];
    return v ? `ClickHouse ${String(v)}` : "ClickHouse";
  }

  async listSchemas(): Promise<DbSchema[]> {
    const res = await this.queryCompact("select name from system.databases order by name");
    return res.data.map((r) => ({ name: String(r[0]) })).filter((s) => !SYSTEM_SCHEMAS.has(s.name));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const res = await this.queryCompact(
      `select name, engine from system.tables where database = ${quoteLiteral(schema)} order by name`,
    );
    return res.data.map((r) => ({
      schema,
      name: String(r[0]),
      kind: engineKind(String(r[1] ?? "")),
    }));
  }

  async listColumns(schema: string, table: string): Promise<DbColumn[]> {
    const res = await this.queryCompact(
      `select name, type, is_in_primary_key, default_expression
       from system.columns
       where database = ${quoteLiteral(schema)} and table = ${quoteLiteral(table)}
       order by position`,
    );
    return res.data.map((r) => ({
      name: String(r[0]),
      dataType: String(r[1]),
      nullable: String(r[1]).startsWith("Nullable("),
      isPrimaryKey: Number(r[2]) === 1,
      isForeignKey: false,
      defaultValue: r[3] ? String(r[3]) : null,
    }));
  }

  async runQuery(sql: string, options?: RunQueryOptions): Promise<QueryResult> {
    if (isWriteStatement(sql)) {
      throw new Error("Read-only query path received a write statement");
    }
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const offset = options?.offset ?? 0;
    const started = nowMs();
    const res = await this.queryCompact(wrapPaged(sql, limit + 1, offset));
    return finish(res, limit, started);
  }

  async explain(sql: string): Promise<QueryResult> {
    const started = nowMs();
    const res = await this.queryCompact(`EXPLAIN ${sql.trim().replace(/;\s*$/, "")}`);
    return finish(res, Number.MAX_SAFE_INTEGER, started);
  }

  async execWrite(sql: string): Promise<WriteResult> {
    const started = nowMs();
    await this.require().command({ query: sql });
    // ClickHouse does not report an affected-row count for most statements.
    return { affected: 0, elapsedMs: nowMs() - started };
  }

  async begin(): Promise<void> {
    // ClickHouse has no interactive transactions; the editor gates Manual tx off.
  }
  async commit(): Promise<void> {}
  async rollback(): Promise<void> {}
}

function engineKind(engine: string): SchemaObjectKind {
  if (engine.includes("MaterializedView")) return "materialized_view";
  if (engine.includes("View")) return "view";
  return "table";
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function wrapPaged(sql: string, limit: number, offset: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  return `select * from (${trimmed}) limit ${Math.max(0, limit)} offset ${Math.max(0, offset)}`;
}

function finish(res: JsonCompact, limit: number, started: number): QueryResult {
  const columns: ResultColumn[] = (res.meta ?? []).map((m) => ({ name: m.name, dataType: m.type }));
  const rawRows = res.data ?? [];
  const truncated = rawRows.length > limit;
  const kept = (truncated ? rawRows.slice(0, limit) : rawRows).map(toCells);
  return { columns, rows: kept, rowCount: kept.length, truncated, elapsedMs: nowMs() - started };
}

function toCells(row: unknown[]): Array<string | number | boolean | null> {
  return row.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "object") return JSON.stringify(v);
    return v as string | number | boolean;
  });
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
