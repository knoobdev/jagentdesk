import Database from "better-sqlite3";
import type { DbClient, DbConnectionConfig, RunQueryOptions } from "../db-client.js";
import { isWriteStatement } from "../db-client.js";
import type {
  DbColumn,
  DbObject,
  DbSchema,
  QueryResult,
  ResultColumn,
  WriteResult,
} from "../database-dto.js";

const DEFAULT_LIMIT = 200;

/** SQLite adapter — the zero-infra reference engine (a local file, no server). */
export class SqliteDbClient implements DbClient {
  private db: Database.Database | null = null;
  private readonly file: string;

  constructor(config: DbConnectionConfig) {
    const file = config.file ?? config.database ?? config.dsn;
    if (!file) {
      throw new Error("SQLite connection requires a file path");
    }
    this.file = file;
  }

  private require(): Database.Database {
    if (!this.db) throw new Error("SQLite connection is not open");
    return this.db;
  }

  async connect(): Promise<void> {
    this.db = new Database(this.file, { fileMustExist: false });
    this.db.pragma("journal_mode = WAL");
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async serverVersion(): Promise<string> {
    const row = this.require().prepare("select sqlite_version() as v").get() as { v: string };
    return `SQLite ${row.v}`;
  }

  async listSchemas(): Promise<DbSchema[]> {
    // SQLite has a single implicit schema ("main"); attached DBs would add more.
    const rows = this.require().pragma("database_list") as Array<{ name: string }>;
    return rows.map((r) => ({ name: r.name }));
  }

  async listObjects(_schema: string): Promise<DbObject[]> {
    const rows = this.require()
      .prepare(
        "select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name",
      )
      .all() as Array<{ name: string; type: string }>;
    return rows.map((r) => ({
      schema: "main",
      name: r.name,
      kind: r.type === "view" ? "view" : "table",
    }));
  }

  async listColumns(_schema: string, table: string): Promise<DbColumn[]> {
    const info = this.require().pragma(`table_info(${quoteIdent(table)})`) as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: unknown;
    }>;
    const fkRows = this.require().pragma(`foreign_key_list(${quoteIdent(table)})`) as Array<{
      from: string;
    }>;
    const fkCols = new Set(fkRows.map((r) => r.from));
    return info.map((c) => ({
      name: c.name,
      dataType: c.type || "",
      nullable: c.notnull === 0,
      isPrimaryKey: c.pk > 0,
      isForeignKey: fkCols.has(c.name),
      defaultValue: c.dflt_value == null ? null : String(c.dflt_value),
    }));
  }

  async runQuery(sql: string, options?: RunQueryOptions): Promise<QueryResult> {
    if (isWriteStatement(sql)) {
      throw new Error("Read-only query path received a write statement");
    }
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const offset = options?.offset ?? 0;
    const paged = wrapPaged(sql, limit + 1, offset);
    const started = nowMs();
    const stmt = this.require().prepare(paged);
    stmt.raw(true);
    const rawRows = stmt.all(...(options?.params ?? [])) as unknown[][];
    const columns: ResultColumn[] = stmt.columns().map((c) => ({
      name: c.name,
      dataType: c.type ?? undefined,
    }));
    const truncated = rawRows.length > limit;
    const rows = (truncated ? rawRows.slice(0, limit) : rawRows).map(toCells);
    return { columns, rows, rowCount: rows.length, truncated, elapsedMs: nowMs() - started };
  }

  async execWrite(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<WriteResult> {
    const started = nowMs();
    const result = this.require()
      .prepare(sql)
      .run(...(params ?? []));
    return { affected: result.changes, elapsedMs: nowMs() - started };
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Wrap an arbitrary SELECT so paging works without parsing the statement. */
function wrapPaged(sql: string, limit: number, offset: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  return `select * from (${trimmed}) limit ${Math.max(0, limit)} offset ${Math.max(0, offset)}`;
}

function toCells(row: unknown[]): Array<string | number | boolean | null> {
  return row.map((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Buffer) return `\\x${v.toString("hex")}`;
    if (typeof v === "object") return JSON.stringify(v);
    return v as string | number | boolean;
  });
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
