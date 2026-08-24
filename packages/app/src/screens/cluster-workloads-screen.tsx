import { useEffect, useState } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ClusterInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterResourceBrowser } from "@/components/cluster-resource-browser";
import { ClusterComposer } from "@/components/cluster-composer";
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
    <View style={styles.container}>
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
