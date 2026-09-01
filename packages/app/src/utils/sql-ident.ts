import type { DatabaseEngine } from "@jagentdesk/protocol/database/rpc-schemas";

/** Quote a single identifier for the given engine (MySQL uses backticks). */
export function quoteIdent(engine: DatabaseEngine, name: string): string {
  if (engine === "mysql") return "`" + name.replace(/`/g, "``") + "`";
  return '"' + name.replace(/"/g, '""') + '"';
}

/** schema-qualified table reference, e.g. "public"."orders" or `db`.`orders`. */
export function qualifyTable(engine: DatabaseEngine, schema: string, table: string): string {
  return `${quoteIdent(engine, schema)}.${quoteIdent(engine, table)}`;
}
