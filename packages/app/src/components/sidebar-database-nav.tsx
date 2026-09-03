import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import {
  Braces,
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Database as DatabaseIcon,
  Eye,
  Folder,
  Hash,
  KeyRound,
  Layers,
  Link2,
  Pencil,
  RefreshCw,
  Search,
  Share2,
  Sparkles,
  Table as TableIcon,
  Terminal,
  Trash2,
} from "lucide-react-native";
import { router } from "expo-router";
import type {
  DatabaseInfo,
  DbColumn,
  DbDatabaseName,
  DbForeignKey,
  DbIndex,
  DbObject,
  DbRoutine,
  DbSchema,
} from "@jagentdesk/protocol/database/rpc-schemas";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { DatabaseStatusDot } from "@/components/database-dot";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useDatabaseNavStore, type SelectedDbObject } from "@/stores/database-nav-store";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { useDatabaseChatStore } from "@/stores/database-chat-store";
import { usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildDatabasesRoute } from "@/utils/host-routes";
import { buildCreateTableDdl } from "@/utils/sql-ddl";
import { qualifyTable, quoteIdent } from "@/utils/sql-ident";
import type { DatabaseEngine } from "@jagentdesk/protocol/database/rpc-schemas";
import type { Theme } from "@/styles/theme";

/** The daemon returns this while introspection races ahead of the parent
 *  connect — common on a cold tailnet open, where a deep link mounts the tree
 *  before the live client is ready in daemon memory. */
const DB_NOT_CONNECTED = "database is not connected";

/** Re-issue an introspection RPC while the connection is still coming up. Only
 *  the "database is not connected" race (or a transient rejection) is retried; a
 *  real error is returned as-is. Without this a cold tailnet open renders an
 *  empty schema (only static folders) until the user manually refreshes. */
async function retryWhileConnecting<T extends { error: string | null }>(
  call: () => Promise<T>,
  isCancelled: () => boolean,
  attempts = 6,
  delayMs = 400,
): Promise<T | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (isCancelled()) return null;
    const res = await call().catch(() => null);
    if (isCancelled()) return null;
    if (res && res.error !== DB_NOT_CONNECTED) return res;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedDatabase = withUnistyles(DatabaseIcon);
const ThemedLayers = withUnistyles(Layers);
const ThemedTable = withUnistyles(TableIcon);
const ThemedEye = withUnistyles(Eye);
const ThemedKey = withUnistyles(KeyRound);
const ThemedTerminal = withUnistyles(Terminal);
const ThemedShare2 = withUnistyles(Share2);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedSearch = withUnistyles(Search);
const ThemedSparkles = withUnistyles(Sparkles);
const accentIcon = (theme: Theme) => ({ color: theme.colors.accent });
const ThemedCopy = withUnistyles(Copy);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const ThemedHash = withUnistyles(Hash);
const ThemedLink = withUnistyles(Link2);
const ThemedFunc = withUnistyles(Braces);
const ThemedFolder = withUnistyles(Folder);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const faintColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/** Expand/collapse chevron (or blank spacer when not expandable). */
function Chevron({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <ThemedChevronDown size={12} uniProps={faintColor} />
  ) : (
    <ThemedChevronRight size={12} uniProps={faintColor} />
  );
}

/** A dense tree row for a database or schema node (chevron + icon + label). */
function TreeRow({
  kind,
  expanded,
  label,
  count,
  onPress,
  testID,
}: {
  kind: "database" | "schema";
  expanded: boolean;
  label: string;
  count?: number;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress} testID={testID}>
      <Chevron expanded={expanded} />
      {kind === "database" ? (
        <ThemedDatabase size={14} uniProps={mutedColor} />
      ) : (
        <ThemedLayers size={14} uniProps={mutedColor} />
      )}
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      {count != null ? <Text style={styles.rowCount}>{count}</Text> : null}
    </Pressable>
  );
}

function ColumnRow({ column }: { column: DbColumn }) {
  return (
    <View style={[styles.row, styles.columnRow]}>
      <View style={styles.chevronSpace} />
      {column.isPrimaryKey ? (
        <ThemedKey size={13} uniProps={mutedColor} />
      ) : (
        <View style={styles.colDot} />
      )}
      <Text style={styles.colName} numberOfLines={1}>
        {column.name}
      </Text>
      <Text style={styles.colType} numberOfLines={1}>
        {column.dataType}
      </Text>
    </View>
  );
}

