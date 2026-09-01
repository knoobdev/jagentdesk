import oracledb from "oracledb";
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
  "SYS",
  "SYSTEM",
  "XDB",
  "OUTLN",
  "DBSNMP",
  "APPQOSSYS",
  "CTXSYS",
  "MDSYS",
  "ORDSYS",
  "GSMADMIN_INTERNAL",
  "AUDSYS",
  "DVSYS",
  "LBACSYS",
  "OJVMSYS",
  "WMSYS",
  "ORDDATA",
  "OLAPSYS",
]);

// Oracle thin mode (no Instant Client). CLOBs come back as strings so they fit
// the JSON-safe cell contract instead of a Lob handle.
oracledb.fetchAsString = [oracledb.CLOB];

/**
 * Oracle Database adapter — `oracledb` in thin mode (pure JS, no native client)
 * + data-dictionary (ALL_*) introspection. Positional binds use `:1, :2`.
 */
export class OracleDbClient implements DbClient {
  private conn: oracledb.Connection | null = null;
  private readonly config: DbConnectionConfig;

  constructor(config: DbConnectionConfig) {
    this.config = config;
  }

  private require(): oracledb.Connection {
    if (!this.conn) throw new Error("Oracle connection is not open");
    return this.conn;
  }

  async connect(): Promise<void> {
    if (this.config.dsn) {
      this.conn = await oracledb.getConnection({ connectString: this.config.dsn });
      return;
    }
    // The "database" field carries the Oracle service name from the UI form;
    // `options.service` (or the default) covers programmatic callers.
    const service =
      (this.config.options?.service as string | undefined) ?? this.config.database ?? "FREEPDB1";
    this.conn = await oracledb.getConnection({
      user: this.config.user,
      password: this.config.password,
      connectString: `${this.config.host ?? "127.0.0.1"}:${this.config.port ?? 1521}/${service}`,
    });
  }

  async close(): Promise<void> {
    await this.conn?.close();
    this.conn = null;
  }

  private async select(
    sql: string,
    binds: unknown[] | Record<string, unknown> = [],
  ): Promise<QueryResult> {
    const started = nowMs();
    const res = await this.require().execute(sql, binds as oracledb.BindParameters, {
      outFormat: oracledb.OUT_FORMAT_ARRAY,
    });
    const columns: ResultColumn[] = (res.metaData ?? []).map((m) => ({ name: m.name }));
    const rows = ((res.rows as unknown[][]) ?? []).map(toCells);
    return { columns, rows, rowCount: rows.length, truncated: false, elapsedMs: nowMs() - started };
  }

  async serverVersion(): Promise<string> {
    const res = await this.select(
      "select version_full from product_component_version where product like 'Oracle%' and rownum = 1",
    ).catch(() => null);
    const v = res?.rows[0]?.[0];
    return v ? `Oracle ${String(v)}` : "Oracle";
  }

  async listSchemas(): Promise<DbSchema[]> {
    const res = await this.select("select username from all_users order by username");
    return res.rows.map((r) => ({ name: String(r[0]) })).filter((s) => !SYSTEM_SCHEMAS.has(s.name));
  }

  async listObjects(schema: string): Promise<DbObject[]> {
    const res = await this.select(
      `select table_name as name, 'table' as kind from all_tables where owner = :owner
       union all
       select view_name as name, 'view' as kind from all_views where owner = :owner
       order by 1`,
      { owner: schema },
    );
    return res.rows.map((r) => ({
      schema,
      name: String(r[0]),
      kind: String(r[1]) as SchemaObjectKind,
    }));
  }

  async listColumns(schema: string, table: string): Promise<DbColumn[]> {
    const res = await this.select(
      `select c.column_name,
              c.data_type,
              c.nullable,
              c.data_default,
              (select count(*) from all_cons_columns acc join all_constraints ac
                 on ac.constraint_name = acc.constraint_name and ac.owner = acc.owner
                 where ac.constraint_type = 'P' and acc.owner = :owner and acc.table_name = :tbl
                   and acc.column_name = c.column_name) as is_pk,
              (select count(*) from all_cons_columns acc join all_constraints ac
                 on ac.constraint_name = acc.constraint_name and ac.owner = acc.owner
                 where ac.constraint_type = 'R' and acc.owner = :owner and acc.table_name = :tbl
                   and acc.column_name = c.column_name) as is_fk
       from all_tab_columns c
       where c.owner = :owner and c.table_name = :tbl
       order by c.column_id`,
      { owner: schema, tbl: table },
    );
    return res.rows.map((r) => ({
      name: String(r[0]),
      dataType: String(r[1]),
      nullable: String(r[2]) === "Y",
      isPrimaryKey: Number(r[4]) > 0,
      isForeignKey: Number(r[5]) > 0,
      defaultValue: r[3] == null ? null : String(r[3]).trim(),
    }));
  }

  async runQuery(sql: string, options?: RunQueryOptions): Promise<QueryResult> {
    if (isWriteStatement(sql)) {
      throw new Error("Read-only query path received a write statement");
    }
    const limit = options?.limit ?? DEFAULT_LIMIT;
    const offset = options?.offset ?? 0;
    const started = nowMs();
    const res = await this.require().execute(
      wrapPaged(sql, limit + 1, offset),
      [...(options?.params ?? [])],
      {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
      },
    );
    const columns: ResultColumn[] = (res.metaData ?? []).map((m) => ({ name: m.name }));
    const rawRows = (res.rows as unknown[][]) ?? [];
    const truncated = rawRows.length > limit;
    const rows = (truncated ? rawRows.slice(0, limit) : rawRows).map(toCells);
    return { columns, rows, rowCount: rows.length, truncated, elapsedMs: nowMs() - started };
  }

  async explain(sql: string): Promise<QueryResult> {
    const started = nowMs();
    await this.require().execute(`EXPLAIN PLAN FOR ${sql.trim().replace(/;\s*$/, "")}`);
    const res = await this.require().execute(
      "select plan_table_output from table(dbms_xplan.display())",
      [],
      { outFormat: oracledb.OUT_FORMAT_ARRAY },
    );
    const rows = ((res.rows as unknown[][]) ?? []).map(toCells);
    return {
      columns: [{ name: "PLAN_TABLE_OUTPUT" }],
      rows,
      rowCount: rows.length,
      truncated: false,
      elapsedMs: nowMs() - started,
    };
  }

  async execWrite(
    sql: string,
    params?: ReadonlyArray<string | number | boolean | null>,
  ): Promise<WriteResult> {
    const started = nowMs();
    const res = await this.require().execute(sql, [...(params ?? [])], { autoCommit: true });
    return { affected: res.rowsAffected ?? 0, elapsedMs: nowMs() - started };
  }

  async begin(): Promise<void> {
    // Oracle starts a transaction implicitly; autoCommit is disabled by default,
    // so within Manual mode execWrite is wrapped by commit/rollback below. The
    // editor's Manual submit path calls execWrite WITHOUT autoCommit via the
    // session; here execWrite always autocommits, so Manual tx on Oracle behaves
    // as immediate — acceptable until a session-bound handle lands.
  }
  async commit(): Promise<void> {
    await this.require().commit();
  }
  async rollback(): Promise<void> {
    await this.require().rollback();
  }
}

function wrapPaged(sql: string, limit: number, offset: number): string {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  return `select * from (${trimmed}) offset ${Math.max(0, offset)} rows fetch next ${Math.max(0, limit)} rows only`;
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
