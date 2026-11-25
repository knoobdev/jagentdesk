import type {
  DatabaseEngine,
  DbColumn,
  DbForeignKey,
} from "@jagentdesk/protocol/database/rpc-schemas";
import { qualifyTable, quoteIdent } from "./sql-ident";

/**
 * Generate a readable CREATE TABLE from introspected columns + foreign keys.
 * This is a faithful reconstruction (types, NOT NULL, defaults, PK, FK), not the
 * engine's stored DDL — enough to read the structure and copy into a migration.
 */
export function buildCreateTableDdl(
  engine: DatabaseEngine,
  schema: string,
  table: string,
  columns: DbColumn[],
  foreignKeys: DbForeignKey[] = [],
): string {
  const lines: string[] = [];
  for (const c of columns) {
    const parts = [`  ${quoteIdent(engine, c.name)} ${c.dataType}`];
    if (!c.nullable) parts.push("NOT NULL");
    if (c.defaultValue != null && c.defaultValue !== "") parts.push(`DEFAULT ${c.defaultValue}`);
    lines.push(parts.join(" "));
  }
  const pk = columns.filter((c) => c.isPrimaryKey).map((c) => quoteIdent(engine, c.name));
  if (pk.length > 0) lines.push(`  PRIMARY KEY (${pk.join(", ")})`);
  for (const fk of foreignKeys) {
    lines.push(
      `  FOREIGN KEY (${quoteIdent(engine, fk.column)}) REFERENCES ` +
        `${qualifyTable(engine, fk.refSchema, fk.refTable)} (${quoteIdent(engine, fk.refColumn)})`,
    );
  }
  return `CREATE TABLE ${qualifyTable(engine, schema, table)} (\n${lines.join(",\n")}\n);`;
}
