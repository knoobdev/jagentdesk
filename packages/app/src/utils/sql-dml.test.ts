import { describe, expect, it } from "vitest";
import { buildDelete, buildInsert, buildUpdate } from "./sql-dml";

describe("sql-dml", () => {
  it("builds a parameterized UPDATE keyed by PK (postgres numbered params)", () => {
    const dml = buildUpdate(
      "postgres",
      "public",
      "orders",
      { status: "shipped", total: 42 },
      { id: 1 },
    );
    expect(dml.sql).toBe(
      'update "public"."orders" set "status" = $1, "total" = $2 where "id" = $3',
    );
    expect(dml.params).toEqual(["shipped", 42, 1]);
  });

  it("builds a parameterized UPDATE for mysql (? placeholders, backtick idents)", () => {
    const dml = buildUpdate("mysql", "shop", "orders", { status: "shipped" }, { id: 1 });
    expect(dml.sql).toBe("update `shop`.`orders` set `status` = ? where `id` = ?");
    expect(dml.params).toEqual(["shipped", 1]);
  });

  it("builds an INSERT", () => {
    const dml = buildInsert("sqlite", "main", "orders", { status: "new", total: null });
    expect(dml.sql).toBe('insert into "main"."orders" ("status", "total") values (?, ?)');
    expect(dml.params).toEqual(["new", null]);
  });

  it("builds a DELETE keyed by a composite PK", () => {
    const dml = buildDelete("postgres", "public", "line_items", { order_id: 1, sku: "A" });
    expect(dml.sql).toBe('delete from "public"."line_items" where "order_id" = $1 and "sku" = $2');
    expect(dml.params).toEqual([1, "A"]);
  });

  it("refuses an UPDATE with no key", () => {
    expect(() => buildUpdate("postgres", "public", "orders", { status: "x" }, {})).toThrow(
      /primary key/i,
    );
  });
});
