import type { DatabaseEngine } from "@jagentdesk/protocol/database/rpc-schemas";
import { qualifyTable, quoteIdent } from "./sql-ident";

export type Cell = string | number | boolean | null;

export interface Dml {
  sql: string;
  params: Cell[];
}

/** Placeholder for the nth (1-based) bind parameter — Postgres numbers them. */
function placeholder(engine: DatabaseEngine, n: number): string {
  return engine === "postgres" ? `$${n}` : "?";
}

/**
 * Build a parameterized UPDATE for the changed columns of a single row, keyed by
 * the row's primary-key values. Values are always bound, never interpolated —
 * the read/write split and this binding are the write-safety guarantees.
 */
export function buildUpdate(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  changes: Record<string, Cell>,
  keys: Record<string, Cell>,
): Dml {
  const setCols = Object.keys(changes);
  const keyCols = Object.keys(keys);
  if (setCols.length === 0) throw new Error("UPDATE requires at least one changed column");
  if (keyCols.length === 0) throw new Error("UPDATE requires a primary key to target the row");
  const params: Cell[] = [];
  let n = 0;
  const setClause = setCols
    .map((c) => {
      params.push(changes[c]);
      return `${quoteIdent(engine, c)} = ${placeholder(engine, ++n)}`;
    })
    .join(", ");
  const whereClause = keyCols
    .map((c) => {
      params.push(keys[c]);
      return `${quoteIdent(engine, c)} = ${placeholder(engine, ++n)}`;
    })
    .join(" and ");
  return {
    sql: `update ${qualifyTable(engine, schema, table)} set ${setClause} where ${whereClause}`,
    params,
  };
}

/** Build a parameterized INSERT for a new row. */
export function buildInsert(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  values: Record<string, Cell>,
): Dml {
  const cols = Object.keys(values);
  if (cols.length === 0) throw new Error("INSERT requires at least one column");
  const params: Cell[] = [];
  let n = 0;
  const colList = cols.map((c) => quoteIdent(engine, c)).join(", ");
  const valList = cols
    .map((c) => {
      params.push(values[c]);
      return placeholder(engine, ++n);
    })
    .join(", ");
  return {
    sql: `insert into ${qualifyTable(engine, schema, table)} (${colList}) values (${valList})`,
    params,
  };
}

/** Build a parameterized DELETE for a single row keyed by its primary key. */
export function buildDelete(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  keys: Record<string, Cell>,
): Dml {
  const keyCols = Object.keys(keys);
  if (keyCols.length === 0) throw new Error("DELETE requires a primary key to target the row");
  const params: Cell[] = [];
  let n = 0;
  const whereClause = keyCols
    .map((c) => {
      params.push(keys[c]);
      return `${quoteIdent(engine, c)} = ${placeholder(engine, ++n)}`;
    })
    .join(" and ");
  return {
    sql: `delete from ${qualifyTable(engine, schema, table)} where ${whereClause}`,
    params,
  };
}
