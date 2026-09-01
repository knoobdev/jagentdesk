import { describe, expect, it } from "vitest";
import type { DbColumn, DbObject } from "@jagentdesk/protocol/database/rpc-schemas";
import { diffColumns, diffObjects } from "./sql-schema-diff";

const obj = (name: string): DbObject => ({ schema: "s", name, kind: "table" });
const col = (name: string, dataType: string, nullable = true): DbColumn => ({
  name,
  dataType,
  nullable,
  isPrimaryKey: false,
  isForeignKey: false,
});

describe("diffObjects", () => {
  it("classifies added / removed / unchanged by name", () => {
    const a = [obj("orders"), obj("customers")];
    const b = [obj("orders"), obj("products")];
    const diff = diffObjects(a, b);
    expect(diff).toEqual([
      { name: "customers", status: "removed", columns: [] },
      { name: "orders", status: "unchanged", columns: [] },
      { name: "products", status: "added", columns: [] },
    ]);
  });
});

describe("diffColumns", () => {
  it("detects added, removed, type and nullability changes", () => {
    const a = [col("id", "int", false), col("status", "text"), col("legacy", "text")];
    const b = [col("id", "bigint", false), col("status", "text", false), col("note", "text")];
    const diff = diffColumns(a, b);
    expect(diff).toEqual([
      { name: "id", change: "type-changed", detail: "int → bigint" },
      { name: "legacy", change: "removed" },
      { name: "note", change: "added" },
      { name: "status", change: "nullability-changed", detail: "NULL → NOT NULL" },
    ]);
  });
});
