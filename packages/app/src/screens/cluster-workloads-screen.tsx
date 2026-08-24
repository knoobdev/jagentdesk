import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MessageSquare } from "lucide-react-native";
import type { ClusterInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterResourceBrowser } from "@/components/cluster-resource-browser";
import { ClusterResourceDetail } from "@/components/cluster-resource-detail";
import { ClusterTabBar } from "@/components/cluster-tab-bar";
import { ClusterComposer } from "@/components/cluster-composer";
import { ClusterChatDock } from "@/components/cluster-chat-dock";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useClusterChatStore } from "@/stores/cluster-chat-store";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import { useClusterViewStore } from "@/stores/cluster-view-store";
import type { Theme } from "@/styles/theme";

const ThemedMessageSquare = withUnistyles(MessageSquare);
const accentColor = (theme: Theme) => ({ color: theme.colors.accent });

/**
 * The content pane for a connected cluster. The category navigation lives in the
 * app left sidebar (SidebarClusterNav). This screen shows the resource table on
 * the left and — when the user chats — a slide-in agent dock on the right, so
 * the k8s resources stay on screen instead of navigating away to an agent tab.
 */
export function ClusterWorkloadsScreen({
  serverId,
  clusterId,
}: {
  serverId: string;
  clusterId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  const chatOpen = useClusterChatStore((s) => s.open);
  const chatAgentId = useClusterChatStore((s) => s.agentId);
  const showChat = useClusterChatStore((s) => s.showChat);
  const resetForCluster = useClusterChatStore((s) => s.resetForCluster);

  // Content tabs: the resource list plus any open detail views.
  const tabs = useClusterViewStore((s) => s.tabs);
  const activeTabId = useClusterViewStore((s) => s.activeTabId);
  const closeTab = useClusterViewStore((s) => s.closeTab);
  const bumpRefresh = useClusterViewStore((s) => s.bumpRefresh);
  const resetViewForCluster = useClusterViewStore((s) => s.resetForCluster);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // What the user is currently browsing, attached as context to their question.
  const selectedKind = useClusterNavStore((s) => s.selectedKind);
  const selectedNamespace = useClusterNavStore((s) => s.selectedNamespace);
  const composerResource = useMemo(
    () => ({ kind: selectedKind, namespace: selectedNamespace }),
    [selectedKind, selectedNamespace],
  );

  useEffect(() => {
    resetForCluster(clusterId);
    resetViewForCluster(clusterId);
  }, [clusterId, resetForCluster, resetViewForCluster]);

  // On phones the host stack has no native header (headerShown: false), so the
  // screen paints under the status bar / notch / camera cutout. Reserve the
  // real top inset (0 on desktop) so it fits every device. iOS + Android alike.
  const containerStyle = useMemo(
    () => [styles.container, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  useEffect(() => {
    if (!client) return;
    void client
      .clusterList()
      .then((res) => {
        if (!res.error) setCluster(res.clusters.find((c) => c.id === clusterId) ?? null);
        return undefined;
      })
      .catch(() => {});
  }, [client, clusterId]);

  const clusterName = cluster?.displayName ?? cluster?.contextName ?? "this cluster";
  const handleShowChat = useCallback(() => showChat(), [showChat]);
  const handleDetailClose = useCallback(() => {
    if (activeTab) closeTab(activeTab.id);
  }, [activeTab, closeTab]);

  // Bottom slot under the table: hidden while the dock is open (the dock owns
  // the composer), a "Show chat" toggle when a hidden chat exists, otherwise the
  // entry composer that starts a chat.
  let bottomSlot: ReactNode = (
    <ClusterComposer
      serverId={serverId}
      clusterId={clusterId}
      clusterName={clusterName}
      resource={composerResource}
    />
  );
  if (chatOpen) {
    bottomSlot = null;
  } else if (chatAgentId) {
    bottomSlot = (
      <Pressable style={styles.showChatBar} onPress={handleShowChat}>
        <ThemedMessageSquare size={16} uniProps={accentColor} />
        <Text style={styles.showChatText}>Show chat</Text>
      </Pressable>
    );
  }

  return (
    <View style={containerStyle}>
      <View style={styles.row}>
        <View style={styles.leftColumn}>
          <ClusterTabBar />
          {activeTab ? (
            <ClusterResourceDetail
              serverId={serverId}
              clusterId={clusterId}
              kind={activeTab.kind}
              namespace={activeTab.namespace}
              name={activeTab.name}
              onClose={handleDetailClose}
              onChanged={bumpRefresh}
            />
          ) : (
            <>
              <View style={styles.body}>
                <ClusterResourceBrowser serverId={serverId} clusterId={clusterId} />
              </View>
              {bottomSlot}
            </>
          )}
        </View>
        <ClusterChatDock serverId={serverId} clusterName={clusterName} />
      </View>
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
  body: {
    flex: 1,
    minHeight: 0,
  },
  showChatBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  showChatText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accent,
  },
}));
