import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Trash2, Undo2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import type {
  DatabaseEngine,
  DbColumn,
  DbForeignKey,
  QueryResult,
} from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isSqlEngine, qualifyTable, quoteIdent } from "@/utils/sql-ident";
import { isWeb } from "@/constants/platform";
import { buildDelete, buildInsert, buildUpdate, type Cell, type Dml } from "@/utils/sql-dml";
import type { Theme } from "@/styles/theme";

const PAGE_SIZE = 100;
const GUTTER_W = 52;
const CELL_W = 168;

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedPlus = withUnistyles(Plus);
const ThemedTrash = withUnistyles(Trash2);
const ThemedUndo = withUnistyles(Undo2);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const placeholderColor = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});
const ThemedCellInput = withUnistyles(TextInput);

type TxMode = "auto" | "manual";

function coerce(text: string): Cell {
  if (text === "") return "";
  if (/^-?\d+$/.test(text)) return Number(text);
  if (/^-?\d+\.\d+$/.test(text)) return Number(text);
  return text;
}
function cellText(v: Cell): string {
  return v === null ? "" : String(v);
}

interface AggregateResult {
  col: string;
  count: number;
  numeric: boolean;
  sum?: number;
  avg?: number;
  min?: number;
  max?: number;
  distinct?: number;
}

/** DataGrip's status-bar aggregate for one column over the loaded page. */
function computeAggregate(result: QueryResult, col: string): AggregateResult | null {
  const idx = result.columns.findIndex((c) => c.name === col);
  if (idx < 0) return null;
  const present = result.rows.map((r) => r[idx]).filter((v) => v !== null);
  const count = present.length;
  const nums = present
    .map((v) => (typeof v === "number" ? v : Number(v)))
    .filter((n) => Number.isFinite(n));
  if (count > 0 && nums.length === count) {
    const sum = nums.reduce((a, b) => a + b, 0);
    return {
      col,
      count,
      numeric: true,
      sum,
      avg: sum / count,
      min: Math.min(...nums),
      max: Math.max(...nums),
    };
  }
  return { col, count, numeric: false, distinct: new Set(present.map(String)).size };
}

const round2 = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** Parse one CSV line honouring "quoted, fields" and doubled "" escapes. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parse pasted CSV (header row + data) into new-row records for the editor. */
function parseCsv(text: string, columns: string[]): Array<Record<string, Cell>> {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, Cell> = {};
    headers.forEach((h, i) => {
      if (columns.includes(h) && cells[i] !== undefined) row[h] = coerce(cells[i]);
    });
    return row;
  });
}

