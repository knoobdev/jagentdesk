import mysql from "mysql2/promise";
import type { DbClient, DbConnectionConfig, RunQueryOptions } from "../db-client.js";
import { isWriteStatement } from "../db-client.js";
import type {
  DbColumn,
  DbForeignKey,
  DbObject,
  DbSchema,
  QueryResult,
  ResultColumn,
  SchemaObjectKind,
  WriteResult,
} from "../database-dto.js";

const DEFAULT_LIMIT = 200;
const SYSTEM_SCHEMAS = new Set(["mysql", "information_schema", "performance_schema", "sys"]);

/**
 * MySQL / MariaDB adapter — native `mysql2/promise` driver + `information_schema`
 * introspection. Same `DbClient` contract as the SQLite reference.
 */
export class MysqlDbClient implements DbClient {
  private conn: mysql.Connection | null = null;
  private readonly config: DbConnectionConfig;

  constructor(config: DbConnectionConfig) {
    this.config = config;
  }

  private require(): mysql.Connection {
    if (!this.conn) throw new Error("MySQL connection is not open");
    return this.conn;
  }

  async connect(): Promise<void> {
    this.conn = this.config.dsn
      ? await mysql.createConnection(this.config.dsn)
      : await mysql.createConnection({
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
          user: this.config.user,
          password: this.config.password,
          multipleStatements: false,
        });
  }

  async close(): Promise<void> {
    await this.conn?.end();
    this.conn = null;
  }

  async serverVersion(): Promise<string> {
    const [rows] = await this.require().query<mysql.RowDataPacket[]>("select version() as v");
    const v = rows[0]?.v ?? "";
    return v ? `MySQL ${v}` : "MySQL";
  }

  async listSchemas(): Promise<DbSchema[]> {
    const [rows] = await this.require().query<mysql.RowDataPacket[]>(
      "select schema_name as name from information_schema.schemata order by schema_name",
    );
    return rows.map((r) => ({ name: String(r.name) })).filter((s) => !SYSTEM_SCHEMAS.has(s.name));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const [rows] = await this.require().query<mysql.RowDataPacket[]>(
      "select table_name as name, table_type as type from information_schema.tables where table_schema = ? order by table_name",
      [schema],
    );
    return rows.map((r) => ({
      schema,
      name: String(r.name),
      kind: (String(r.type) === "VIEW" ? "view" : "table") as SchemaObjectKind,
    }));
  }

  async listColumns(schema: string, table: string): Promise<DbColumn[]> {
    const [rows] = await this.require().query<mysql.RowDataPacket[]>(
      `select c.column_name as name,
              c.data_type as data_type,
              c.is_nullable as is_nullable,
              c.column_default as default_value,
              (c.column_key = 'PRI') as is_primary_key,
              (fk.column_name is not null) as is_foreign_key
       from information_schema.columns c
       left join (
         select column_name
         from information_schema.key_column_usage
         where table_schema = ? and table_name = ? and referenced_table_name is not null
       ) fk on fk.column_name = c.column_name
       where c.table_schema = ? and c.table_name = ?
       order by c.ordinal_position`,
      [schema, table, schema, table],
    );
    return rows.map((c) => ({
      name: String(c.name),
      dataType: String(c.data_type),
      nullable: c.is_nullable === "YES",
      isPrimaryKey: Boolean(Number(c.is_primary_key)),
      isForeignKey: Boolean(Number(c.is_foreign_key)),
      defaultValue: c.default_value == null ? null : String(c.default_value),
    }));
  }

  async listForeignKeys(schema: string): Promise<DbForeignKey[]> {
    const [rows] = await this.require().query<mysql.RowDataPacket[]>(
      `select table_name as t, column_name as c,
              referenced_table_schema as rs, referenced_table_name as rt, referenced_column_name as rc
       from information_schema.key_column_usage
       where table_schema = ? and referenced_table_name is not null`,
      [schema],
    );
    return rows.map((r) => ({
      table: String(r.t),
      column: String(r.c),
      refSchema: String(r.rs),
      refTable: String(r.rt),
      refColumn: String(r.rc),
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
    const [rows, fields] = await this.require().query<mysql.RowDataPacket[][]>(
      { sql: paged, rowsAsArray: true },
      options?.params ? [...options.params] : [],
    );
    const columns: ResultColumn[] = (fields ?? []).map((f) => ({ name: f.name }));
    const rawRows = rows as unknown as unknown[][];
    const truncated = rawRows.length > limit;
    const kept = truncated ? rawRows.slice(0, limit) : rawRows;
    const cells = kept.map(toCells);
    return {
      columns,
      rows: cells,
      rowCount: cells.length,
      truncated,
      elapsedMs: nowMs() - started,
    };
  }

  async explain(sql: string): Promise<QueryResult> {
    const started = nowMs();
    const [rows, fields] = await this.require().query<mysql.RowDataPacket[][]>({
      sql: `EXPLAIN ${sql.trim().replace(/;\s*$/, "")}`,
      rowsAsArray: true,
    });
    const columns: ResultColumn[] = (fields ?? []).map((f) => ({ name: f.name }));
    const rowsOut = (rows as unknown as unknown[][]).map(toCells);
    return {
      columns,
      rows: rowsOut,
      rowCount: rowsOut.length,
      truncated: false,
      elapsedMs: nowMs() - started,
    };
  }

  async execWrite(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<WriteResult> {
    const started = nowMs();
    const [result] = await this.require().query<mysql.ResultSetHeader>(
      sql,
      params ? [...params] : [],
    );
    return { affected: result.affectedRows ?? 0, elapsedMs: nowMs() - started };
  }

  async begin(): Promise<void> {
    await this.require().beginTransaction();
  }

  async commit(): Promise<void> {
    await this.require().commit();
  }

  async rollback(): Promise<void> {
    await this.require().rollback();
  }
}

/** Wrap an arbitrary SELECT so paging works without parsing the statement. */
function wrapPaged(sql: string, limit: number, offset: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  return `select * from (${trimmed}) as _paged limit ${Math.max(0, limit)} offset ${Math.max(0, offset)}`;
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
