import { useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ClusterInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterResourceBrowser } from "@/components/cluster-resource-browser";
import { ClusterComposer } from "@/components/cluster-composer";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";

/**
 * The content pane for a connected cluster. The category navigation lives in the
 * app left sidebar (SidebarClusterNav) — this screen shows the resource table
 * (ClusterResourceBrowser) plus a chat composer pinned to the bottom.
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

  return (
    <View style={containerStyle}>
      <View style={styles.body}>
        <ClusterResourceBrowser serverId={serverId} clusterId={clusterId} />
      </View>
      <ClusterComposer
        serverId={serverId}
        clusterId={clusterId}
        clusterName={cluster?.displayName ?? cluster?.contextName ?? "this cluster"}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
}));
