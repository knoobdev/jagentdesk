import type { DbColumn, DbObject } from "@jagentdesk/protocol/database/rpc-schemas";

export interface ColumnDiff {
  name: string;
  change: "added" | "removed" | "type-changed" | "nullability-changed";
  detail?: string;
}

export interface ObjectDiff {
  name: string;
  status: "added" | "removed" | "changed" | "unchanged";
  columns: ColumnDiff[];
}

/** Diff a single table's columns between two schemas. */
export function diffColumns(a: DbColumn[], b: DbColumn[]): ColumnDiff[] {
  const byNameA = new Map(a.map((c) => [c.name, c]));
  const byNameB = new Map(b.map((c) => [c.name, c]));
  const out: ColumnDiff[] = [];
  for (const c of a) {
    if (!byNameB.has(c.name)) out.push({ name: c.name, change: "removed" });
  }
  for (const c of b) {
    const prev = byNameA.get(c.name);
    if (!prev) {
      out.push({ name: c.name, change: "added" });
    } else if (prev.dataType !== c.dataType) {
      out.push({
        name: c.name,
        change: "type-changed",
        detail: `${prev.dataType} → ${c.dataType}`,
      });
    } else if (prev.nullable !== c.nullable) {
      out.push({
        name: c.name,
        change: "nullability-changed",
        detail: `${prev.nullable ? "NULL" : "NOT NULL"} → ${c.nullable ? "NULL" : "NOT NULL"}`,
      });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

/**
 * Diff the object sets of two schemas (added / removed / unchanged by name).
 * Per-table column diffs are computed separately (they need extra introspection),
 * so a name present in both is "unchanged" here until columns are compared.
 */
export function diffObjects(a: DbObject[], b: DbObject[]): ObjectDiff[] {
  const namesA = new Set(a.map((o) => o.name));
  const namesB = new Set(b.map((o) => o.name));
  const all = Array.from(new Set([...namesA, ...namesB])).sort((x, y) => x.localeCompare(y));
  return all.map((name) => {
    let status: ObjectDiff["status"];
    if (namesA.has(name) && !namesB.has(name)) status = "removed";
    else if (!namesA.has(name) && namesB.has(name)) status = "added";
    else status = "unchanged";
    return { name, status, columns: [] };
  });
}