/** A leaf row for an index / foreign key / routine under a table or schema. */
function LeafIcon({ icon }: { icon: "index" | "fk" | "routine" }) {
  if (icon === "index") return <ThemedHash size={12} uniProps={faintColor} />;
  if (icon === "fk") return <ThemedLink size={12} uniProps={faintColor} />;
  return <ThemedFunc size={12} uniProps={faintColor} />;
}

function LeafRow({
  icon,
  label,
  meta,
}: {
  icon: "index" | "fk" | "routine";
  label: string;
  meta?: string;
}) {
  return (
    <View style={[styles.row, styles.columnRow]}>
      <View style={styles.chevronSpace} />
      <LeafIcon icon={icon} />
      <Text style={styles.colName} numberOfLines={1}>
        {label}
      </Text>
      {meta ? (
        <Text style={styles.colType} numberOfLines={1}>
          {meta}
        </Text>
      ) : null}
    </View>
  );
}

/** The generic collapsible folder header (Indexes / Foreign keys / Views / …). */
function FolderRow({
  label,
  count,
  expanded,
  onPress,
}: {
  label: string;
  count?: number;
  expanded: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <Chevron expanded={expanded} />
      <ThemedFolder size={13} uniProps={faintColor} />
      <Text style={styles.folderLabel} numberOfLines={1}>
        {label}
      </Text>
      {count != null ? <Text style={styles.folderCount}>{count}</Text> : null}
    </Pressable>
  );
}

