import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { PanelLeft } from "lucide-react-native";
import type { DatabaseInfo } from "@jagentdesk/protocol/database/rpc-schemas";
import { BackHeader } from "@/components/headers/back-header";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { DatabaseDataEditor } from "@/components/database-data-editor";
import { DatabaseStructureView } from "@/components/database-structure-view";
import { DatabaseSqlConsole } from "@/components/database-sql-console";
import { DatabaseErDiagram } from "@/components/database-er-diagram";
import { DatabaseFullTextSearch } from "@/components/database-full-text-search";
import { DatabaseChatDock } from "@/components/database-chat-dock";
import type { DatabaseComposerContext } from "@/components/database-draft-chat";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDatabaseNavStore } from "@/stores/database-nav-store";
import { useDatabaseViewStore } from "@/stores/database-view-store";
import { useDatabaseChatStore } from "@/stores/database-chat-store";
import { usePanelStore } from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";

const ThemedPanelLeft = withUnistyles(PanelLeft);
const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * The content pane for a connected database. The object navigation lives in the
 * app left sidebar (SidebarDatabaseNav); this pane shows the active view —
 * connection overview, a table data grid, or the SQL console — plus the chat
 * dock on the right (mirrors ClusterWorkloadsScreen).
 */
// eslint-disable-next-line complexity
export function DatabaseBrowseScreen({
  serverId,
  databaseId,
}: {
  serverId: string;
  databaseId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  // A deep link mounts this before the host WebSocket has synced; gate the
  // connect/introspect on a live session so it doesn't no-op on an empty list.
  const isConnected = useHostRuntimeIsConnected(serverId);
  const [database, setDatabase] = useState<DatabaseInfo | null>(null);
  const [schemaCount, setSchemaCount] = useState<number | null>(null);
  const [objectView, setObjectView] = useState<"data" | "structure">("data");
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const router = useRouter();
  // Deep links land here as the first stack entry (no back target); only show the
  // back affordance when there is somewhere to return to.
  const showBack = isCompact && router.canGoBack();

  const selectedObject = useDatabaseNavStore((s) => s.selectedObject);
  const showingConsole = useDatabaseNavStore((s) => s.showingConsole);
  const showingEr = useDatabaseNavStore((s) => s.showingEr);
  const showingSearch = useDatabaseNavStore((s) => s.showingSearch);
  const setLastDatabase = useDatabaseNavStore((s) => s.setLastDatabase);
  const bumpRefresh = useDatabaseViewStore((s) => s.bumpRefresh);
  const resetViewForDatabase = useDatabaseViewStore((s) => s.resetForDatabase);
  const resetChatForDatabase = useDatabaseChatStore((s) => s.resetForDatabase);
  const chatOpen = useDatabaseChatStore((s) => s.open);
  const hideChat = useDatabaseChatStore((s) => s.hideChat);

  useEffect(() => {
    resetViewForDatabase(databaseId);
    setLastDatabase(serverId, databaseId);
    // Show the chat panel by default on desktop — it's JAgentDesk's edge (a
    // schema-grounded agent) and belongs visible beside the data, DataGrip-AI
    // style. On phones it stays collapsed (the grid needs the full width) and is
    // opened from the explorer's "Ask AI" button.
    resetChatForDatabase(databaseId, !isCompact);
  }, [
    databaseId,
    serverId,
    isCompact,
    resetViewForDatabase,
    setLastDatabase,
    resetChatForDatabase,
  ]);

  const showMobileAgentList = usePanelStore((s) => s.showMobileAgentList);
  useEffect(() => {
    // On phones the object nav is a slide-in overlay; reveal it on open so the
    // user sees the table menu rather than a bare overview.
    if (isCompact) showMobileAgentList();
  }, [databaseId, isCompact, showMobileAgentList]);

  useEffect(() => {
    if (!client || !isConnected) return;
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
  }, [client, isConnected, databaseId, bumpRefresh]);

  // Honor the safe area on all edges on compact so child bottom bars (data grid
  // status/pagination) clear the home indicator and screen edges. When the back
  // header is shown it already reserves the top inset, so don't double-pad.
  const contentStyle = useMemo(
    () => [
      styles.content,
      isCompact
        ? {
            paddingTop: showBack ? 0 : insets.top,
            paddingBottom: insets.bottom,
            paddingLeft: insets.left,
            paddingRight: insets.right,
          }
        : null,
    ],
    [isCompact, showBack, insets.top, insets.bottom, insets.left, insets.right],
  );

  const engine = database?.engine ?? "postgres";
  const dbName = database?.displayName ?? "this database";
  const chatContext = useMemo<DatabaseComposerContext>(
    () => ({ engine, schema: selectedObject?.schema, table: selectedObject?.name }),
    [engine, selectedObject],
  );
  const showDataView = useCallback(() => setObjectView("data"), []);
  const showStructureView = useCallback(() => setObjectView("structure"), []);
  // On phones the object nav is a slide-in that closes when you pick a table; this
  // bar reopens it so the table tree is always one tap away (not just the chat FAB).
  const handleOpenTables = useCallback(() => showMobileAgentList(), [showMobileAgentList]);
  // When the full-screen chat is open on a phone, the header back arrow must
  // just dismiss the chat (returning to the browse/table view underneath), not
  // navigate the whole DB section back to the connection list.
  const handleBack = useCallback(() => {
    if (chatOpen) {
      hideChat();
      return;
    }
    router.back();
  }, [chatOpen, hideChat, router]);

  let content;
  if (showingConsole) {
    content = <DatabaseSqlConsole serverId={serverId} databaseId={databaseId} engine={engine} />;
  } else if (showingSearch) {
    content = (
      <DatabaseFullTextSearch serverId={serverId} databaseId={databaseId} engine={engine} />
    );
  } else if (showingEr) {
    content = <DatabaseErDiagram serverId={serverId} databaseId={databaseId} />;
  } else if (selectedObject) {
    // A table picked from the tree carries its own databaseId (a child database's
    // composite id), so the grid/structure operate that database, not the parent.
    const objectDbId = selectedObject.databaseId;
    const inner =
      objectView === "data" ? (
        <DatabaseDataEditor
          serverId={serverId}
          databaseId={objectDbId}
          engine={engine}
          schema={selectedObject.schema}
          table={selectedObject.name}
        />
      ) : (
        <DatabaseStructureView
          serverId={serverId}
          databaseId={objectDbId}
          engine={engine}
          schema={selectedObject.schema}
          table={selectedObject.name}
        />
      );
    content = (
      <View style={styles.leftColumn}>
        <View style={styles.viewSwitch}>
          <Pressable
            style={[styles.switchBtn, objectView === "data" && styles.switchBtnActive]}
            onPress={showDataView}
          >
            <Text style={[styles.switchText, objectView === "data" && styles.switchTextActive]}>
              Data
            </Text>
          </Pressable>
          <Pressable
            style={[styles.switchBtn, objectView === "structure" && styles.switchBtnActive]}
            onPress={showStructureView}
          >
            <Text
              style={[styles.switchText, objectView === "structure" && styles.switchTextActive]}
            >
              Structure
            </Text>
          </Pressable>
        </View>
        {inner}
      </View>
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
    <View style={styles.container}>
      {showBack ? <BackHeader title={dbName} onBack={handleBack} /> : null}
      <View style={contentStyle}>
        <View style={styles.row}>
          <View style={styles.leftColumn}>
            {isCompact ? (
              <Pressable
                style={styles.mobileNavBar}
                onPress={handleOpenTables}
                accessibilityLabel="Show tables"
                testID="database-mobile-tables"
              >
                <ThemedPanelLeft size={16} uniProps={mutedIconColor} />
                <Text style={styles.mobileNavBarText} numberOfLines={1}>
                  {selectedObject ? `${selectedObject.schema}.${selectedObject.name}` : dbName}
                </Text>
              </Pressable>
            ) : null}
            {content}
          </View>
          <DatabaseChatDock
            serverId={serverId}
            databaseId={databaseId}
            databaseName={dbName}
            context={chatContext}
          />
        </View>
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
  content: {
    flex: 1,
    minHeight: 0,
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
  mobileNavBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  mobileNavBarText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  viewSwitch: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  switchBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  switchBtnActive: {
    backgroundColor: theme.colors.surface2,
  },
  switchText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  switchTextActive: {
    color: theme.colors.foreground,
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
