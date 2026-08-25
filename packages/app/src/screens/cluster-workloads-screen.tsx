import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ClusterInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterResourceBrowser } from "@/components/cluster-resource-browser";
import { ClusterResourceDetail } from "@/components/cluster-resource-detail";
import { ClusterTabBar } from "@/components/cluster-tab-bar";
import { ClusterChatDock } from "@/components/cluster-chat-dock";
import type { ClusterComposerResource } from "@/components/cluster-composer";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useClusterChatStore } from "@/stores/cluster-chat-store";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import { useClusterViewStore } from "@/stores/cluster-view-store";
import type { Theme } from "@/styles/theme";

/**
 * The content pane for a connected cluster. The category navigation lives in the
 * app left sidebar (SidebarClusterNav). The resource list + detail tabs stay on
 * the left; chat lives entirely in the right dock (ClusterChatDock), which
 * carries whatever the user is currently viewing as context.
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

  const resetForCluster = useClusterChatStore((s) => s.resetForCluster);

  // Content tabs: the resource list plus any open detail views.
  const tabs = useClusterViewStore((s) => s.tabs);
  const activeTabId = useClusterViewStore((s) => s.activeTabId);
  const closeTab = useClusterViewStore((s) => s.closeTab);
  const bumpRefresh = useClusterViewStore((s) => s.bumpRefresh);
  const resetViewForCluster = useClusterViewStore((s) => s.resetForCluster);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // Whatever the user is currently viewing rides along to the chat as context:
  // the open detail resource, otherwise the selected kind + namespace.
  const selectedKind = useClusterNavStore((s) => s.selectedKind);
  const selectedNamespace = useClusterNavStore((s) => s.selectedNamespace);
  const setLastCluster = useClusterNavStore((s) => s.setLastCluster);
  const composerResource = useMemo<ClusterComposerResource>(
    () =>
      activeTab
        ? { kind: activeTab.kind, namespace: activeTab.namespace, name: activeTab.name }
        : { kind: selectedKind, namespace: selectedNamespace },
    [activeTab, selectedKind, selectedNamespace],
  );

  useEffect(() => {
    // On phones the chat dock is a full-screen overlay, so start it CLOSED and
    // let the k8s resource view be the landing; desktop keeps the side dock open.
    resetForCluster(clusterId, !isCompact);
    resetViewForCluster(clusterId);
    // Remember this cluster so the sidebar's Clusters entry can jump straight back
    // to it instead of forcing the user to reconnect + reopen from scratch.
    setLastCluster(serverId, clusterId);
  }, [clusterId, serverId, isCompact, resetForCluster, resetViewForCluster, setLastCluster]);

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
  const handleDetailClose = useCallback(() => {
    if (activeTab) closeTab(activeTab.id);
  }, [activeTab, closeTab]);

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
            <View style={styles.body}>
              <ClusterResourceBrowser serverId={serverId} clusterId={clusterId} />
            </View>
          )}
        </View>
        <ClusterChatDock
          serverId={serverId}
          clusterId={clusterId}
          clusterName={clusterName}
          resource={composerResource}
        />
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
}));
