import { Client as PgClient, type ClientConfig as PgClientConfig } from "pg";
import type { DbClient, DbConnectionConfig, RunQueryOptions } from "../db-client.js";
import { isWriteStatement } from "../db-client.js";
import type {
  DbColumn,
  DbDatabaseName,
  DbForeignKey,
  DbObject,
  DbSchema,
  QueryResult,
  ResultColumn,
  SchemaObjectKind,
  WriteResult,
} from "../database-dto.js";

const DEFAULT_LIMIT = 200;

/**
 * PostgreSQL adapter — native `pg` driver + `pg_catalog`/`information_schema`
 * introspection. Same `DbClient` contract as the SQLite reference; the
 * registry/session/UI never see Postgres specifics.
 */
export class PostgresDbClient implements DbClient {
  private client: PgClient | null = null;
  private readonly config: DbConnectionConfig;

  constructor(config: DbConnectionConfig) {
    this.config = config;
  }

  private require(): PgClient {
    if (!this.client) throw new Error("PostgreSQL connection is not open");
    return this.client;
  }

  async connect(): Promise<void> {
    const ssl = this.config.options?.ssl;
    this.client = new PgClient(
      this.config.dsn
        ? {
            connectionString: this.config.dsn,
            ...(ssl ? { ssl: ssl as PgClientConfig["ssl"] } : {}),
          }
        : {
            host: this.config.host,
            port: this.config.port,
            database: this.config.database,
            user: this.config.user,
            password: this.config.password,
            ...(ssl ? { ssl: ssl as PgClientConfig["ssl"] } : {}),
          },
    );
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client?.end();
    this.client = null;
  }

  async serverVersion(): Promise<string> {
    const res = await this.require().query<{ version: string }>("select version() as version");
    const full = res.rows[0]?.version ?? "";
    // "PostgreSQL 16.2 on x86_64…" → "PostgreSQL 16.2"
    const match = /^(PostgreSQL\s+\S+)/.exec(full);
    return match ? match[1] : full || "PostgreSQL";
  }

  async listSchemas(): Promise<DbSchema[]> {
    const res = await this.require().query<{ schema_name: string }>(
      "select schema_name from information_schema.schemata where schema_name not like 'pg_%' and schema_name <> 'information_schema' order by schema_name",
    );
    return res.rows.map((r) => ({ name: r.schema_name }));
  }

  async listDatabases(): Promise<DbDatabaseName[]> {
    const cur = (await this.require().query<{ db: string }>("select current_database() as db"))
      .rows[0]?.db;
    const res = await this.require().query<{ name: string }>(
      "select datname as name from pg_database where datallowconn and not datistemplate order by datname",
    );
    return res.rows.map((r) => ({ name: r.name, current: r.name === cur }));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const res = await this.require().query<{ name: string; kind: string }>(
      `select c.relname as name,
              case c.relkind
                when 'r' then 'table'
                when 'p' then 'table'
                when 'v' then 'view'
                when 'm' then 'materialized_view'
                when 'S' then 'sequence'
                else 'table'
              end as kind
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('r','p','v','m','S')
       order by c.relname`,
      [schema],
    );
    return res.rows.map((r) => ({
      schema,
      name: r.name,
      kind: r.kind as SchemaObjectKind,
    }));
  }

  async listColumns(schema: string, table: string): Promise<DbColumn[]> {
    const res = await this.require().query<{
      name: string;
      data_type: string;
      is_nullable: string;
      default_value: string | null;
      is_primary_key: boolean;
      is_foreign_key: boolean;
    }>(
      `select col.column_name as name,
              col.data_type as data_type,
              col.is_nullable as is_nullable,
              col.column_default as default_value,
              coalesce(pk.is_pk, false) as is_primary_key,
              coalesce(fk.is_fk, false) as is_foreign_key
       from information_schema.columns col
       left join (
         select kcu.column_name, true as is_pk
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
         where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = $1 and tc.table_name = $2
       ) pk on pk.column_name = col.column_name
       left join (
         select kcu.column_name, true as is_fk
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
         where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = $1 and tc.table_name = $2
       ) fk on fk.column_name = col.column_name
       where col.table_schema = $1 and col.table_name = $2
       order by col.ordinal_position`,
      [schema, table],
    );
    return res.rows.map((c) => ({
      name: c.name,
      dataType: c.data_type,
      nullable: c.is_nullable === "YES",
      isPrimaryKey: c.is_primary_key,
      isForeignKey: c.is_foreign_key,
      defaultValue: c.default_value ?? null,
    }));
  }

  async listForeignKeys(schema: string): Promise<DbForeignKey[]> {
    const res = await this.require().query<{
      table: string;
      column: string;
      ref_schema: string;
      ref_table: string;
      ref_column: string;
    }>(
      `select tc.table_name as table, kcu.column_name as column,
              ccu.table_schema as ref_schema, ccu.table_name as ref_table,
              ccu.column_name as ref_column
       from information_schema.table_constraints tc
       join information_schema.key_column_usage kcu
         on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
       join information_schema.constraint_column_usage ccu
         on ccu.constraint_name = tc.constraint_name
       where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = $1`,
      [schema],
    );
    return res.rows.map((r) => ({
      table: r.table,
      column: r.column,
      refSchema: r.ref_schema,
      refTable: r.ref_table,
      refColumn: r.ref_column,
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
    const res = await this.require().query({
      text: paged,
      values: options?.params ? [...options.params] : [],
      rowMode: "array",
    });
    const columns: ResultColumn[] = res.fields.map((f) => ({ name: f.name }));
    const rawRows = res.rows as unknown[][];
    const truncated = rawRows.length > limit;
    const rows = (truncated ? rawRows.slice(0, limit) : rawRows).map(toCells);
    return { columns, rows, rowCount: rows.length, truncated, elapsedMs: nowMs() - started };
  }

  async explain(sql: string): Promise<QueryResult> {
    const started = nowMs();
    const res = await this.require().query({
      text: `EXPLAIN ${sql.trim().replace(/;\s*$/, "")}`,
      rowMode: "array",
    });
    const columns: ResultColumn[] = res.fields.map((f) => ({ name: f.name }));
    const rows = (res.rows as unknown[][]).map(toCells);
    return { columns, rows, rowCount: rows.length, truncated: false, elapsedMs: nowMs() - started };
  }

  async execWrite(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<WriteResult> {
    const started = nowMs();
    const res = await this.require().query(sql, params ? [...params] : []);
    return { affected: res.rowCount ?? 0, elapsedMs: nowMs() - started };
  }

  async begin(): Promise<void> {
    await this.require().query("BEGIN");
  }

  async commit(): Promise<void> {
    await this.require().query("COMMIT");
  }

  async rollback(): Promise<void> {
    await this.require().query("ROLLBACK");
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
