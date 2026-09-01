export type DiffCell = string | number | boolean | null;

export interface RowDiff {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  /** True when no primary key was available, so rows were matched by full value. */
  byFullRow: boolean;
}

const SEP = "";

function keyBuilder(pkCols: string[], columns: string[]): (row: DiffCell[]) => string {
  const idx = pkCols.map((c) => columns.indexOf(c)).filter((i) => i >= 0);
  if (idx.length === 0) return (row) => JSON.stringify(row);
  return (row) => idx.map((i) => String(row[i])).join(SEP);
}

/**
 * Row-level diff of the same table across two databases. Rows are matched by
 * primary key when available (else by full-row value), and a matched pair counts
 * as `changed` when any non-key cell differs. Pure — inputs are the page of rows
 * each side returned (both capped by the caller), aligned to the same columns.
 */
export function diffRows(
  pkCols: string[],
  columns: string[],
  left: DiffCell[][],
  right: DiffCell[][],
): RowDiff {
  const keyOf = keyBuilder(pkCols, columns);
  const byFullRow = pkCols.map((c) => columns.indexOf(c)).filter((i) => i >= 0).length === 0;
  const leftMap = new Map<string, DiffCell[]>();
  for (const row of left) leftMap.set(keyOf(row), row);
  const rightMap = new Map<string, DiffCell[]>();
  for (const row of right) rightMap.set(keyOf(row), row);

  let added = 0;
  let changed = 0;
  let unchanged = 0;
  for (const [key, row] of rightMap) {
    const other = leftMap.get(key);
    if (!other) added += 1;
    else if (JSON.stringify(other) !== JSON.stringify(row)) changed += 1;
    else unchanged += 1;
  }
  let removed = 0;
  for (const key of leftMap.keys()) {
    if (!rightMap.has(key)) removed += 1;
  }
  return { added, removed, changed, unchanged, byFullRow };
}
