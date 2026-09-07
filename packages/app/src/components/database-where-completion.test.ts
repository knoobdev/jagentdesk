import { describe, expect, it } from "vitest";
import {
  applyWhereCompletion,
  buildWhereCompletion,
  type WhereAcColumn,
} from "./database-where-completion";

const columns: WhereAcColumn[] = [
  { name: "id", dataType: "uuid" },
  { name: "tenant_id", dataType: "uuid" },
  { name: "title", dataType: "text" },
  { name: "createdAt", dataType: "timestamptz" }, // mixed case → must be quoted
];

const labels = (text: string) =>
  buildWhereCompletion(text, columns, "postgres").items.map((i) => i.label);

describe("buildWhereCompletion — phases", () => {
  it("lists all columns at the start (empty input)", () => {
    expect(labels("")).toEqual(["id", "tenant_id", "title", "createdAt"]);
  });

  it("filters columns by the partial word being typed", () => {
    expect(labels("t")).toEqual(["tenant_id", "title"]);
    expect(labels("ten")).toEqual(["tenant_id"]);
  });

  it("offers operators right after a completed column", () => {
    const l = labels("tenant_id ");
    expect(l).toContain("=");
    expect(l).toContain("LIKE");
    expect(l).toContain("IS NULL");
    // never columns or literals in the operator phase
    expect(l).not.toContain("tenant_id");
    expect(l).not.toContain("true");
  });

  it("filters operators by the partial operator word", () => {
    expect(labels("tenant_id li")).toEqual(["LIKE"]);
  });

  it("shows nothing while a value is expected (right after an operator)", () => {
    expect(labels("tenant_id = ")).toEqual([]);
    expect(labels("title LIKE ")).toEqual([]);
  });

  it("offers AND/OR after a complete condition", () => {
    expect(labels("tenant_id = 'x' ")).toEqual(["AND", "OR"]);
  });

  it("returns to columns after a connector", () => {
    expect(labels("tenant_id = 'x' AND ")).toEqual(["id", "tenant_id", "title", "createdAt"]);
  });

  it("offers columns after an open paren (IN list / subquery)", () => {
    expect(labels("id IN (").length).toBeGreaterThan(0);
    expect(labels("id IN (")).toContain("id");
  });
});

describe("buildWhereCompletion — insert text & quoting", () => {
  it("inserts a plain lowercase column unquoted with a trailing space", () => {
    const { items } = buildWhereCompletion("ten", columns, "postgres");
    expect(items[0].insert).toBe("tenant_id ");
  });

  it("quotes a mixed-case column for the engine", () => {
    const { items } = buildWhereCompletion("create", columns, "postgres");
    expect(items[0].label).toBe("createdAt");
    expect(items[0].insert).toBe('"createdAt" ');
  });

  it("quotes with backticks for mysql", () => {
    const { items } = buildWhereCompletion("create", columns, "mysql");
    expect(items[0].insert).toBe("`createdAt` ");
  });

  it("IN inserts an open paren so the value list follows", () => {
    const inItem = buildWhereCompletion("tenant_id ", columns, "postgres").items.find(
      (i) => i.label === "IN",
    );
    expect(inItem?.insert).toBe("IN (");
  });
});

describe("applyWhereCompletion", () => {
  it("replaces the partial word being typed", () => {
    expect(
      applyWhereCompletion("ten", { key: "k", label: "tenant_id", insert: "tenant_id " }),
    ).toBe("tenant_id ");
  });

  it("appends after a trailing space", () => {
    expect(applyWhereCompletion("tenant_id ", { key: "k", label: "=", insert: "= " })).toBe(
      "tenant_id = ",
    );
  });

  it("chains column → operator → value → connector", () => {
    let text = "";
    text = applyWhereCompletion(text, { key: "k", label: "tenant_id", insert: "tenant_id " });
    expect(text).toBe("tenant_id ");
    text = applyWhereCompletion(text, { key: "k", label: "=", insert: "= " });
    expect(text).toBe("tenant_id = ");
    text += "'abc' ";
    expect(labelsAfter(text)).toEqual(["AND", "OR"]);
  });
});

function labelsAfter(text: string): string[] {
  return buildWhereCompletion(text, columns, "postgres").items.map((i) => i.label);
}
