import { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft } from "lucide-react-native";
import { useRouter } from "expo-router";
import type { ClusterInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterResourceBrowser } from "@/components/cluster-resource-browser";
import { ClusterStatusDot } from "@/components/cluster-dot";
import { buildClustersRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const chevronColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * Dedicated Workloads screen for a single connected cluster. This is a SEPARATE
 * screen from the Clusters list — it owns the Lens-style category sidebar +
 * resource table (via ClusterResourceBrowser), reached by "Open workloads".
 */
export function ClusterWorkloadsScreen({
  serverId,
  clusterId,
}: {
  serverId: string;
  clusterId: string;
}) {
  const router = useRouter();
  const client = useHostRuntimeClient(serverId);
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);

  useEffect(() => {
    if (!client) return;
    void client
      .clusterList()
      .then((res) => {
        if (!res.error) {
          setCluster(res.clusters.find((c) => c.id === clusterId) ?? null);
        }
        return undefined;
      })
      .catch(() => {});
  }, [client, clusterId]);

  const handleBack = useCallback(() => {
    router.replace(buildClustersRoute(serverId));
  }, [router, serverId]);

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Pressable
          style={styles.backButton}
          onPress={handleBack}
          accessibilityLabel="Back to clusters"
        >
          <ThemedChevronLeft size={20} uniProps={chevronColor} />
        </Pressable>
        <ClusterStatusDot state={cluster?.state ?? "connected"} />
        <Text style={styles.title} numberOfLines={1}>
          {cluster?.displayName ?? cluster?.contextName ?? "Cluster"}
        </Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          Workloads
          {cluster?.nodeCount != null ? ` · ${cluster.nodeCount} nodes` : ""}
          {cluster?.podCount != null ? ` · ${cluster.podCount} pods` : ""}
        </Text>
      </View>
      <View style={styles.body}>
        <ClusterResourceBrowser serverId={serverId} clusterId={clusterId} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    height: 48,
    paddingHorizontal: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  backButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  title: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
  },
  body: {
    flex: 1,
    minHeight: 0,
    padding: theme.spacing[3],
  },
}));
