import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ChevronLeft,
  ChevronDown,
  Check,
  Database as DatabaseIcon,
  Gauge,
  GitCompare,
  Layers,
  Share2,
  Table,
  Eye,
  Terminal,
} from "lucide-react-native";
import { router } from "expo-router";
import type { DatabaseInfo, DbObject, DbSchema } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { DatabaseStatusDot } from "@/components/database-dot";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildDatabasesRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCheck = withUnistyles(Check);
const ThemedDatabase = withUnistyles(DatabaseIcon);
const ThemedGauge = withUnistyles(Gauge);
const ThemedGitCompare = withUnistyles(GitCompare);
const ThemedLayers = withUnistyles(Layers);
const ThemedShare2 = withUnistyles(Share2);
const ThemedTable = withUnistyles(Table);
const ThemedEye = withUnistyles(Eye);
const ThemedTerminal = withUnistyles(Terminal);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });

function SchemaRow({
  name,
  active,
  onSelect,
}: {
  name: string;
  active: boolean;
  onSelect: (name: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(name), [name, onSelect]);
  return (
    <Pressable
      style={[styles.schemaOption, active && styles.schemaOptionActive]}
      onPress={handlePress}
    >
      <ThemedLayers size={13} uniProps={mutedColor} />
      <Text
        style={[styles.schemaOptionText, active && styles.schemaOptionTextActive]}
        numberOfLines={1}
      >
        {name}
      </Text>
      {active ? <ThemedCheck size={13} uniProps={accentColor} /> : null}
    </Pressable>
  );
}

/** A labeled schema picker (DataGrip's "schema" dropdown), not floating pills. */
function SchemaSelect({
  schemas,
  value,
  onSelect,
}: {
  schemas: DbSchema[];
  value: string | null;
  onSelect: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((v) => !v), []);
  const pick = useCallback(
    (name: string) => {
      onSelect(name);
      setOpen(false);
    },
    [onSelect],
  );
  if (schemas.length === 0) return null;
  return (
    <View style={styles.schemaSelect}>
      <Text style={styles.schemaSelectLabel}>SCHEMA</Text>
      <Pressable style={styles.schemaTrigger} onPress={toggle}>
        <ThemedLayers size={14} uniProps={mutedColor} />
        <Text style={styles.schemaTriggerText} numberOfLines={1}>
          {value ?? "Select schema"}
        </Text>
        <ThemedChevronDown size={14} uniProps={mutedColor} />
      </Pressable>
      {open ? (
        <View style={styles.schemaMenu}>
          {schemas.map((s) => (
            <SchemaRow key={s.name} name={s.name} active={value === s.name} onSelect={pick} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function ObjectRow({
  object,
  active,
  onSelect,
}: {
  object: DbObject;
  active: boolean;
  onSelect: (object: DbObject) => void;
}) {
  const handlePress = useCallback(() => onSelect(object), [object, onSelect]);
  const isView = object.kind === "view" || object.kind === "materialized_view";
  return (
    <Pressable style={[styles.row, active && styles.rowActive]} onPress={handlePress}>
      {isView ? (
        <ThemedEye size={15} uniProps={mutedColor} />
      ) : (
        <ThemedTable size={15} uniProps={mutedColor} />
      )}
      <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>
        {object.name}
      </Text>
    </Pressable>
  );
}

export function SidebarDatabaseNav({
  serverId,
  databaseId,
}: {
  serverId: string;
  databaseId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [schemas, setSchemas] = useState<DbSchema[]>([]);
  const [objects, setObjects] = useState<DbObject[]>([]);

  const selectedSchema = useDatabaseNavStore((s) => s.selectedSchema);
  const selectedObject = useDatabaseNavStore((s) => s.selectedObject);
  const showingConsole = useDatabaseNavStore((s) => s.showingConsole);
  const showingDiff = useDatabaseNavStore((s) => s.showingDiff);
  const showingEr = useDatabaseNavStore((s) => s.showingEr);
  const showingOverview = useDatabaseNavStore((s) => s.showingOverview);
  const selectObject = useDatabaseNavStore((s) => s.selectObject);
  const selectConsole = useDatabaseNavStore((s) => s.selectConsole);
  const selectDiff = useDatabaseNavStore((s) => s.selectDiff);
  const selectEr = useDatabaseNavStore((s) => s.selectEr);
  const selectOverview = useDatabaseNavStore((s) => s.selectOverview);
  const setSchema = useDatabaseNavStore((s) => s.setSchema);
  const ensureDatabase = useDatabaseNavStore((s) => s.ensureDatabase);
  const openTable = useDatabaseViewStore((s) => s.openTable);
  const showMobileAgent = usePanelStore((s) => s.showMobileAgent);
  const isCompact = useIsCompactFormFactor();

  useEffect(() => {
    ensureDatabase(databaseId);
  }, [databaseId, ensureDatabase]);

  useEffect(() => {
    if (!client) return;
    void client
      .databaseList()
      .then((res) => {
        if (!res.error) setDatabase(res.databases.find((d) => d.id === databaseId) ?? null);
        return undefined;
      })
      .catch(() => {});
    void client
      .databaseSchemas({ id: databaseId })
      .then((res) => {
        if (!res.error) {
          setSchemas(res.schemas);
          if (res.schemas.length > 0 && !useDatabaseNavStore.getState().selectedSchema) {
            // Default to the first "real" schema (public/main), not a system one.
            const preferred =
              res.schemas.find((s) => s.name === "public" || s.name === "main") ?? res.schemas[0];
            setSchema(preferred.name);
          }
        }
        return undefined;
      })
      .catch(() => {});
  }, [client, databaseId, setSchema]);

  useEffect(() => {
    if (!client || !selectedSchema) return;
    void client
      .databaseObjects({ id: databaseId, schema: selectedSchema })
      .then((res) => {
        if (!res.error) setObjects(res.objects);
        return undefined;
      })
      .catch(() => {});
  }, [client, databaseId, selectedSchema]);

  const grouped = useMemo(() => {
    const tables = objects.filter((o) => o.kind === "table");
    const views = objects.filter((o) => o.kind === "view" || o.kind === "materialized_view");
    const other = objects.filter(
      (o) => o.kind !== "table" && o.kind !== "view" && o.kind !== "materialized_view",
    );
    const out: Array<{ category: string; objects: DbObject[] }> = [];
    if (tables.length) out.push({ category: "Tables", objects: tables });
    if (views.length) out.push({ category: "Views", objects: views });
    if (other.length) out.push({ category: "Other", objects: other });
    return out;
  }, [objects]);

  const handleSelectObject = useCallback(
    (object: DbObject) => {
      selectObject(databaseId, { schema: object.schema, name: object.name });
      openTable(databaseId, { schema: object.schema, name: object.name });
      if (isCompact) showMobileAgent();
    },
    [databaseId, selectObject, openTable, isCompact, showMobileAgent],
  );
  const handleSelectOverview = useCallback(() => {
    selectOverview(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectOverview, isCompact, showMobileAgent]);
  const handleSelectConsole = useCallback(() => {
    selectConsole(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectConsole, isCompact, showMobileAgent]);
  const handleSelectDiff = useCallback(() => {
    selectDiff(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectDiff, isCompact, showMobileAgent]);
  const handleSelectEr = useCallback(() => {
    selectEr(databaseId);
    if (isCompact) showMobileAgent();
  }, [databaseId, selectEr, isCompact, showMobileAgent]);
  const handleSelectSchema = useCallback((name: string) => setSchema(name), [setSchema]);

  const handleBackToPrevious = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(buildDatabasesRoute(serverId));
  }, [serverId]);
  const handleBackToList = useCallback(() => {
    router.replace(buildDatabasesRoute(serverId));
  }, [serverId]);

  return (
    <View style={styles.container}>
      <View style={styles.backRow}>
        <Pressable
          style={styles.backBtn}
          onPress={handleBackToPrevious}
          accessibilityLabel="Back to previous page"
          testID="database-back-previous"
        >
          <ThemedChevronLeft size={16} uniProps={mutedColor} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <View style={styles.backDivider} />
        <Pressable
          style={styles.backBtn}
          onPress={handleBackToList}
          accessibilityLabel="Back to databases list"
          testID="database-back-list"
        >
          <ThemedDatabase size={15} uniProps={mutedColor} />
          <Text style={styles.backText}>Databases</Text>
        </Pressable>
      </View>

      <View style={styles.dbCard}>
        <DatabaseStatusDot state={database?.state ?? "connected"} />
        <Text style={styles.dbName} numberOfLines={1}>
          {database?.displayName ?? "Database"}
        </Text>
      </View>

      <SchemaSelect schemas={schemas} value={selectedSchema} onSelect={handleSelectSchema} />

      <ScrollView style={styles.nav} contentContainerStyle={styles.navContent}>
        <Pressable
          style={[styles.row, showingOverview && styles.rowActive]}
          onPress={handleSelectOverview}
        >
          <ThemedGauge size={15} uniProps={mutedColor} />
          <Text style={[styles.rowLabel, showingOverview && styles.rowLabelActive]}>Overview</Text>
        </Pressable>
        <Pressable
          style={[styles.row, showingConsole && styles.rowActive]}
          onPress={handleSelectConsole}
        >
          <ThemedTerminal size={15} uniProps={mutedColor} />
          <Text style={[styles.rowLabel, showingConsole && styles.rowLabelActive]}>
            SQL console
          </Text>
        </Pressable>
        <Pressable style={[styles.row, showingDiff && styles.rowActive]} onPress={handleSelectDiff}>
          <ThemedGitCompare size={15} uniProps={mutedColor} />
          <Text style={[styles.rowLabel, showingDiff && styles.rowLabelActive]}>
            Compare schemas
          </Text>
        </Pressable>
        <Pressable style={[styles.row, showingEr && styles.rowActive]} onPress={handleSelectEr}>
          <ThemedShare2 size={15} uniProps={mutedColor} />
          <Text style={[styles.rowLabel, showingEr && styles.rowLabelActive]}>ER diagram</Text>
        </Pressable>
        {grouped.map((group) => (
          <View key={group.category}>
            <Text style={styles.categoryHeader}>{group.category}</Text>
            {group.objects.map((o) => (
              <ObjectRow
                key={`${o.schema}.${o.name}`}
                object={o}
                active={selectedObject?.schema === o.schema && selectedObject?.name === o.name}
                onSelect={handleSelectObject}
              />
            ))}
          </View>
        ))}
        {objects.length === 0 ? (
          <Text style={styles.emptyHint}>No tables in this schema.</Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  backDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
    marginVertical: theme.spacing[1],
    backgroundColor: theme.colors.border,
  },
  backText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  dbCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  dbName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  schemaSelect: {
    marginHorizontal: theme.spacing[2],
    marginTop: theme.spacing[2],
    gap: theme.spacing[1],
  },
  schemaSelectLabel: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundExtraMuted,
    letterSpacing: 0.6,
    paddingHorizontal: theme.spacing[1],
  },
  schemaTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  schemaTriggerText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  schemaMenu: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  schemaOption: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  schemaOptionActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  schemaOptionText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  schemaOptionTextActive: {
    color: theme.colors.foreground,
  },
  nav: {
    flex: 1,
    minHeight: 0,
  },
  navContent: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[3],
  },
  categoryHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundExtraMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  emptyHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowLabelActive: {
    color: theme.colors.foreground,
  },
}));
