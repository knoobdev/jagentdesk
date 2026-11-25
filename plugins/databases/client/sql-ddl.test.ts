import { describe, expect, it } from "vitest";
import type { DbColumn, DbForeignKey } from "@jagentdesk/protocol/database/rpc-schemas";
import { buildCreateTableDdl } from "./sql-ddl";

const cols: DbColumn[] = [
  { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, isForeignKey: false },
  {
    name: "customer_id",
    dataType: "integer",
    nullable: true,
    isPrimaryKey: false,
    isForeignKey: true,
  },
  {
    name: "status",
    dataType: "text",
    nullable: false,
    isPrimaryKey: false,
    isForeignKey: false,
    defaultValue: "'new'",
  },
];
const fks: DbForeignKey[] = [
  {
    table: "orders",
    column: "customer_id",
    refSchema: "public",
    refTable: "customers",
    refColumn: "id",
  },
];

describe("buildCreateTableDdl", () => {
  it("reconstructs CREATE TABLE with types, NOT NULL, default, PK and FK (postgres)", () => {
    const ddl = buildCreateTableDdl("postgres", "public", "orders", cols, fks);
    expect(ddl).toBe(
      'CREATE TABLE "public"."orders" (\n' +
        '  "id" integer NOT NULL,\n' +
        '  "customer_id" integer,\n' +
        "  \"status\" text NOT NULL DEFAULT 'new',\n" +
        '  PRIMARY KEY ("id"),\n' +
        '  FOREIGN KEY ("customer_id") REFERENCES "public"."customers" ("id")\n' +
        ");",
    );
  });

  it("uses backtick idents for mysql", () => {
    const ddl = buildCreateTableDdl("mysql", "shop", "orders", cols.slice(0, 1));
    expect(ddl).toBe(
      "CREATE TABLE `shop`.`orders` (\n  `id` integer NOT NULL,\n  PRIMARY KEY (`id`)\n);",
    );
  });
});
