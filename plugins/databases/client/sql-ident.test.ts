import { describe, expect, it } from "vitest";
import { qualifyTable, quoteIdent } from "./sql-ident";

describe("sql-ident", () => {
  it("quotes identifiers per engine", () => {
    expect(quoteIdent("postgres", "orders")).toBe('"orders"');
    expect(quoteIdent("sqlite", "orders")).toBe('"orders"');
    expect(quoteIdent("mysql", "orders")).toBe("`orders`");
  });

  it("escapes embedded quote characters", () => {
    expect(quoteIdent("postgres", 'we"ird')).toBe('"we""ird"');
    expect(quoteIdent("mysql", "we`ird")).toBe("`we``ird`");
  });

  it("qualifies a schema.table reference per engine", () => {
    expect(qualifyTable("postgres", "public", "orders")).toBe('"public"."orders"');
    expect(qualifyTable("mysql", "shop", "orders")).toBe("`shop`.`orders`");
    expect(qualifyTable("sqlite", "main", "orders")).toBe('"main"."orders"');
  });
});
