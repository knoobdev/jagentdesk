import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DatabaseInfo } from "@jagentdesk/protocol/database/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { DatabaseDataGrid } from "@/components/database-data-grid";
import { DatabaseSqlConsole } from "@/components/database-sql-console";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { usePanelStore } from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";

/**
 * The content pane for a connected database. The object navigation lives in the
 * app left sidebar (SidebarDatabaseNav); this pane shows the active view —
 * connection overview, a table data grid, or the SQL console — plus the chat
 * dock on the right (mirrors ClusterWorkloadsScreen).
 */
export function DatabaseBrowseScreen({
  serverId,
  databaseId,
}: {
  serverId: string;
  databaseId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [schemaCount, setSchemaCount] = useState<number | null>(null);
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  const selectedObject = useDatabaseNavStore((s) => s.selectedObject);
  const showingConsole = useDatabaseNavStore((s) => s.showingConsole);
  const setLastDatabase = useDatabaseNavStore((s) => s.setLastDatabase);
  const bumpRefresh = useDatabaseViewStore((s) => s.bumpRefresh);
  const resetViewForDatabase = useDatabaseViewStore((s) => s.resetForDatabase);

  useEffect(() => {
    resetViewForDatabase(databaseId);
    setLastDatabase(serverId, databaseId);
  }, [databaseId, serverId, resetViewForDatabase, setLastDatabase]);

  const showMobileAgentList = usePanelStore((s) => s.showMobileAgentList);
  useEffect(() => {
    // On phones the object nav is a slide-in overlay; reveal it on open so the
    // user sees the table menu rather than a bare overview.
    if (isCompact) showMobileAgentList();
  }, [databaseId, isCompact, showMobileAgentList]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.databaseList();
        if (cancelled || res.error) return;
        const found = res.databases.find((d) => d.id === databaseId) ?? null;
        setDatabase(found);
        // Ensure connected: the live client lives in-daemon memory and is dropped
        // on daemon restart; opening via deep link / sidebar jump never ran connect.
        if (found && found.state !== "connected" && found.state !== "connecting") {
          const con = await client.databaseConnect({ id: databaseId });
          if (cancelled || con.error) return;
          const refreshed = await client.databaseList().catch(() => null);
          if (cancelled) return;
          if (refreshed && !refreshed.error) {
            setDatabase(refreshed.databases.find((d) => d.id === databaseId) ?? found);
          }
          bumpRefresh();
        }
        const schemas = await client.databaseSchemas({ id: databaseId }).catch(() => null);
        if (!cancelled && schemas && !schemas.error) setSchemaCount(schemas.schemas.length);
      } catch {
        // best-effort; child views surface their own errors
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, databaseId, bumpRefresh]);

  const containerStyle = useMemo(
    () => [styles.container, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const engine = database?.engine ?? "postgres";
  const dbName = database?.displayName ?? "this database";

  let content;
  if (showingConsole) {
    content = <DatabaseSqlConsole serverId={serverId} databaseId={databaseId} engine={engine} />;
  } else if (selectedObject) {
    content = (
      <DatabaseDataGrid
        serverId={serverId}
        databaseId={databaseId}
        engine={engine}
        schema={selectedObject.schema}
        table={selectedObject.name}
      />
    );
  } else {
    content = (
      <ScrollView style={styles.overview} contentContainerStyle={styles.overviewContent}>
        <Text style={styles.overviewTitle}>{dbName}</Text>
        <View style={styles.metaGrid}>
          <Meta label="Engine" value={engine} />
          <Meta label="Target" value={database?.target || "—"} />
          <Meta label="Server" value={database?.serverVersion ?? "—"} />
          <Meta label="Schemas" value={schemaCount == null ? "…" : String(schemaCount)} />
          <Meta label="State" value={database?.state ?? "—"} />
        </View>
        <Text style={styles.overviewHint}>
          Pick a table on the left to browse its data, open the SQL console to run a query, or ask
          the chat agent on the right a question about this database.
        </Text>
      </ScrollView>
    );
  }

  return (
    <View style={containerStyle}>
      <View style={styles.row}>
        <View style={styles.leftColumn}>{content}</View>
      </View>
    </View>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.meta}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  row: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  leftColumn: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  overview: {
    flex: 1,
    minHeight: 0,
  },
  overviewContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  overviewTitle: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  metaGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  meta: {
    minWidth: 140,
    gap: theme.spacing[1],
  },
  metaLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  metaValue: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  overviewHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[2],
  },
}));
