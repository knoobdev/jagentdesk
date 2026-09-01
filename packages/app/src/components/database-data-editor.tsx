import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  DatabaseEngine,
  DbColumn,
  QueryResult,
} from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isSqlEngine, qualifyTable } from "@/utils/sql-ident";
import { buildDelete, buildInsert, buildUpdate, type Cell, type Dml } from "@/utils/sql-dml";
import type { Theme } from "@/styles/theme";

const PAGE_SIZE = 100;

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPlus = withUnistyles(Plus);
const ThemedTrash = withUnistyles(Trash2);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const placeholderColor = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
});

type TxMode = "auto" | "manual";

interface PendingDelete {
  keys: Record<string, Cell>;
  label: string;
}

/** Coerce an edited string back to a JSON-safe cell (numbers stay numbers). */
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
 * The editable data view for a table — the DataGrip data editor. Rows load
 * read-only via `database/query`; a record editor collects add/update, a delete
 * marks rows, and the pending set is previewed as parameterized DML before it
 * runs. Auto mode autocommits each statement; Manual wraps them in an explicit
 * begin → commit/rollback on the connection. Editing needs a primary key.
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

  // Pending change set (built into DML on submit).
  const [pendingDeletes, setPendingDeletes] = useState<PendingDelete[]>([]);
  const [pendingInserts, setPendingInserts] = useState<Array<Record<string, Cell>>>([]);
  const [pendingUpdates, setPendingUpdates] = useState<
    Array<{ keys: Record<string, Cell>; changes: Record<string, Cell>; label: string }>
  >([]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<"add" | "edit">("add");
  const [editorDraft, setEditorDraft] = useState<Record<string, string>>({});
  const [editorOriginal, setEditorOriginal] = useState<Cell[] | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  const pkCols = useMemo(() => columns.filter((c) => c.isPrimaryKey).map((c) => c.name), [columns]);
  const colNames = useMemo(() => columns.map((c) => c.name), [columns]);
  const pendingCount = pendingDeletes.length + pendingInserts.length + pendingUpdates.length;

  const load = useCallback(
    async (nextPage: number) => {
      if (!client) return;
      setLoading(true);
      setError(null);
      try {
        const [cols, res] = await Promise.all([
          columns.length
            ? Promise.resolve({ error: null, columns })
            : client.databaseColumns({ id: databaseId, schema, table }),
          client.databaseQuery({
            id: databaseId,
            sql: `select * from ${qualifyTable(engine, schema, table)}`,
            limit: PAGE_SIZE,
            offset: nextPage * PAGE_SIZE,
          }),
        ]);
        if (!("error" in cols) || !cols.error) {
          if ("columns" in cols && cols.columns) setColumns(cols.columns);
        }
        if (res.error || !res.result) {
          setError(res.error ?? "Query failed");
        } else {
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
    // Fresh table selection: reset the pending set and reload from page 0.
    setColumns([]);
    setPendingDeletes([]);
    setPendingInserts([]);
    setPendingUpdates([]);
    setTxOpen(false);
    setStatus(null);
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [databaseId, schema, table, listRefreshKey]);

  const colIndex = useCallback((name: string) => colNames.indexOf(name), [colNames]);

  const keysForRow = useCallback(
    (row: Cell[]): Record<string, Cell> => {
      const keys: Record<string, Cell> = {};
      for (const pk of pkCols) keys[pk] = row[colIndex(pk)];
      return keys;
    },
    [pkCols, colIndex],
  );

  const openAdd = useCallback(() => {
    const draft: Record<string, string> = {};
    for (const name of colNames) draft[name] = "";
    setEditorDraft(draft);
    setEditorOriginal(null);
    setEditorMode("add");
    setEditorOpen(true);
  }, [colNames]);

  const openEditRow = useCallback(
    (row: Cell[]) => {
      const draft: Record<string, string> = {};
      colNames.forEach((name, i) => {
        draft[name] = cellText(row[i]);
      });
      setEditorDraft(draft);
      setEditorOriginal(row);
      setEditorMode("edit");
      setEditorOpen(true);
    },
    [colNames],
  );

  const closeEditor = useCallback(() => setEditorOpen(false), []);

  const saveEditor = useCallback(() => {
    if (editorMode === "add") {
      const values: Record<string, Cell> = {};
      for (const name of colNames) {
        const raw = editorDraft[name] ?? "";
        if (raw !== "") values[name] = coerce(raw);
      }
      setPendingInserts((prev) => [...prev, values]);
    } else if (editorOriginal) {
      const changes: Record<string, Cell> = {};
      colNames.forEach((name, i) => {
        const original = cellText(editorOriginal[i]);
        const next = editorDraft[name] ?? "";
        if (next !== original) changes[name] = coerce(next);
      });
      if (Object.keys(changes).length > 0) {
        const keys = keysForRow(editorOriginal);
        const label = pkCols.map((k) => `${k}=${cellText(keys[k])}`).join(", ");
        setPendingUpdates((prev) => [...prev, { keys, changes, label }]);
      }
    }
    setEditorOpen(false);
  }, [editorMode, editorOriginal, editorDraft, colNames, keysForRow, pkCols]);

  const markDeleteRow = useCallback(
    (row: Cell[]) => {
      const keys = keysForRow(row);
      const label = pkCols.map((k) => `${k}=${cellText(keys[k])}`).join(", ");
      setPendingDeletes((prev) => [...prev, { keys, label }]);
    },
    [keysForRow, pkCols],
  );

  const buildStatements = useCallback((): Dml[] => {
    const stmts: Dml[] = [];
    for (const u of pendingUpdates)
      stmts.push(buildUpdate(engine, schema, table, u.changes, u.keys));
    for (const ins of pendingInserts) {
      if (Object.keys(ins).length > 0) stmts.push(buildInsert(engine, schema, table, ins));
    }
    for (const d of pendingDeletes) stmts.push(buildDelete(engine, schema, table, d.keys));
    return stmts;
  }, [pendingUpdates, pendingInserts, pendingDeletes, engine, schema, table]);

  const clearPending = useCallback(() => {
    setPendingDeletes([]);
    setPendingInserts([]);
    setPendingUpdates([]);
  }, []);

  const revert = useCallback(() => {
    clearPending();
    setStatus("Pending changes reverted.");
  }, [clearPending]);

  const submit = useCallback(async () => {
    if (!client || pendingCount === 0) return;
    const stmts = buildStatements();
    setError(null);
    setStatus(null);
    try {
      if (txMode === "manual" && !txOpen) {
        const b = await client.databaseBegin({ id: databaseId });
        if (b.error) {
          setError(b.error);
          return;
        }
        setTxOpen(true);
      }
      let affected = 0;
      for (const s of stmts) {
        const res = await client.databaseExec({ id: databaseId, sql: s.sql, params: s.params });
        if (res.error) {
          setError(res.error);
          return;
        }
        affected += res.result?.affected ?? 0;
      }
      clearPending();
      if (txMode === "manual") {
        setStatus(
          `${stmts.length} statement(s), ${affected} row(s) — uncommitted. Commit or Rollback.`,
        );
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
    clearPending,
    bumpRefresh,
    load,
    page,
  ]);

  const commit = useCallback(async () => {
    if (!client || !txOpen) return;
    const res = await client.databaseCommit({ id: databaseId });
    if (res.error) {
      setError(res.error);
      return;
    }
    setTxOpen(false);
    setStatus("Committed.");
    bumpRefresh();
    await load(page);
  }, [client, txOpen, databaseId, bumpRefresh, load, page]);

  const rollback = useCallback(async () => {
    if (!client || !txOpen) return;
    const res = await client.databaseRollback({ id: databaseId });
    if (res.error) {
      setError(res.error);
      return;
    }
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
    setStatus(
      `Exported ${rows.length} rows as JSON (${JSON.stringify(rows).length} bytes) to log.`,
    );
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(rows, null, 2));
  }, [result]);

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
  const onSubmit = useCallback(() => void submit(), [submit]);
  const onCommit = useCallback(() => void commit(), [commit]);
  const onRollback = useCallback(() => void rollback(), [rollback]);
  const setDraftField = useCallback(
    (name: string, value: string) => setEditorDraft((d) => ({ ...d, [name]: value })),
    [],
  );

  const from = page * PAGE_SIZE;
  const shown = result?.rows.length ?? 0;
  const canEdit = isSqlEngine(engine) && pkCols.length > 0;
  const previewStatements = previewOpen ? buildStatements() : [];

  let tableBody;
  if (loading && !result) {
    tableBody = (
      <View style={styles.center}>
        <ThemedSpinner size="small" uniProps={mutedColor} />
      </View>
    );
  } else if (result) {
    tableBody = (
      <EditableTable
        result={result}
        canEdit={canEdit}
        onEditRow={openEditRow}
        onDeleteRow={markDeleteRow}
      />
    );
  } else {
    tableBody = null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Text style={styles.title} numberOfLines={1}>
          {schema}.{table}
        </Text>
        <Pressable
          style={[styles.tbtn, !canEdit && styles.tbtnDisabled]}
          onPress={openAdd}
          disabled={!canEdit}
        >
          <ThemedPlus size={14} uniProps={mutedColor} />
          <Text style={styles.tbtnText}>Add</Text>
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
        {pendingCount > 0 ? (
          <Pressable style={styles.tbtn} onPress={revert}>
            <Text style={styles.tbtnText}>Revert</Text>
          </Pressable>
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

      {!canEdit && columns.length > 0 ? (
        <View style={styles.noteBar}>
          <Text style={styles.noteText}>
            {isSqlEngine(engine)
              ? "This table has no primary key — rows are read-only (editing needs a key to target a row)."
              : `Row editing isn't available for ${engine}; use the SQL console for changes.`}
          </Text>
        </View>
      ) : null}
      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {tableBody}

      <View style={styles.statusBar}>
        <Text style={styles.statusText} numberOfLines={1}>
          {status ?? `${shown} row${shown === 1 ? "" : "s"}${result?.truncated ? "+" : ""}`}
          {txOpen ? " · transaction open" : ""}
        </Text>
      </View>

      <RecordEditorModal
        open={editorOpen}
        mode={editorMode}
        columns={columns}
        draft={editorDraft}
        onChangeField={setDraftField}
        onSave={saveEditor}
        onClose={closeEditor}
      />
      <PreviewModal open={previewOpen} statements={previewStatements} onClose={closePreview} />
    </View>
  );
}

function EditableTable({
  result,
  canEdit,
  onEditRow,
  onDeleteRow,
}: {
  result: QueryResult;
  canEdit: boolean;
  onEditRow: (row: Cell[]) => void;
  onDeleteRow: (row: Cell[]) => void;
}) {
  return (
    <ScrollView horizontal style={styles.hScroll}>
      <View>
        <View style={styles.headerRow}>
          <View style={styles.gutter} />
          {result.columns.map((col) => (
            <View key={col.name} style={styles.cell}>
              <Text style={styles.headerText} numberOfLines={1}>
                {col.name}
              </Text>
            </View>
          ))}
        </View>
        <ScrollView style={styles.vScroll}>
          {result.rows.map((row, r) => (
            // Positional rows: index is the correct key for an arbitrary result.
            <EditableRow
              // eslint-disable-next-line react/no-array-index-key
              key={r}
              row={row}
              alt={r % 2 === 1}
              canEdit={canEdit}
              onEdit={onEditRow}
              onDelete={onDeleteRow}
            />
          ))}
        </ScrollView>
      </View>
    </ScrollView>
  );
}

function EditableRow({
  row,
  alt,
  canEdit,
  onEdit,
  onDelete,
}: {
  row: Cell[];
  alt: boolean;
  canEdit: boolean;
  onEdit: (row: Cell[]) => void;
  onDelete: (row: Cell[]) => void;
}) {
  const handleEdit = useCallback(() => onEdit(row), [onEdit, row]);
  const handleDelete = useCallback(() => onDelete(row), [onDelete, row]);
  return (
    <View style={[styles.bodyRow, alt && styles.bodyRowAlt]}>
      <View style={styles.gutter}>
        {canEdit ? (
          <>
            <Pressable onPress={handleEdit} hitSlop={6} accessibilityLabel="Edit row">
              <ThemedPencil size={13} uniProps={mutedColor} />
            </Pressable>
            <Pressable onPress={handleDelete} hitSlop={6} accessibilityLabel="Delete row">
              <ThemedTrash size={13} uniProps={mutedColor} />
            </Pressable>
          </>
        ) : null}
      </View>
      {row.map((cell, c) => (
        // Cells are positional within a row (no column name is threaded here).
        // eslint-disable-next-line react/no-array-index-key
        <View key={c} style={styles.cell}>
          <Text style={[styles.bodyText, cell === null && styles.nullText]} numberOfLines={1}>
            {cell === null ? "NULL" : String(cell)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function RecordEditorModal({
  open,
  mode,
  columns,
  draft,
  onChangeField,
  onSave,
  onClose,
}: {
  open: boolean;
  mode: "add" | "edit";
  columns: DbColumn[];
  draft: Record<string, string>;
  onChangeField: (name: string, value: string) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{mode === "add" ? "Add row" : "Edit row"}</Text>
          <ScrollView style={styles.modalScroll}>
            {columns.map((col) => (
              <RecordField
                key={col.name}
                column={col}
                value={draft[col.name] ?? ""}
                onChange={onChangeField}
              />
            ))}
          </ScrollView>
          <View style={styles.modalActions}>
            <Pressable style={[styles.tbtn, styles.tbtnPrimary]} onPress={onSave}>
              <Text style={styles.tbtnPrimaryText}>
                {mode === "add" ? "Add to pending" : "Stage change"}
              </Text>
            </Pressable>
            <Pressable style={styles.tbtn} onPress={onClose}>
              <Text style={styles.tbtnText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function RecordField({
  column,
  value,
  onChange,
}: {
  column: DbColumn;
  value: string;
  onChange: (name: string, value: string) => void;
}) {
  const handleChange = useCallback(
    (v: string) => onChange(column.name, v),
    [column.name, onChange],
  );
  return (
    <View style={styles.recordField}>
      <Text style={styles.recordLabel}>
        {column.name}
        <Text style={styles.recordType}>
          {"  "}
          {column.dataType}
          {column.isPrimaryKey ? " · PK" : ""}
        </Text>
      </Text>
      <ThemedRecordInput
        style={styles.recordInput}
        value={value}
        onChangeText={handleChange}
        placeholder={column.nullable ? "NULL" : ""}
        autoCapitalize="none"
        autoCorrect={false}
        uniProps={placeholderColor}
      />
    </View>
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
              // Statement list is a positional preview snapshot.
              // eslint-disable-next-line react/no-array-index-key
              <View key={i} style={styles.previewItem}>
                <Text style={styles.previewSql}>{s.sql}</Text>
                <Text style={styles.previewParams}>params: {JSON.stringify(s.params)}</Text>
              </View>
            ))}
            {statements.length === 0 ? (
              <Text style={styles.recordType}>No pending changes.</Text>
            ) : null}
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

const ThemedRecordInput = withUnistyles(TextInput);

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
  hScroll: { flex: 1, minHeight: 0 },
  headerRow: {
    flexDirection: "row",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  gutter: {
    width: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1.5],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
  cell: {
    width: 160,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: theme.colors.border,
  },
  headerText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  vScroll: { minHeight: 0 },
  bodyRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  bodyRowAlt: { backgroundColor: theme.colors.surface1 },
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
    maxWidth: 520,
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
  modalActions: { flexDirection: "row", gap: theme.spacing[2] },
  recordField: { gap: theme.spacing[1], marginBottom: theme.spacing[2] },
  recordLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  recordType: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.normal,
  },
  recordInput: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
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