/** Serialise the loaded rows into an extractor format for the clipboard. */
function extract(result: QueryResult, format: "csv" | "json" | "sql", table: string): string {
  const names = result.columns.map((c) => c.name);
  if (format === "json") {
    return JSON.stringify(
      result.rows.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]]))),
      null,
      2,
    );
  }
  if (format === "csv") {
    const esc = (v: Cell) => {
      const s = v === null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [names.join(","), ...result.rows.map((r) => r.map(esc).join(","))].join("\n");
  }
  const lit = (v: Cell) => {
    if (v === null) return "NULL";
    if (typeof v === "number") return String(v);
    if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  return result.rows
    .map((r) => `INSERT INTO ${table} (${names.join(", ")}) VALUES (${r.map(lit).join(", ")});`)
    .join("\n");
}

/**
 * The DataGrip-style data editor: cells are edited INLINE (tap a cell → type),
 * changed cells are highlighted, and add/delete act on the toolbar + selected
 * rows — no per-row icons, no modal. Pending changes become parameterized DML
 * (previewable), applied in Auto (autocommit) or Manual (begin → commit/rollback)
 * transactions. Editing needs a primary key on a relational engine.
 */
// eslint-disable-next-line complexity
export function DatabaseDataEditor({
  serverId,
  databaseId,
  engine,
  schema,
  table,
}: {
  serverId: string;
  databaseId: string;
  engine: DatabaseEngine;
  schema: string;
  table: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const listRefreshKey = useDatabaseViewStore((s) => s.listRefreshKey);
  const bumpRefresh = useDatabaseViewStore((s) => s.bumpRefresh);
  const consumeFilter = useDatabaseViewStore((s) => s.consumeFilter);
  const requestFilter = useDatabaseViewStore((s) => s.requestFilter);
  const openTable = useDatabaseViewStore((s) => s.openTable);
  const selectObject = useDatabaseNavStore((s) => s.selectObject);

  const [columns, setColumns] = useState<DbColumn[]>([]);
  const [fks, setFks] = useState<DbForeignKey[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [txMode, setTxMode] = useState<TxMode>("auto");
  const [txOpen, setTxOpen] = useState(false);

  // Pending edits to existing rows keyed "rowIdx:col"; appended new rows; deleted
  // existing-row indices; current inline-editing cell.
  const [edits, setEdits] = useState<Record<string, Cell>>({});
  const [newRows, setNewRows] = useState<Array<Record<string, Cell>>>([]);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sort, setSort] = useState<{ col: string; dir: "asc" | "desc" } | null>(null);
  const sortRef = useRef<{ col: string; dir: "asc" | "desc" } | null>(null);
  const [filterText, setFilterText] = useState("");
  const filterRef = useRef("");
  const [valueCell, setValueCell] = useState<ExpandedCell | null>(null);
  const [aggCol, setAggCol] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");

  const pkCols = useMemo(() => columns.filter((c) => c.isPrimaryKey).map((c) => c.name), [columns]);
  const colNames = useMemo(() => columns.map((c) => c.name), [columns]);
  const canEdit = isSqlEngine(engine) && pkCols.length > 0;

  const resetPending = useCallback(() => {
    setEdits({});
    setNewRows([]);
    setDeleted(new Set());
    setSelected(new Set());
    setEditingKey(null);
  }, []);

  const load = useCallback(
    async (nextPage: number) => {
      if (!client) return;
      setLoading(true);
      setError(null);
      try {
        const cols = columns.length
          ? { error: null, columns }
          : await client.databaseColumns({ id: databaseId, schema, table });
        if (!("error" in cols) || !cols.error) {
          if ("columns" in cols && cols.columns) setColumns(cols.columns);
        }
        const s = sortRef.current;
        const orderBy = s
          ? ` order by ${quoteIdent(engine, s.col)} ${s.dir === "desc" ? "desc" : "asc"}`
          : "";
        const w = filterRef.current.trim() ? ` where ${filterRef.current.trim()}` : "";
        const res = await client.databaseQuery({
          id: databaseId,
          sql: `select * from ${qualifyTable(engine, schema, table)}${w}${orderBy}`,
          limit: PAGE_SIZE,
          offset: nextPage * PAGE_SIZE,
        });
        if (res.error || !res.result) setError(res.error ?? "Query failed");
        else {
          setResult(res.result);
          setPage(nextPage);
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Query failed");
      } finally {
        setLoading(false);
      }
    },
    [client, databaseId, engine, schema, table, columns],
  );

  useEffect(() => {
    setColumns([]);
    resetPending();
    setTxOpen(false);
    setStatus(null);
    sortRef.current = null;
    setSort(null);
    // A foreign-key navigation queued a WHERE for this table — apply it on open.
    const queued = consumeFilter(schema, table);
    filterRef.current = queued ?? "";
    setFilterText(queued ?? "");
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, schema, table, listRefreshKey]);

  // Outgoing foreign keys for this table, so a cell in an FK column can jump to
  // the referenced row (DataGrip's "Related Rows").
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client
      .databaseForeignKeys({ id: databaseId, schema })
      .then((r) => {
        if (!cancelled) setFks(r.error ? [] : r.foreignKeys.filter((f) => f.table === table));
        return undefined;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, schema, table, listRefreshKey]);
  const fkByCol = useMemo(() => {
    const m = new Map<string, DbForeignKey>();
    for (const f of fks) m.set(f.column, f);
    return m;
  }, [fks]);
  const navigateFk = useCallback(
    (fk: DbForeignKey, value: Cell) => {
      const ref = quoteIdent(engine, fk.refColumn);
      let where: string;
      if (value === null) where = `${ref} is null`;
      else if (typeof value === "number") where = `${ref} = ${value}`;
      else where = `${ref} = '${String(value).replace(/'/g, "''")}'`;
      requestFilter(fk.refSchema, fk.refTable, where);
      openTable(databaseId, { schema: fk.refSchema, name: fk.refTable });
      selectObject(databaseId, { databaseId, schema: fk.refSchema, name: fk.refTable });
    },
    [engine, requestFilter, openTable, selectObject, databaseId],
  );

  // Click a column header to sort (asc → desc → none), re-querying with ORDER BY.
  const handleSort = useCallback(
    (col: string) => {
      const cur = sortRef.current;
      let next: { col: string; dir: "asc" | "desc" } | null;
      if (!cur || cur.col !== col) next = { col, dir: "asc" };
      else if (cur.dir === "asc") next = { col, dir: "desc" };
      else next = null;
      sortRef.current = next;
      setSort(next);
      void load(0);
    },
    [load],
  );
  const applyFilter = useCallback(() => {
    filterRef.current = filterText;
    void load(0);
  }, [filterText, load]);

  const colIndex = useCallback((name: string) => colNames.indexOf(name), [colNames]);
  const keysForRow = useCallback(
    (row: Cell[]): Record<string, Cell> => {
      const keys: Record<string, Cell> = {};
      for (const pk of pkCols) keys[pk] = row[colIndex(pk)];
      return keys;
    },
    [pkCols, colIndex],
  );

  // Inline editing.
  const startEdit = useCallback(
    (key: string) => {
      if (canEdit) setEditingKey(key);
    },
    [canEdit],
  );
  const commitExistingEdit = useCallback(
    (rowIdx: number, col: string, text: string, original: string) => {
      setEditingKey(null);
      setEdits((prev) => {
        const key = `${rowIdx}:${col}`;
        const next = { ...prev };
        if (text === original) delete next[key];
        else next[key] = coerce(text);
        return next;
      });
    },
    [],
  );
  const commitNewEdit = useCallback((i: number, col: string, text: string) => {
    setEditingKey(null);
    setNewRows((prev) => {
      const next = prev.map((r) => ({ ...r }));
      if (text === "") delete next[i][col];
      else next[i][col] = coerce(text);
      return next;
    });
  }, []);

  // Large-cell value editor — DataGrip's expandable cell viewer for long text /
  // JSON / BLOB previews that don't fit an inline row. Read-only cells still open
  // it (to read the full value); editable cells save back through the same path.
  const handleExpandCell = useCallback((cell: ExpandedCell) => setValueCell(cell), []);
  const closeValueCell = useCallback(() => setValueCell(null), []);
  const saveValueCell = useCallback(
    (text: string) => {
      const v = valueCell;
      setValueCell(null);
      if (!v) return;
      if (v.rowIndex !== undefined) commitExistingEdit(v.rowIndex, v.col, text, v.original);
      else if (v.newIndex !== undefined) commitNewEdit(v.newIndex, v.col, text);
    },
    [valueCell, commitExistingEdit, commitNewEdit],
  );

  const toggleSelect = useCallback((rowIdx: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowIdx)) next.delete(rowIdx);
      else next.add(rowIdx);
      return next;
    });
  }, []);

  const addRow = useCallback(() => setNewRows((prev) => [...prev, {}]), []);
  const deleteSelected = useCallback(() => {
    setDeleted((prev) => {
      const next = new Set(prev);
      for (const r of selected) next.add(r);
      return next;
    });
    setSelected(new Set());
  }, [selected]);

  const buildStatements = useCallback((): Dml[] => {
    if (!result) return [];
    const stmts: Dml[] = [];
    // Group edits by row.
    const editedRows = new Map<number, Record<string, Cell>>();
    for (const [key, value] of Object.entries(edits)) {
      const [rStr, col] = key.split(/:(.+)/);
      const r = Number(rStr);
      if (deleted.has(r)) continue;
      const m = editedRows.get(r) ?? {};
      m[col] = value;
      editedRows.set(r, m);
    }
    for (const [r, changes] of editedRows) {
      stmts.push(buildUpdate(engine, schema, table, changes, keysForRow(result.rows[r])));
    }
    for (const nr of newRows) {
      if (Object.keys(nr).length > 0) stmts.push(buildInsert(engine, schema, table, nr));
    }
    for (const r of deleted) {
      stmts.push(buildDelete(engine, schema, table, keysForRow(result.rows[r])));
    }
    return stmts;
  }, [result, edits, deleted, newRows, engine, schema, table, keysForRow]);

  const editedRowCount = useMemo(() => {
    const rows = new Set<number>();
    for (const key of Object.keys(edits)) {
      const r = Number(key.split(":")[0]);
      if (!deleted.has(r)) rows.add(r);
    }
    return rows.size;
  }, [edits, deleted]);
  const pendingCount =
    editedRowCount + deleted.size + newRows.filter((r) => Object.keys(r).length > 0).length;

  const submit = useCallback(async () => {
    if (!client || pendingCount === 0) return;
    const stmts = buildStatements();
    setError(null);
    setStatus(null);
    try {
      if (txMode === "manual" && !txOpen) {
        const b = await client.databaseBegin({ id: databaseId });
        if (b.error) return setError(b.error);
        setTxOpen(true);
      }
      let affected = 0;
      for (const s of stmts) {
        const res = await client.databaseExec({ id: databaseId, sql: s.sql, params: s.params });
        if (res.error) return setError(res.error);
        affected += res.result?.affected ?? 0;
      }
      resetPending();
      if (txMode === "manual") {
        setStatus(`${stmts.length} statement(s), ${affected} row(s) — uncommitted.`);
      } else {
        setStatus(`${stmts.length} statement(s) applied, ${affected} row(s).`);
        bumpRefresh();
        await load(page);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Submit failed");
    }
  }, [
    client,
    pendingCount,
    buildStatements,
    txMode,
    txOpen,
    databaseId,
    resetPending,
    bumpRefresh,
    load,
    page,
  ]);

  const commit = useCallback(async () => {
    if (!client || !txOpen) return;
    const res = await client.databaseCommit({ id: databaseId });
    if (res.error) return setError(res.error);
    setTxOpen(false);
    setStatus("Committed.");
    bumpRefresh();
    await load(page);
  }, [client, txOpen, databaseId, bumpRefresh, load, page]);
  const rollback = useCallback(async () => {
    if (!client || !txOpen) return;
    const res = await client.databaseRollback({ id: databaseId });
    if (res.error) return setError(res.error);
    setTxOpen(false);
    setStatus("Rolled back.");
    await load(page);
  }, [client, txOpen, databaseId, load, page]);

  const handleAggregate = useCallback(
    (col: string) => setAggCol((cur) => (cur === col ? null : col)),
    [],
  );
  const toggleExport = useCallback(() => setExportOpen((v) => !v), []);
  const qualified = qualifyTable(engine, schema, table);
  const copyExtract = useCallback(
    (format: "csv" | "json" | "sql") => {
      setExportOpen(false);
      if (!result) return;
      void Clipboard.setStringAsync(extract(result, format, qualified));
      setStatus(`Copied ${result.rows.length} rows as ${format.toUpperCase()} to clipboard.`);
    },
    [result, qualified],
  );
  const copyCsv = useCallback(() => copyExtract("csv"), [copyExtract]);
  const copyJson = useCallback(() => copyExtract("json"), [copyExtract]);
  const copySql = useCallback(() => copyExtract("sql"), [copyExtract]);
  const aggregate = useMemo(
    () => (result && aggCol ? computeAggregate(result, aggCol) : null),
    [result, aggCol],
  );
  const openImport = useCallback(() => {
    setImportText("");
    setImportOpen(true);
  }, []);
  const closeImport = useCallback(() => setImportOpen(false), []);
  const runImport = useCallback(() => {
    const parsed = parseCsv(importText, colNames);
    if (parsed.length === 0) {
      setStatus("No rows parsed — expect a header row matching column names, then data.");
      setImportOpen(false);
      return;
    }
    setNewRows((prev) => [...prev, ...parsed]);
    setImportOpen(false);
    setStatus(`Imported ${parsed.length} rows from CSV — review and Submit.`);
  }, [importText, colNames]);

  const onSubmit = useCallback(() => void submit(), [submit]);
  const onCommit = useCallback(() => void commit(), [commit]);
  const onRollback = useCallback(() => void rollback(), [rollback]);
  const handlePrev = useCallback(() => {
    if (page > 0) void load(page - 1);
  }, [page, load]);
  const handleNext = useCallback(() => {
    if (result?.truncated) void load(page + 1);
  }, [page, result, load]);
  const handleRefresh = useCallback(() => void load(page), [page, load]);
  const toggleTxMode = useCallback(() => setTxMode((m) => (m === "auto" ? "manual" : "auto")), []);
  const openPreview = useCallback(() => setPreviewOpen(true), []);
  const closePreview = useCallback(() => setPreviewOpen(false), []);

  const from = page * PAGE_SIZE;
  const shown = result?.rows.length ?? 0;
  const previewStatements = previewOpen ? buildStatements() : [];

  let gridBody;
  if (loading && !result) {
    gridBody = (
      <View style={styles.center}>
        <ThemedSpinner size="small" uniProps={mutedColor} />
      </View>
    );
  } else if (result) {
    gridBody = (
      <ScrollView style={styles.vscroll}>
        <ScrollView horizontal>
          <View>
            <View style={styles.headerRow}>
              <View style={styles.gutter} />
              {columns.map((c) => (
                <HeaderCell
                  key={c.name}
                  column={c}
                  sortDir={sort?.col === c.name ? sort.dir : null}
                  aggActive={aggCol === c.name}
                  onSort={handleSort}
                  onAggregate={handleAggregate}
                />
              ))}
            </View>
            {result.rows.map((row, r) => (
              <ExistingRow
                // eslint-disable-next-line react/no-array-index-key
                key={r}
                rowIndex={r}
                row={row}
                columns={colNames}
                edits={edits}
                deleted={deleted.has(r)}
                selected={selected.has(r)}
                canEdit={canEdit}
                editingKey={editingKey}
                onSelect={toggleSelect}
                onStartEdit={startEdit}
                onCommitEdit={commitExistingEdit}
                onExpand={handleExpandCell}
                fkByCol={fkByCol}
                onNavigate={navigateFk}
              />
            ))}
            {newRows.map((nr, i) => (
              <NewRow
                // eslint-disable-next-line react/no-array-index-key
                key={`new-${i}`}
                index={i}
                values={nr}
                columns={colNames}
                editingKey={editingKey}
                onStartEdit={startEdit}
                onCommitEdit={commitNewEdit}
                onExpand={handleExpandCell}
              />
            ))}
          </View>
        </ScrollView>
      </ScrollView>
    );
  } else {
    gridBody = null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.title} numberOfLines={1}>
          {schema}.{table}
        </Text>
        <Pressable
          style={[styles.tbtn, !canEdit && styles.tbtnDisabled]}
          onPress={addRow}
          disabled={!canEdit}
        >
          <ThemedPlus size={14} uniProps={mutedColor} />
          <Text style={styles.tbtnText}>Row</Text>
        </Pressable>
        <Pressable
          style={[styles.tbtn, selected.size === 0 && styles.tbtnDisabled]}
          onPress={deleteSelected}
          disabled={selected.size === 0}
        >
          <ThemedTrash size={14} uniProps={mutedColor} />
          <Text style={styles.tbtnText}>Delete{selected.size ? ` (${selected.size})` : ""}</Text>
        </Pressable>
        <Pressable
          style={[styles.tbtn, pendingCount === 0 && styles.tbtnDisabled]}
          onPress={resetPending}
          disabled={pendingCount === 0}
        >
          <ThemedUndo size={14} uniProps={mutedColor} />
          <Text style={styles.tbtnText}>Revert</Text>
        </Pressable>
        <Pressable style={styles.tbtn} onPress={toggleTxMode}>
          <Text style={styles.tbtnText}>Tx: {txMode === "auto" ? "Auto" : "Manual"}</Text>
        </Pressable>
        <Pressable
          style={[styles.tbtn, pendingCount === 0 && styles.tbtnDisabled]}
          onPress={openPreview}
          disabled={pendingCount === 0}
        >
          <Text style={styles.tbtnText}>Preview ({pendingCount})</Text>
        </Pressable>
        <Pressable
          style={[styles.tbtn, styles.tbtnPrimary, pendingCount === 0 && styles.tbtnDisabled]}
          onPress={onSubmit}
          disabled={pendingCount === 0}
        >
          <Text style={styles.tbtnPrimaryText}>Submit</Text>
        </Pressable>
        {txOpen ? (
          <>
            <Pressable style={[styles.tbtn, styles.tbtnPrimary]} onPress={onCommit}>
              <Text style={styles.tbtnPrimaryText}>Commit</Text>
            </Pressable>
            <Pressable style={styles.tbtn} onPress={onRollback}>
              <Text style={styles.tbtnText}>Rollback</Text>
            </Pressable>
          </>
        ) : null}
        <View style={styles.toolbarSpacer} />
        {canEdit ? (
          <Pressable style={styles.tbtn} onPress={openImport}>
            <Text style={styles.tbtnText}>Import CSV</Text>
          </Pressable>
        ) : null}
        <View>
          <Pressable style={styles.tbtn} onPress={toggleExport}>
            <Text style={styles.tbtnText}>Export ▾</Text>
          </Pressable>
          {exportOpen ? (
            <View style={styles.exportMenu}>
              <Pressable style={styles.exportItem} onPress={copyCsv}>
                <Text style={styles.exportItemText}>Copy as CSV</Text>
              </Pressable>
              <Pressable style={styles.exportItem} onPress={copyJson}>
                <Text style={styles.exportItemText}>Copy as JSON</Text>
              </Pressable>
              <Pressable style={styles.exportItem} onPress={copySql}>
                <Text style={styles.exportItemText}>Copy as SQL INSERT</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
        <Pressable style={styles.pageBtn} onPress={handlePrev} disabled={page === 0}>
          <ThemedChevronLeft size={16} uniProps={mutedColor} />
        </Pressable>
        <Text style={styles.pageText}>{shown === 0 ? "0" : `${from + 1}–${from + shown}`}</Text>
        <Pressable style={styles.pageBtn} onPress={handleNext} disabled={!result?.truncated}>
          <ThemedChevronRight size={16} uniProps={mutedColor} />
        </Pressable>
        <Pressable style={styles.pageBtn} onPress={handleRefresh}>
          <ThemedRefresh size={15} uniProps={mutedColor} />
        </Pressable>
      </View>

      <View style={styles.filterBar}>
        <Text style={styles.filterLabel}>WHERE</Text>
        <TextInput
          style={styles.filterInput}
          value={filterText}
          onChangeText={setFilterText}
          placeholder="filter condition, e.g. status = 'paid'"
          onSubmitEditing={applyFilter}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {!canEdit && columns.length > 0 ? (
        <View style={styles.noteBar}>
          <Text style={styles.noteText}>
            {isSqlEngine(engine)
              ? "Read-only — this table has no primary key to target a row for editing."
              : `Read-only — row editing isn't available for ${engine}; use the SQL console.`}
          </Text>
        </View>
      ) : null}
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {gridBody}

      <ValueEditorDock
        cell={valueCell}
        table={table}
        schema={schema}
        editable={canEdit}
        onSave={saveValueCell}
        onClose={closeValueCell}
      />

      {aggregate ? (
        <View style={styles.aggBar}>
          <Text style={styles.aggBarCol}>{aggregate.col}</Text>
          {aggregate.numeric ? (
            <Text style={styles.aggBarText}>
              count {aggregate.count} · sum {round2(aggregate.sum ?? 0)} · avg{" "}
              {round2(aggregate.avg ?? 0)} · min {round2(aggregate.min ?? 0)} · max{" "}
              {round2(aggregate.max ?? 0)}
            </Text>
          ) : (
            <Text style={styles.aggBarText}>
              count {aggregate.count} · distinct {aggregate.distinct}
            </Text>
          )}
        </View>
      ) : null}

      <View style={styles.statusBar}>
        <Text style={styles.statusText} numberOfLines={1}>
          {status ?? `${shown} row${shown === 1 ? "" : "s"}${result?.truncated ? "+" : ""}`}
          {txOpen ? " · transaction open" : ""}
          {canEdit ? " · double-tap a cell to edit" : ""}
        </Text>
      </View>

      <PreviewModal open={previewOpen} statements={previewStatements} onClose={closePreview} />
      <ImportModal
        open={importOpen}
        value={importText}
        onChange={setImportText}
        onImport={runImport}
        onClose={closeImport}
      />
    </View>
  );
}

function ImportModal({
  open,
  value,
  onChange,
  onImport,
  onClose,
}: {
  open: boolean;
  value: string;
  onChange: (t: string) => void;
  onImport: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Import CSV</Text>
          <Text style={styles.importHint}>
            Paste CSV with a header row matching column names. Rows are staged as new rows — review,
            then Submit.
          </Text>
          <ThemedCellInput
            style={styles.importInput}
            value={value}
            onChangeText={onChange}
            multiline
            placeholder={"id,name,email\n1,Ada,ada@example.test"}
            autoCapitalize="none"
            autoCorrect={false}
            uniProps={placeholderColor}
          />
          <View style={styles.modalActions}>
            <Pressable style={styles.tbtn} onPress={onClose}>
              <Text style={styles.tbtnText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.tbtn, styles.tbtnPrimary]} onPress={onImport}>
              <Text style={styles.tbtnPrimaryText}>Add rows</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function HeaderCell({
  column,
  sortDir,
  aggActive,
  onSort,
  onAggregate,
}: {
  column: DbColumn;
  sortDir: "asc" | "desc" | null;
  aggActive: boolean;
  onSort: (col: string) => void;
  onAggregate: (col: string) => void;
}) {
  const press = useCallback(() => onSort(column.name), [onSort, column.name]);
  const agg = useCallback(() => onAggregate(column.name), [onAggregate, column.name]);
  let arrow = "";
  if (sortDir === "asc") arrow = " ↑";
  else if (sortDir === "desc") arrow = " ↓";
  return (
    <View style={styles.headerCell}>
      <Pressable style={styles.headerMain} onPress={press}>
        <Text style={styles.headerText} numberOfLines={1}>
          {column.name}
          {arrow}
        </Text>
        <Text style={styles.headerType} numberOfLines={1}>
          {column.dataType}
          {column.isPrimaryKey ? " · PK" : ""}
        </Text>
      </Pressable>
      <Pressable style={styles.aggBtn} onPress={agg} accessibilityLabel="Aggregate column">
        <Text style={[styles.aggSigma, aggActive && styles.aggSigmaActive]}>Σ</Text>
      </Pressable>
    </View>
  );
}

function ExistingRow({
  rowIndex,
  row,
  columns,
  edits,
  deleted,
  selected,
  canEdit,
  editingKey,
  onSelect,
  onStartEdit,
  onCommitEdit,
  onExpand,
  fkByCol,
  onNavigate,
}: {
  rowIndex: number;
  row: Cell[];
  columns: string[];
  edits: Record<string, Cell>;
  deleted: boolean;
  selected: boolean;
  canEdit: boolean;
  editingKey: string | null;
  onSelect: (rowIdx: number) => void;
  onStartEdit: (key: string) => void;
  onCommitEdit: (rowIdx: number, col: string, text: string, original: string) => void;
  onExpand: (cell: ExpandedCell) => void;
  fkByCol: Map<string, DbForeignKey>;
  onNavigate: (fk: DbForeignKey, value: Cell) => void;
}) {
  const handleSelect = useCallback(() => onSelect(rowIndex), [onSelect, rowIndex]);
  return (
    <View
      style={[
        styles.bodyRow,
        rowIndex % 2 === 1 && styles.bodyRowAlt,
        deleted && styles.deletedRow,
      ]}
    >
      <Pressable
        style={[styles.gutter, selected && styles.gutterSelected]}
        onPress={handleSelect}
        disabled={!canEdit}
      >
        <Text style={styles.gutterText}>{rowIndex + 1}</Text>
      </Pressable>
      {row.map((cell, c) => {
        const col = columns[c];
        const key = `${rowIndex}:${col}`;
        const edited = Object.prototype.hasOwnProperty.call(edits, key);
        const value = edited ? edits[key] : cell;
        return (
          <GridCell
            // eslint-disable-next-line react/no-array-index-key
            key={c}
            cellKey={key}
            rowIndex={rowIndex}
            col={col}
            original={cellText(cell)}
            text={cellText(value)}
            isNull={value === null}
            dirty={edited}
            editable={canEdit && !deleted}
            editing={editingKey === key}
            onStart={onStartEdit}
            onCommitExisting={onCommitEdit}
            onExpand={onExpand}
            fk={fkByCol.get(col)}
            rawValue={value}
            onNavigate={onNavigate}
          />
        );
      })}
    </View>
  );
}

interface ExpandedCell {
  rowIndex?: number;
  newIndex?: number;
  col: string;
  text: string;
  original: string;
}

function NewRow({
  index,
  values,
  columns,
  editingKey,
  onStartEdit,
  onCommitEdit,
  onExpand,
}: {
  index: number;
  values: Record<string, Cell>;
  columns: string[];
  editingKey: string | null;
  onStartEdit: (key: string) => void;
  onCommitEdit: (i: number, col: string, text: string) => void;
  onExpand: (cell: ExpandedCell) => void;
}) {
  return (
    <View style={[styles.bodyRow, styles.newRow]}>
      <View style={styles.gutter}>
        <ThemedPlus size={12} uniProps={mutedColor} />
      </View>
      {columns.map((col) => {
        const key = `new:${index}:${col}`;
        const has = Object.prototype.hasOwnProperty.call(values, col);
        return (
          <GridCell
            key={col}
            cellKey={key}
            newIndex={index}
            col={col}
            original=""
            text={has ? cellText(values[col]) : ""}
            isNull={false}
            dirty
            editable
            editing={editingKey === key}
            onStart={onStartEdit}
            onCommitNew={onCommitEdit}
            onExpand={onExpand}
          />
        );
      })}
    </View>
  );
}

function GridCell({
  cellKey,
  rowIndex,
  newIndex,
  col,
  original,
  text,
  isNull,
  dirty,
  editable,
  editing,
  onStart,
  onCommitExisting,
  onCommitNew,
  onExpand,
  fk,
  rawValue,
  onNavigate,
}: {
  cellKey: string;
  rowIndex?: number;
  newIndex?: number;
  col: string;
  original: string;
  text: string;
  isNull: boolean;
  dirty: boolean;
  editable: boolean;
  editing: boolean;
  onStart: (key: string) => void;
  onCommitExisting?: (rowIdx: number, col: string, text: string, original: string) => void;
  onCommitNew?: (i: number, col: string, text: string) => void;
  onExpand: (cell: ExpandedCell) => void;
  fk?: DbForeignKey;
  rawValue?: Cell;
  onNavigate?: (fk: DbForeignKey, value: Cell) => void;
}) {
  const [draft, setDraft] = useState(text);
  const handlePress = useCallback(() => {
    setDraft(text);
    onStart(cellKey);
  }, [text, onStart, cellKey]);
  const handleExpand = useCallback(
    () => onExpand({ rowIndex, newIndex, col, text, original }),
    [onExpand, rowIndex, newIndex, col, text, original],
  );
  const navigate = useCallback(() => {
    if (fk && onNavigate) onNavigate(fk, rawValue ?? null);
  }, [fk, onNavigate, rawValue]);
  const commit = useCallback(() => {
    if (rowIndex !== undefined) onCommitExisting?.(rowIndex, col, draft, original);
    else if (newIndex !== undefined) onCommitNew?.(newIndex, col, draft);
  }, [rowIndex, newIndex, col, draft, original, onCommitExisting, onCommitNew]);
  // Right-click a foreign-key cell to jump to the referenced row (web/desktop).
  const ctx =
    isWeb && fk
      ? {
          onContextMenu: (e: { preventDefault?: () => void }) => {
            e?.preventDefault?.();
            navigate();
          },
        }
      : {};

  if (editing) {
    return (
      <View style={[styles.cell, styles.cellEditing]}>
        <ThemedCellInput
          style={styles.cellInput}
          value={draft}
          onChangeText={setDraft}
          onBlur={commit}
          onSubmitEditing={commit}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          uniProps={placeholderColor}
        />
      </View>
    );
  }
  return (
    <Pressable
      style={[styles.cell, dirty && styles.cellDirty]}
      onPress={editable ? handlePress : handleExpand}
      onLongPress={handleExpand}
      {...(ctx as object)}
    >
      <View style={styles.cellInner}>
        <Text style={[styles.bodyText, isNull && styles.nullText]} numberOfLines={1}>
          {isNull ? "NULL" : text}
        </Text>
        {fk ? (
          <Pressable onPress={navigate} hitSlop={6} style={styles.fkJump}>
            <Text style={styles.fkArrow}>↗</Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

function PreviewModal({
  open,
  statements,
  onClose,
}: {
  open: boolean;
  statements: Dml[];
  onClose: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Preview DML ({statements.length})</Text>
          <ScrollView style={styles.modalScroll}>
            {statements.map((s, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <View key={i} style={styles.previewItem}>
                <Text style={styles.previewSql}>{s.sql}</Text>
                <Text style={styles.previewParams}>params: {JSON.stringify(s.params)}</Text>
              </View>
            ))}
            {statements.length === 0 ? <Text style={styles.previewParams}>No changes.</Text> : null}
          </ScrollView>
          <View style={styles.modalActions}>
            <Pressable style={styles.tbtn} onPress={onClose}>
              <Text style={styles.tbtnText}>Close</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The value editor — a bottom-docked panel (DataGrip's "Value" view), not a
 * floating dialog. Shows the full cell content for a long text / JSON / BLOB
 * value that a single grid row can't display; editable cells write back through
 * the same commit path, read-only cells just view. Monospace, dense, IDE-styled.
 */
function ValueEditorDock({
  cell,
  table,
  schema,
  editable,
  onSave,
  onClose,
}: {
  cell: ExpandedCell | null;
  table: string;
  schema: string;
  editable: boolean;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    setDraft(cell?.text ?? "");
  }, [cell]);
  const handleSave = useCallback(() => onSave(draft), [onSave, draft]);
  const handleNull = useCallback(() => onSave("NULL"), [onSave]);
  if (!cell) return null;
  const dirty = draft !== (cell.text ?? "");
  const chars = draft.length;
  const lines = draft ? draft.split("\n").length : 0;
  return (
    <View style={styles.valueDock}>
      <View style={styles.valueDockHeader}>
        <Text style={styles.valueDockRef} numberOfLines={1}>
          {schema}.{table}.<Text style={styles.valueDockCol}>{cell.col}</Text>
        </Text>
        <Text style={styles.valueDockMeta}>
          {lines} ln · {chars} ch
        </Text>
        <View style={styles.valueDockSpacer} />
        {editable ? (
          <Pressable style={styles.valueDockBtn} onPress={handleNull}>
            <Text style={styles.valueDockBtnText}>Set NULL</Text>
          </Pressable>
        ) : null}
        {editable ? (
          <Pressable
            style={[styles.valueDockBtn, dirty && styles.valueDockBtnPrimary]}
            onPress={handleSave}
          >
            <Text style={[styles.valueDockBtnText, dirty && styles.valueDockBtnTextPrimary]}>
              Apply
            </Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.valueDockBtn} onPress={onClose}>
          <Text style={styles.valueDockBtnText}>Close</Text>
        </Pressable>
      </View>
      <ThemedCellInput
        style={styles.valueDockInput}
        value={draft}
        onChangeText={setDraft}
        editable={editable}
        multiline
        autoCapitalize="none"
        autoCorrect={false}
        uniProps={placeholderColor}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  filterBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  filterLabel: {
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundExtraMuted,
    letterSpacing: 0.5,
  },
  filterInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    padding: 0,
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    marginRight: theme.spacing[1],
  },
  toolbarSpacer: { flex: 1 },
  tbtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  tbtnText: { fontSize: theme.fontSize.xs, color: theme.colors.foreground },
  tbtnPrimary: { backgroundColor: theme.colors.accent, borderColor: theme.colors.accent },
  tbtnPrimaryText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accentForeground,
  },
  tbtnDisabled: { opacity: 0.4 },
  pageBtn: { padding: theme.spacing[1], borderRadius: theme.borderRadius.md },
  pageText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    minWidth: 64,
    textAlign: "center",
  },
  noteBar: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[1.5] },
  noteText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  errorBox: { padding: theme.spacing[3], backgroundColor: theme.colors.palette.red[100] },
  errorText: { fontSize: theme.fontSize.sm, color: theme.colors.palette.red[800] },
  center: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 120 },
  vscroll: { flex: 1, minHeight: 0 },
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  gutter: {
    width: GUTTER_W,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1.5],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
  gutterSelected: { backgroundColor: theme.colors.accent },
  gutterText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  cell: {
    width: CELL_W,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
    justifyContent: "center",
  },
  cellInner: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  fkJump: { paddingHorizontal: 2 },
  fkArrow: { fontSize: theme.fontSize.xs, color: theme.colors.accent },
  cellDirty: { backgroundColor: "rgba(245, 158, 11, 0.16)" },
  cellEditing: { backgroundColor: theme.colors.surface2, paddingVertical: 0 },
  cellInput: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[1.5],
  },
  headerCell: {
    width: CELL_W,
    flexDirection: "row",
    alignItems: "center",
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
  headerMain: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    justifyContent: "center",
  },
  aggBtn: { paddingHorizontal: theme.spacing[1.5], alignSelf: "stretch", justifyContent: "center" },
  aggSigma: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  aggSigmaActive: { color: theme.colors.accent, fontWeight: theme.fontWeight.bold },
  headerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  headerType: { fontSize: 10, color: theme.colors.foregroundExtraMuted },
  exportMenu: {
    position: "absolute",
    top: 30,
    right: 0,
    minWidth: 180,
    zIndex: 20,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingVertical: theme.spacing[1],
  },
  exportItem: { paddingHorizontal: theme.spacing[3], paddingVertical: theme.spacing[1.5] },
  exportItemText: { fontSize: theme.fontSize.xs, color: theme.colors.foreground },
  importHint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  importInput: {
    minHeight: 180,
    maxHeight: 320,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    textAlignVertical: "top" as const,
  },
  aggBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  aggBarCol: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  aggBarText: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
  bodyRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  bodyRowAlt: { backgroundColor: theme.colors.surface1 },
  deletedRow: { opacity: 0.45 },
  newRow: { backgroundColor: theme.colors.palette.green[100] },
  bodyText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  nullText: { color: theme.colors.foregroundExtraMuted, fontStyle: "italic" },
  statusBar: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  statusText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  modalCard: {
    width: "100%",
    maxWidth: 560,
    maxHeight: "80%",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  modalScroll: { minHeight: 0 },
  valueDock: {
    height: 200,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  valueDockHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    height: 30,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  valueDockRef: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  valueDockCol: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  valueDockMeta: {
    fontSize: 10,
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
  },
  valueDockSpacer: { flex: 1 },
  valueDockBtn: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
  },
  valueDockBtnPrimary: { backgroundColor: theme.colors.accent },
  valueDockBtnText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  valueDockBtnTextPrimary: { color: theme.colors.accentForeground },
  valueDockInput: {
    flex: 1,
    padding: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    textAlignVertical: "top" as const,
  },
  modalActions: { flexDirection: "row", gap: theme.spacing[2] },
  previewItem: {
    gap: theme.spacing[1],
    marginBottom: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  previewSql: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  previewParams: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