/** Indexes folder under a table — lazy-loads on expand. */
function IndexesFolder({
  client,
  id,
  schema,
  table,
  refreshKey,
}: {
  client: DaemonClient | null;
  id: string;
  schema: string;
  table: string;
  refreshKey: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<DbIndex[] | null>(null);
  const indexMeta = (ix: DbIndex): string => {
    let prefix = "";
    if (ix.primary) prefix = "PK · ";
    else if (ix.unique) prefix = "UNIQUE · ";
    return `${prefix}${ix.columns.join(", ")}`;
  };
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    void client
      .databaseIndexes({ id, schema, table })
      .then((r) => {
        if (!cancelled) setItems(r.error ? [] : r.indexes);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, client, id, schema, table, refreshKey]);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  return (
    <View>
      <FolderRow label="Indexes" count={items?.length} expanded={expanded} onPress={toggle} />
      {expanded && items ? (
        <View style={styles.childIndent}>
          {items.map((ix) => (
            <LeafRow key={ix.name} icon="index" label={ix.name} meta={indexMeta(ix)} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Foreign-keys folder under a table — lazy-loads the schema's FKs and filters. */
function ForeignKeysFolder({
  client,
  id,
  schema,
  table,
  refreshKey,
}: {
  client: DaemonClient | null;
  id: string;
  schema: string;
  table: string;
  refreshKey: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<DbForeignKey[] | null>(null);
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    void client
      .databaseForeignKeys({ id, schema })
      .then((r) => {
        if (!cancelled) setItems(r.error ? [] : r.foreignKeys.filter((f) => f.table === table));
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, client, id, schema, table, refreshKey]);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  return (
    <View>
      <FolderRow label="Foreign keys" count={items?.length} expanded={expanded} onPress={toggle} />
      {expanded && items ? (
        <View style={styles.childIndent}>
          {items.map((f) => (
            <LeafRow
              key={`${f.column}-${f.refTable}`}
              icon="fk"
              label={f.column}
              meta={`→ ${f.refTable}.${f.refColumn}`}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Routines folder under a schema — lazy-loads functions/procedures. */
function RoutinesFolder({
  client,
  id,
  schema,
  refreshKey,
}: {
  client: DaemonClient | null;
  id: string;
  schema: string;
  refreshKey: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<DbRoutine[] | null>(null);
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    void client
      .databaseRoutines({ id, schema })
      .then((r) => {
        if (!cancelled) setItems(r.error ? [] : r.routines);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, client, id, schema, refreshKey]);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  return (
    <View>
      <FolderRow label="Routines" count={items?.length} expanded={expanded} onPress={toggle} />
      {expanded && items ? (
        <View style={styles.childIndent}>
          {items.map((r) => (
            <LeafRow
              key={`${r.kind}-${r.name}`}
              icon="routine"
              label={r.name}
              meta={r.kind === "procedure" ? "proc" : (r.returnType ?? "fn")}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** A simple folder listing objects already fetched (Views / Sequences). */
function ObjectFolder({ label, objects }: { label: string; objects: DbObject[] }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  if (objects.length === 0) return null;
  return (
    <View>
      <FolderRow label={label} count={objects.length} expanded={expanded} onPress={toggle} />
      {expanded ? (
        <View style={styles.childIndent}>
          {objects.map((o) => (
            <View key={o.name} style={[styles.row, styles.columnRow]}>
              <View style={styles.chevronSpace} />
              {label === "Views" ? (
                <ThemedEye size={13} uniProps={mutedColor} />
              ) : (
                <ThemedHash size={12} uniProps={faintColor} />
              )}
              <Text style={styles.colName} numberOfLines={1}>
                {o.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The right-click / long-press actions for a table/object row. Each row wires
 *  its own trigger, so right-click hits the row under the cursor directly —
 *  no prior selection required. */
type TableActions = {
  onOpen: (target: SelectedDbObject) => void;
  onRefresh: () => void;
  onCopyName: (target: SelectedDbObject) => void;
  onCopyDdl: (target: SelectedDbObject) => void;
  onRename: (target: SelectedDbObject) => void;
  onTruncate: (target: SelectedDbObject) => void;
  onDrop: (target: SelectedDbObject) => void;
};

/** A table/view node: expand → columns; select → open data; right-click → menu. */
// eslint-disable-next-line complexity
function TableNode({
  client,
  id,
  object,
  active,
  filter,
  refreshKey,
  onSelect,
  actions,
}: {
  client: DaemonClient | null;
  id: string;
  object: DbObject;
  active: boolean;
  filter: string;
  refreshKey: number;
  onSelect: (object: SelectedDbObject) => void;
  actions: TableActions;
}) {
  const [expanded, setExpanded] = useState(false);
  const [columns, setColumns] = useState<DbColumn[]>([]);
  const target = useMemo<SelectedDbObject>(
    () => ({ databaseId: id, schema: object.schema, name: object.name }),
    [id, object.schema, object.name],
  );
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    void client
      .databaseColumns({ id, schema: object.schema, table: object.name })
      .then((res) => {
        if (!cancelled && !res.error) setColumns(res.columns);
        return undefined;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, client, id, object.schema, object.name, refreshKey]);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const select = useCallback(() => onSelect(target), [onSelect, target]);
  const openData = useCallback(() => actions.onOpen(target), [actions, target]);
  const copyName = useCallback(() => actions.onCopyName(target), [actions, target]);
  const copyDdl = useCallback(() => actions.onCopyDdl(target), [actions, target]);
  const rename = useCallback(() => actions.onRename(target), [actions, target]);
  const truncate = useCallback(() => actions.onTruncate(target), [actions, target]);
  const drop = useCallback(() => actions.onDrop(target), [actions, target]);
  const isView = object.kind === "view" || object.kind === "materialized_view";
  const icon = isView ? (
    <ThemedEye size={14} uniProps={mutedColor} />
  ) : (
    <ThemedTable size={14} uniProps={mutedColor} />
  );
  if (filter && !object.name.toLowerCase().includes(filter)) return null;
  return (
    <View>
      <ContextMenu>
        <ContextMenuTrigger
          enabledOnMobile
          style={[styles.row, active && styles.rowActive]}
          onPress={select}
          testID={`db-table-${object.name}`}
        >
          <Pressable onPress={toggle} hitSlop={6} style={styles.chevronBtn}>
            <Chevron expanded={expanded} />
          </Pressable>
          {icon}
          <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>
            {object.name}
          </Text>
          {object.columnCount != null ? (
            <Text style={styles.rowCount}>{object.columnCount}</Text>
          ) : null}
        </ContextMenuTrigger>
        <ContextMenuContent align="start" width={220} testID={`db-table-menu-${object.name}`}>
          <ContextMenuLabel>{`${object.schema}.${object.name}`}</ContextMenuLabel>
          <ContextMenuItem
            leading={<ThemedTable size={14} uniProps={mutedColor} />}
            onSelect={openData}
          >
            Open data
          </ContextMenuItem>
          <ContextMenuItem
            leading={<ThemedRefresh size={14} uniProps={mutedColor} />}
            onSelect={actions.onRefresh}
          >
            Refresh
          </ContextMenuItem>
          <ContextMenuItem
            leading={<ThemedCopy size={14} uniProps={mutedColor} />}
            onSelect={copyName}
          >
            Copy name
          </ContextMenuItem>
          <ContextMenuItem
            leading={<ThemedCopy size={14} uniProps={mutedColor} />}
            onSelect={copyDdl}
          >
            Copy DDL
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            leading={<ThemedPencil size={14} uniProps={mutedColor} />}
            onSelect={rename}
          >
            Rename…
          </ContextMenuItem>
          <ContextMenuItem
            destructive
            leading={<ThemedTrash size={14} uniProps={mutedColor} />}
            onSelect={truncate}
          >
            Truncate…
          </ContextMenuItem>
          <ContextMenuItem
            destructive
            leading={<ThemedTrash size={14} uniProps={mutedColor} />}
            onSelect={drop}
          >
            Drop table…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {expanded ? (
        <View style={styles.childIndent}>
          {columns.map((c) => (
            <ColumnRow key={c.name} column={c} />
          ))}
          {object.kind === "table" ? (
            <IndexesFolder
              client={client}
              id={id}
              schema={object.schema}
              table={object.name}
              refreshKey={refreshKey}
            />
          ) : null}
          {object.kind === "table" ? (
            <ForeignKeysFolder
              client={client}
              id={id}
              schema={object.schema}
              table={object.name}
              refreshKey={refreshKey}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A schema node: expand → tables/views (grouped). */
function SchemaNode({
  client,
  id,
  schema,
  autoExpand,
  filter,
  refreshKey,
  selectedObject,
  onSelect,
  actions,
  onTableCount,
}: {
  client: DaemonClient | null;
  id: string;
  schema: string;
  autoExpand: boolean;
  filter: string;
  refreshKey: number;
  selectedObject: SelectedDbObject | null;
  onSelect: (object: SelectedDbObject) => void;
  actions: TableActions;
  onTableCount?: (schema: string, count: number) => void;
}) {
  const [expanded, setExpanded] = useState(autoExpand);
  const [objects, setObjects] = useState<DbObject[]>([]);
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    void retryWhileConnecting(
      () => client.databaseObjects({ id, schema }),
      () => cancelled,
    ).then((res) => {
      if (!cancelled && res && !res.error) {
        setObjects(res.objects);
        onTableCount?.(schema, res.objects.filter((o) => o.kind === "table").length);
      }
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [expanded, client, id, schema, refreshKey, onTableCount]);
  const [viewsExpanded, setViewsExpanded] = useState(false);
  const toggleViews = useCallback(() => setViewsExpanded((v) => !v), []);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const tables = useMemo(() => objects.filter((o) => o.kind === "table"), [objects]);
  const views = useMemo(
    () => objects.filter((o) => o.kind === "view" || o.kind === "materialized_view"),
    [objects],
  );
  const sequences = useMemo(() => objects.filter((o) => o.kind === "sequence"), [objects]);
  const renderObject = (o: DbObject) => (
    <TableNode
      key={o.name}
      client={client}
      id={id}
      object={o}
      active={
        selectedObject?.databaseId === id &&
        selectedObject?.schema === o.schema &&
        selectedObject?.name === o.name
      }
      filter={filter}
      refreshKey={refreshKey}
      onSelect={onSelect}
      actions={actions}
    />
  );
  const body = (
    <>
      {tables.map(renderObject)}
      {views.length > 0 ? (
        <View>
          <FolderRow
            label="Views"
            count={views.length}
            expanded={viewsExpanded}
            onPress={toggleViews}
          />
          {viewsExpanded ? <View style={styles.childIndent}>{views.map(renderObject)}</View> : null}
        </View>
      ) : null}
      <ObjectFolder label="Sequences" objects={sequences} />
      <RoutinesFolder client={client} id={id} schema={schema} refreshKey={refreshKey} />
    </>
  );
  if (autoExpand) return <View>{body}</View>;
  return (
    <View>
      <TreeRow kind="schema" expanded={expanded} label={schema} onPress={toggle} />
      {expanded ? <View style={styles.childIndent}>{body}</View> : null}
    </View>
  );
}

/** A database node under a connection: resolves its id (child client for multi-db)
 *  then renders its schemas → tables. */
function DatabaseNode({
  client,
  parentId,
  dbName,
  multiDb,
  filter,
  refreshKey,
  selectedObject,
  onSelect,
  actions,
}: {
  client: DaemonClient | null;
  parentId: string;
  dbName: string;
  multiDb: boolean;
  filter: string;
  refreshKey: number;
  selectedObject: SelectedDbObject | null;
  onSelect: (object: SelectedDbObject) => void;
  actions: TableActions;
}) {
  const [expanded, setExpanded] = useState(!multiDb);
  const [schemas, setSchemas] = useState<DbSchema[]>([]);
  const [tableCounts, setTableCounts] = useState<Record<string, number>>({});
  const handleTableCount = useCallback(
    (schema: string, count: number) => setTableCounts((prev) => ({ ...prev, [schema]: count })),
    [],
  );
  const totalTables = useMemo(
    () => Object.values(tableCounts).reduce((a, b) => a + b, 0),
    [tableCounts],
  );
  const id = multiDb ? `${parentId}::${dbName}` : parentId;
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    void (async () => {
      if (multiDb) {
        const opened = await retryWhileConnecting(
          () => client.databaseOpenDatabase({ id: parentId, database: dbName }),
          () => cancelled,
        );
        if (cancelled || !opened || opened.error) return;
      }
      const res = await retryWhileConnecting(
        () => client.databaseSchemas({ id }),
        () => cancelled,
      );
      if (!cancelled && res && !res.error) setSchemas(res.schemas);
    })();
    return () => {
      cancelled = true;
    };
  }, [expanded, client, parentId, dbName, id, multiDb, refreshKey]);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const singleSchema = schemas.length === 1;
  const schemaList = schemas.map((s) => (
    <SchemaNode
      key={s.name}
      client={client}
      id={id}
      schema={s.name}
      autoExpand={singleSchema}
      filter={filter}
      refreshKey={refreshKey}
      selectedObject={selectedObject}
      onSelect={onSelect}
      actions={actions}
      onTableCount={handleTableCount}
    />
  ));
  if (!multiDb) return <View>{schemaList}</View>;
  return (
    <View>
      <TreeRow
        kind="database"
        expanded={expanded}
        label={dbName}
        count={expanded && totalTables > 0 ? totalTables : undefined}
        onPress={toggle}
        testID={`database-node-${dbName}`}
      />
      {expanded ? <View style={styles.childIndent}>{schemaList}</View> : null}
    </View>
  );
}

/** A prompt modal (rename input, or drop/truncate confirm). */
function Prompt({
  title,
  message,
  input,
  initial,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  message?: string;
  input?: boolean;
  initial?: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(initial ?? "");
  const submit = useCallback(() => {
    if (input && !value.trim()) return;
    onConfirm(value.trim());
  }, [input, value, onConfirm]);
  return (
    <Modal transparent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={styles.backdrop} onPress={onCancel}>
        <Pressable style={styles.prompt} onPress={stop}>
          <Text style={styles.promptTitle}>{title}</Text>
          {message ? <Text style={styles.promptMsg}>{message}</Text> : null}
          {input ? (
            <TextInput
              style={styles.promptInput}
              value={value}
              onChangeText={setValue}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={submit}
            />
          ) : null}
          <View style={styles.promptButtons}>
            <Pressable style={styles.promptBtn} onPress={onCancel}>
              <Text style={styles.promptBtnText}>Cancel</Text>
            </Pressable>
            <Pressable style={[styles.promptBtn, styles.promptBtnPrimary]} onPress={submit}>
              <Text style={styles.promptBtnTextPrimary}>{confirmLabel}</Text>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const stop = () => {};

// eslint-disable-next-line complexity
export function SidebarDatabaseNav({
  serverId,
  databaseId,
}: {
  serverId: string;
  databaseId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [databases, setDatabases] = useState<DbDatabaseName[]>([]);
  const [filter, setFilter] = useState("");

  const selectedObject = useDatabaseNavStore((s) => s.selectedObject);
  const showingConsole = useDatabaseNavStore((s) => s.showingConsole);
  const showingEr = useDatabaseNavStore((s) => s.showingEr);
  const selectObject = useDatabaseNavStore((s) => s.selectObject);
  const selectConsole = useDatabaseNavStore((s) => s.selectConsole);
  const selectEr = useDatabaseNavStore((s) => s.selectEr);
  const selectSearch = useDatabaseNavStore((s) => s.selectSearch);
  const showingSearch = useDatabaseNavStore((s) => s.showingSearch);
  const ensureDatabase = useDatabaseNavStore((s) => s.ensureDatabase);
  const openTable = useDatabaseViewStore((s) => s.openTable);
  const listRefreshKey = useDatabaseViewStore((s) => s.listRefreshKey);
  const bumpRefresh = useDatabaseViewStore((s) => s.bumpRefresh);
  const showMobileAgent = usePanelStore((s) => s.showMobileAgent);
  const chatOpen = useDatabaseChatStore((s) => s.open);
  const showChat = useDatabaseChatStore((s) => s.showChat);
  const hideChat = useDatabaseChatStore((s) => s.hideChat);
  const isCompact = useIsCompactFormFactor();

  const [renameObject, setRenameObject] = useState<SelectedDbObject | null>(null);
  const [dropObject, setDropObject] = useState<SelectedDbObject | null>(null);
  const [truncateObject, setTruncateObject] = useState<SelectedDbObject | null>(null);

  useEffect(() => {
    ensureDatabase(databaseId);
  }, [databaseId, ensureDatabase]);

  useEffect(() => {
    if (!client || !isConnected) return;
    let cancelled = false;
    void client
      .databaseList()
      .then((res) => {
        if (!cancelled && !res.error) {
          setDatabase(res.databases.find((d) => d.id === databaseId) ?? null);
        }
        return undefined;
      })
      .catch(() => {});
    // databaseDatabases queries the live server, so it races the parent connect
    // on a cold tailnet open — retry until connect settles.
    void retryWhileConnecting(
      () => client.databaseDatabases({ id: databaseId }),
      () => cancelled,
    ).then((res) => {
      if (!cancelled && res && !res.error) setDatabases(res.databases);
      return undefined;
    });
    return () => {
      cancelled = true;
    };
  }, [client, isConnected, databaseId, listRefreshKey]);
  const multiDb = databases.length > 1;
  const engine = (database?.engine ?? "postgres") as DatabaseEngine;

  const commitSelection = useCallback(
    (object: SelectedDbObject) => {
      selectObject(databaseId, object);
      openTable(object.databaseId, { schema: object.schema, name: object.name });
      if (isCompact) showMobileAgent();
    },
    [databaseId, selectObject, openTable, isCompact, showMobileAgent],
  );
  const handleRefreshAll = useCallback(() => bumpRefresh(), [bumpRefresh]);
  const handleSelectConsole = useCallback(() => {
    selectConsole(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectConsole, isCompact, showMobileAgent]);
  const handleSelectEr = useCallback(() => {
    selectEr(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectEr, isCompact, showMobileAgent]);
  const handleSelectSearch = useCallback(() => {
    selectSearch(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectSearch, isCompact, showMobileAgent]);
  const handleToggleChat = useCallback(() => {
    if (chatOpen) hideChat();
    else {
      showChat();
      if (isCompact) showMobileAgent();
    }
  }, [chatOpen, hideChat, showChat, isCompact, showMobileAgent]);

  const runDdl = useCallback(
    async (target: SelectedDbObject, sql: string) => {
      if (!client) return;
      await client.databaseExec({ id: target.databaseId, sql }).catch(() => null);
      bumpRefresh();
    },
    [client, bumpRefresh],
  );
  const copyDdl = useCallback(
    async (t: SelectedDbObject) => {
      if (!client) return;
      const [cols, fks] = await Promise.all([
        client
          .databaseColumns({ id: t.databaseId, schema: t.schema, table: t.name })
          .catch(() => null),
        client.databaseForeignKeys({ id: t.databaseId, schema: t.schema }).catch(() => null),
      ]);
      if (cols && !cols.error) {
        const edges = fks && !fks.error ? fks.foreignKeys.filter((f) => f.table === t.name) : [];
        void Clipboard.setStringAsync(
          buildCreateTableDdl(engine, t.schema, t.name, cols.columns, edges),
        );
      }
    },
    [client, engine],
  );
  // Per-row menu actions. Each row wires its own trigger and passes its own
  // target here, so right-click acts on the row under the cursor — no prior
  // selection needed.
  const tableActions = useMemo(
    () => ({
      onOpen: (t: SelectedDbObject) => commitSelection(t),
      onRefresh: () => bumpRefresh(),
      onCopyName: (t: SelectedDbObject) => void Clipboard.setStringAsync(`${t.schema}.${t.name}`),
      onCopyDdl: (t: SelectedDbObject) => void copyDdl(t),
      onRename: (t: SelectedDbObject) => setRenameObject(t),
      onTruncate: (t: SelectedDbObject) => setTruncateObject(t),
      onDrop: (t: SelectedDbObject) => setDropObject(t),
    }),
    [commitSelection, bumpRefresh, copyDdl],
  );

  const cancelRename = useCallback(() => setRenameObject(null), []);
  const submitRename = useCallback(
    (newName: string) => {
      const t = renameObject;
      setRenameObject(null);
      if (t && newName) {
        void runDdl(
          t,
          `ALTER TABLE ${qualifyTable(engine, t.schema, t.name)} RENAME TO ${quoteIdent(engine, newName)}`,
        );
      }
    },
    [renameObject, runDdl, engine],
  );
  const cancelDrop = useCallback(() => setDropObject(null), []);
  const confirmDrop = useCallback(() => {
    const t = dropObject;
    setDropObject(null);
    if (t) void runDdl(t, `DROP TABLE ${qualifyTable(engine, t.schema, t.name)}`);
  }, [dropObject, runDdl, engine]);
  const cancelTruncate = useCallback(() => setTruncateObject(null), []);
  const confirmTruncate = useCallback(() => {
    const t = truncateObject;
    setTruncateObject(null);
    if (t) void runDdl(t, `TRUNCATE TABLE ${qualifyTable(engine, t.schema, t.name)}`);
  }, [truncateObject, runDdl, engine]);

  const handleBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(buildDatabasesRoute(serverId));
  }, [serverId]);
  const handleBackToList = useCallback(() => {
    router.replace(buildDatabasesRoute(serverId));
  }, [serverId]);
  const lowerFilter = filter.trim().toLowerCase();
  const dbList = multiDb ? databases.map((d) => d.name) : [database?.currentDatabase ?? "main"];

  return (
    <View style={styles.container}>
      <View style={styles.backRow}>
        <Pressable style={styles.backBtn} onPress={handleBack} testID="database-back-previous">
          <ThemedChevronLeft size={15} uniProps={mutedColor} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <View style={styles.backDivider} />
        <Pressable style={styles.backBtn} onPress={handleBackToList} testID="database-back-list">
          <ThemedDatabase size={14} uniProps={mutedColor} />
          <Text style={styles.backText}>Databases</Text>
        </Pressable>
      </View>

      <View style={[styles.header, isCompact && styles.headerCompact]}>
        <DatabaseStatusDot state={database?.state ?? "connected"} />
        <Text style={styles.headerName} numberOfLines={1}>
          {database?.displayName ?? "Database"}
        </Text>
        <Pressable
          style={[styles.iconBtn, chatOpen && styles.iconBtnActive]}
          onPress={handleToggleChat}
          accessibilityLabel="Ask AI"
          testID="database-ask-ai"
        >
          <ThemedSparkles size={15} uniProps={chatOpen ? accentIcon : mutedColor} />
        </Pressable>
        <Pressable
          style={[styles.iconBtn, showingConsole && styles.iconBtnActive]}
          onPress={handleSelectConsole}
          accessibilityLabel="SQL console"
        >
          <ThemedTerminal size={15} uniProps={mutedColor} />
        </Pressable>
        <Pressable
          style={[styles.iconBtn, showingEr && styles.iconBtnActive]}
          onPress={handleSelectEr}
          accessibilityLabel="ER diagram"
        >
          <ThemedShare2 size={15} uniProps={mutedColor} />
        </Pressable>
        <Pressable
          style={[styles.iconBtn, showingSearch && styles.iconBtnActive]}
          onPress={handleSelectSearch}
          accessibilityLabel="Search data"
        >
          <ThemedSearch size={15} uniProps={mutedColor} />
        </Pressable>
        <Pressable
          style={styles.iconBtn}
          onPress={handleRefreshAll}
          accessibilityLabel="Refresh"
          testID="database-refresh"
        >
          <ThemedRefresh size={15} uniProps={mutedColor} />
        </Pressable>
      </View>

      <View style={styles.searchRow}>
        <ThemedSearch size={13} uniProps={faintColor} />
        <TextInput
          style={styles.searchInput}
          value={filter}
          onChangeText={setFilter}
          placeholder="Filter tables"
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      <ScrollView style={styles.tree} contentContainerStyle={styles.treeContent}>
        {dbList.map((name) => (
          <DatabaseNode
            key={name}
            client={client}
            parentId={databaseId}
            dbName={name}
            multiDb={multiDb}
            filter={lowerFilter}
            refreshKey={listRefreshKey}
            selectedObject={selectedObject}
            onSelect={commitSelection}
            actions={tableActions}
          />
        ))}
      </ScrollView>

      {renameObject ? (
        <Prompt
          title={`Rename ${renameObject.name}`}
          input
          initial={renameObject.name}
          confirmLabel="Rename"
          onCancel={cancelRename}
          onConfirm={submitRename}
        />
      ) : null}
      {dropObject ? (
        <Prompt
          title={`Drop ${dropObject.name}?`}
          message="Permanently deletes the table and its data."
          confirmLabel="Drop"
          onCancel={cancelDrop}
          onConfirm={confirmDrop}
        />
      ) : null}
      {truncateObject ? (
        <Prompt
          title={`Truncate ${truncateObject.name}?`}
          message="Deletes all rows but keeps the table."
          confirmLabel="Truncate"
          onCancel={cancelTruncate}
          onConfirm={confirmTruncate}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingVertical: 4,
  },
  backText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  backDivider: {
    width: theme.borderWidth[1],
    height: 14,
    backgroundColor: theme.colors.border,
    marginHorizontal: theme.spacing[2],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  // On mobile the sidebar overlay's absolute close (×) button sits top-right; keep
  // the header's icon toolbar (…Refresh) clear of it so they don't overlap.
  headerCompact: { paddingRight: theme.spacing[12] },
  headerName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  iconBtn: { padding: 4, borderRadius: theme.borderRadius.sm },
  iconBtnActive: { backgroundColor: theme.colors.surface2 },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    height: 26,
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
    padding: 0,
  },
  tree: { flex: 1, minHeight: 0 },
  treeContent: { paddingBottom: theme.spacing[3] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    height: 26,
    paddingHorizontal: theme.spacing[2],
  },
  rowActive: { backgroundColor: theme.colors.surfaceSidebarHover },
  rowLabel: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  rowLabelActive: { fontWeight: theme.fontWeight.medium },
  childIndent: { paddingLeft: theme.spacing[3] },
  chevronSpace: { width: 12 },
  chevronBtn: { width: 12, alignItems: "center" },
  columnRow: { height: 24 },
  colDot: { width: 13, height: 13 },
  colName: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  colType: {
    flex: 1,
    minWidth: 0,
    textAlign: "right",
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
  },
  folderLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.4,
  },
  folderCount: {
    fontSize: 10,
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
  },
  rowCount: {
    fontSize: 10,
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
    marginLeft: theme.spacing[1],
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.28)",
    justifyContent: "center",
    alignItems: "center",
  },
  prompt: {
    width: 300,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  promptTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  promptMsg: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  promptInput: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
  },
  promptButtons: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
  promptBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.sm,
  },
  promptBtnText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  promptBtnPrimary: { backgroundColor: theme.colors.accent },
  promptBtnTextPrimary: { fontSize: theme.fontSize.sm, color: theme.colors.accentForeground },
}));
