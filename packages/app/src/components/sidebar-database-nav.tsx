import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import * as Clipboard from "expo-clipboard";
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  Copy,
  Database as DatabaseIcon,
  Eye,
  KeyRound,
  Layers,
  Pencil,
  RefreshCw,
  Search,
  Share2,
  Table as TableIcon,
  Terminal,
  Trash2,
} from "lucide-react-native";
import { router } from "expo-router";
import type {
  DatabaseInfo,
  DbColumn,
  DbDatabaseName,
  DbObject,
  DbSchema,
} from "@jagentdesk/protocol/database/rpc-schemas";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { DatabaseStatusDot } from "@/components/database-dot";
import { useDatabaseNavStore, type SelectedDbObject } from "@/stores/database-nav-store";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildDatabasesRoute } from "@/utils/host-routes";
import { isWeb } from "@/constants/platform";
import { buildCreateTableDdl } from "@/utils/sql-ddl";
import { qualifyTable, quoteIdent } from "@/utils/sql-ident";
import type { DatabaseEngine } from "@jagentdesk/protocol/database/rpc-schemas";
import type { Theme } from "@/styles/theme";

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
const ThemedCopy = withUnistyles(Copy);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const faintColor = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

/** Right-click on desktop (web/Electron), long-press on touch — DataGrip's menu. */
function contextProps(onMenu: () => void): object {
  return isWeb
    ? {
        onContextMenu: (e: { preventDefault?: () => void }) => {
          e?.preventDefault?.();
          onMenu();
        },
      }
    : {};
}

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
  onPress,
  testID,
}: {
  kind: "database" | "schema";
  expanded: boolean;
  label: string;
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
  onMenu,
}: {
  client: DaemonClient | null;
  id: string;
  object: DbObject;
  active: boolean;
  filter: string;
  refreshKey: number;
  onSelect: (object: SelectedDbObject) => void;
  onMenu: (object: SelectedDbObject) => void;
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
  const menu = useCallback(() => onMenu(target), [onMenu, target]);
  const isView = object.kind === "view" || object.kind === "materialized_view";
  const icon = isView ? (
    <ThemedEye size={14} uniProps={mutedColor} />
  ) : (
    <ThemedTable size={14} uniProps={mutedColor} />
  );
  if (filter && !object.name.toLowerCase().includes(filter)) return null;
  return (
    <View>
      <Pressable
        style={[styles.row, active && styles.rowActive]}
        onPress={select}
        onLongPress={menu}
        testID={`db-table-${object.name}`}
        {...(contextProps(menu) as object)}
      >
        <Pressable onPress={toggle} hitSlop={6} style={styles.chevronBtn}>
          <Chevron expanded={expanded} />
        </Pressable>
        {icon}
        <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>
          {object.name}
        </Text>
      </Pressable>
      {expanded ? (
        <View style={styles.childIndent}>
          {columns.map((c) => (
            <ColumnRow key={c.name} column={c} />
          ))}
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
  onMenu,
}: {
  client: DaemonClient | null;
  id: string;
  schema: string;
  autoExpand: boolean;
  filter: string;
  refreshKey: number;
  selectedObject: SelectedDbObject | null;
  onSelect: (object: SelectedDbObject) => void;
  onMenu: (object: SelectedDbObject) => void;
}) {
  const [expanded, setExpanded] = useState(autoExpand);
  const [objects, setObjects] = useState<DbObject[]>([]);
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    void client
      .databaseObjects({ id, schema })
      .then((res) => {
        if (!cancelled && !res.error) setObjects(res.objects);
        return undefined;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, client, id, schema, refreshKey]);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const tables = useMemo(
    () =>
      objects.filter(
        (o) => o.kind === "table" || o.kind === "view" || o.kind === "materialized_view",
      ),
    [objects],
  );
  const tableList = tables.map((o) => (
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
      onMenu={onMenu}
    />
  ));
  if (autoExpand) return <View>{tableList}</View>;
  return (
    <View>
      <TreeRow kind="schema" expanded={expanded} label={schema} onPress={toggle} />
      {expanded ? <View style={styles.childIndent}>{tableList}</View> : null}
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
  onMenu,
}: {
  client: DaemonClient | null;
  parentId: string;
  dbName: string;
  multiDb: boolean;
  filter: string;
  refreshKey: number;
  selectedObject: SelectedDbObject | null;
  onSelect: (object: SelectedDbObject) => void;
  onMenu: (object: SelectedDbObject) => void;
}) {
  const [expanded, setExpanded] = useState(!multiDb);
  const [schemas, setSchemas] = useState<DbSchema[]>([]);
  const id = multiDb ? `${parentId}::${dbName}` : parentId;
  useEffect(() => {
    if (!expanded || !client) return;
    let cancelled = false;
    void (async () => {
      if (multiDb) {
        const opened = await client
          .databaseOpenDatabase({ id: parentId, database: dbName })
          .catch(() => null);
        if (cancelled || !opened || opened.error) return;
      }
      const res = await client.databaseSchemas({ id }).catch(() => null);
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
      onMenu={onMenu}
    />
  ));
  if (!multiDb) return <View>{schemaList}</View>;
  return (
    <View>
      <TreeRow
        kind="database"
        expanded={expanded}
        label={dbName}
        onPress={toggle}
        testID={`database-node-${dbName}`}
      />
      {expanded ? <View style={styles.childIndent}>{schemaList}</View> : null}
    </View>
  );
}

/** Right-click / long-press menu on a table. */
function TableMenu({
  object,
  onClose,
  onOpen,
  onRefresh,
  onCopyName,
  onCopyDdl,
  onRename,
  onTruncate,
  onDrop,
}: {
  object: SelectedDbObject;
  onClose: () => void;
  onOpen: () => void;
  onRefresh: () => void;
  onCopyName: () => void;
  onCopyDdl: () => void;
  onRename: () => void;
  onTruncate: () => void;
  onDrop: () => void;
}) {
  return (
    <Modal transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <View style={styles.menu}>
          <Text style={styles.menuTitle} numberOfLines={1}>
            {object.schema}.{object.name}
          </Text>
          <MenuItem icon="open" label="Open data" onPress={onOpen} />
          <MenuItem icon="refresh" label="Refresh" onPress={onRefresh} />
          <MenuItem icon="copy" label="Copy name" onPress={onCopyName} />
          <MenuItem icon="copy" label="Copy DDL" onPress={onCopyDdl} />
          <View style={styles.menuSep} />
          <MenuItem icon="rename" label="Rename…" onPress={onRename} />
          <MenuItem icon="delete" label="Truncate…" onPress={onTruncate} />
          <MenuItem icon="delete" label="Drop table…" onPress={onDrop} />
        </View>
      </Pressable>
    </Modal>
  );
}

type MenuIcon = "open" | "refresh" | "copy" | "rename" | "delete";
function MenuItemIcon({ icon }: { icon: MenuIcon }) {
  if (icon === "open") return <ThemedTable size={14} uniProps={mutedColor} />;
  if (icon === "refresh") return <ThemedRefresh size={14} uniProps={mutedColor} />;
  if (icon === "copy") return <ThemedCopy size={14} uniProps={mutedColor} />;
  if (icon === "rename") return <ThemedPencil size={14} uniProps={mutedColor} />;
  return <ThemedTrash size={14} uniProps={mutedColor} />;
}
function MenuItem({
  icon,
  label,
  onPress,
}: {
  icon: MenuIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.menuItem} onPress={onPress}>
      <MenuItemIcon icon={icon} />
      <Text style={styles.menuItemText}>{label}</Text>
    </Pressable>
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
  const ensureDatabase = useDatabaseNavStore((s) => s.ensureDatabase);
  const openTable = useDatabaseViewStore((s) => s.openTable);
  const listRefreshKey = useDatabaseViewStore((s) => s.listRefreshKey);
  const bumpRefresh = useDatabaseViewStore((s) => s.bumpRefresh);
  const showMobileAgent = usePanelStore((s) => s.showMobileAgent);
  const isCompact = useIsCompactFormFactor();

  const [menuObject, setMenuObject] = useState<SelectedDbObject | null>(null);
  const [renameObject, setRenameObject] = useState<SelectedDbObject | null>(null);
  const [dropObject, setDropObject] = useState<SelectedDbObject | null>(null);
  const [truncateObject, setTruncateObject] = useState<SelectedDbObject | null>(null);

  useEffect(() => {
    ensureDatabase(databaseId);
  }, [databaseId, ensureDatabase]);

  useEffect(() => {
    if (!client || !isConnected) return;
    void client
      .databaseList()
      .then((res) => {
        if (!res.error) setDatabase(res.databases.find((d) => d.id === databaseId) ?? null);
        return undefined;
      })
      .catch(() => {});
    void client
      .databaseDatabases({ id: databaseId })
      .then((res) => {
        if (!res.error) setDatabases(res.databases);
        return undefined;
      })
      .catch(() => {});
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
  const openMenu = useCallback((object: SelectedDbObject) => setMenuObject(object), []);
  const handleRefreshAll = useCallback(() => bumpRefresh(), [bumpRefresh]);
  const handleSelectConsole = useCallback(() => {
    selectConsole(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectConsole, isCompact, showMobileAgent]);
  const handleSelectEr = useCallback(() => {
    selectEr(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectEr, isCompact, showMobileAgent]);

  const runDdl = useCallback(
    async (target: SelectedDbObject, sql: string) => {
      if (!client) return;
      await client.databaseExec({ id: target.databaseId, sql }).catch(() => null);
      bumpRefresh();
    },
    [client, bumpRefresh],
  );
  const closeMenu = useCallback(() => setMenuObject(null), []);
  const menuOpen = useCallback(() => {
    if (menuObject) commitSelection(menuObject);
    setMenuObject(null);
  }, [menuObject, commitSelection]);
  const menuRefresh = useCallback(() => {
    bumpRefresh();
    setMenuObject(null);
  }, [bumpRefresh]);
  const menuCopyName = useCallback(() => {
    if (menuObject) void Clipboard.setStringAsync(`${menuObject.schema}.${menuObject.name}`);
    setMenuObject(null);
  }, [menuObject]);
  const menuCopyDdl = useCallback(async () => {
    const t = menuObject;
    setMenuObject(null);
    if (!client || !t) return;
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
  }, [client, menuObject, engine]);
  const menuRename = useCallback(() => {
    setRenameObject(menuObject);
    setMenuObject(null);
  }, [menuObject]);
  const menuTruncate = useCallback(() => {
    setTruncateObject(menuObject);
    setMenuObject(null);
  }, [menuObject]);
  const menuDrop = useCallback(() => {
    setDropObject(menuObject);
    setMenuObject(null);
  }, [menuObject]);

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

      <View style={styles.header}>
        <DatabaseStatusDot state={database?.state ?? "connected"} />
        <Text style={styles.headerName} numberOfLines={1}>
          {database?.displayName ?? "Database"}
        </Text>
        <Pressable
          style={styles.iconBtn}
          onPress={handleSelectConsole}
          accessibilityLabel="SQL console"
        >
          <ThemedTerminal size={15} uniProps={showingConsole ? mutedColor : mutedColor} />
        </Pressable>
        <Pressable style={styles.iconBtn} onPress={handleSelectEr} accessibilityLabel="ER diagram">
          <ThemedShare2 size={15} uniProps={showingEr ? mutedColor : mutedColor} />
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
            onMenu={openMenu}
          />
        ))}
      </ScrollView>

      {menuObject ? (
        <TableMenu
          object={menuObject}
          onClose={closeMenu}
          onOpen={menuOpen}
          onRefresh={menuRefresh}
          onCopyName={menuCopyName}
          onCopyDdl={menuCopyDdl}
          onRename={menuRename}
          onTruncate={menuTruncate}
          onDrop={menuDrop}
        />
      ) : null}
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
  headerName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  iconBtn: { padding: 4, borderRadius: theme.borderRadius.sm },
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
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.28)",
    justifyContent: "center",
    alignItems: "center",
  },
  menu: {
    minWidth: 220,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingVertical: theme.spacing[1],
  },
  menuTitle: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
    fontFamily: theme.fontFamily.mono,
  },
  menuSep: {
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
    marginVertical: theme.spacing[1],
  },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  menuItemText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
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
