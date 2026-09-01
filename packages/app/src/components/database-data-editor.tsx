import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Trash2, Undo2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  DatabaseEngine,
  DbColumn,
  QueryResult,
} from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isSqlEngine, qualifyTable, quoteIdent } from "@/utils/sql-ident";
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

  const [columns, setColumns] = useState<DbColumn[]>([]);
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
    filterRef.current = "";
    setFilterText("");
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, schema, table, listRefreshKey]);

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

  const exportJson = useCallback(() => {
    if (!result) return;
    const rows = result.rows.map((r) => {
      const obj: Record<string, Cell> = {};
      result.columns.forEach((c, i) => {
        obj[c.name] = r[i];
      });
      return obj;
    });
    setStatus(`Exported ${rows.length} rows as JSON to log.`);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows, null, 2));
  }, [result]);

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
                  onSort={handleSort}
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
        <Pressable style={styles.tbtn} onPress={exportJson}>
          <Text style={styles.tbtnText}>Export</Text>
        </Pressable>
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

      <View style={styles.statusBar}>
        <Text style={styles.statusText} numberOfLines={1}>
          {status ?? `${shown} row${shown === 1 ? "" : "s"}${result?.truncated ? "+" : ""}`}
          {txOpen ? " · transaction open" : ""}
          {canEdit ? " · double-tap a cell to edit" : ""}
        </Text>
      </View>

      <PreviewModal open={previewOpen} statements={previewStatements} onClose={closePreview} />
    </View>
  );
}

function HeaderCell({
  column,
  sortDir,
  onSort,
}: {
  column: DbColumn;
  sortDir: "asc" | "desc" | null;
  onSort: (col: string) => void;
}) {
  const press = useCallback(() => onSort(column.name), [onSort, column.name]);
  let arrow = "";
  if (sortDir === "asc") arrow = " ↑";
  else if (sortDir === "desc") arrow = " ↓";
  return (
    <Pressable style={styles.cell} onPress={press}>
      <Text style={styles.headerText} numberOfLines={1}>
        {column.name}
        {arrow}
      </Text>
      <Text style={styles.headerType} numberOfLines={1}>
        {column.dataType}
        {column.isPrimaryKey ? " · PK" : ""}
      </Text>
    </Pressable>
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
  const commit = useCallback(() => {
    if (rowIndex !== undefined) onCommitExisting?.(rowIndex, col, draft, original);
    else if (newIndex !== undefined) onCommitNew?.(newIndex, col, draft);
  }, [rowIndex, newIndex, col, draft, original, onCommitExisting, onCommitNew]);

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
    >
      <Text style={[styles.bodyText, isNull && styles.nullText]} numberOfLines={1}>
        {isNull ? "NULL" : text}
      </Text>
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
  cellDirty: { backgroundColor: "rgba(245, 158, 11, 0.16)" },
  cellEditing: { backgroundColor: theme.colors.surface2, paddingVertical: 0 },
  cellInput: {
    fontSize: theme.fontSize.xs,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[1.5],
  },
  headerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  headerType: { fontSize: 10, color: theme.colors.foregroundExtraMuted },
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
