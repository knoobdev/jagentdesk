import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Boxes, CircleAlert, Import } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ClusterResourceBrowser } from "@/components/cluster-resource-browser";
import { ClusterStatusDot, ContextStatusDot } from "@/components/cluster-dot";
import type { Theme } from "@/styles/theme";
import type { ClusterInfo, KubeContextInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";

function ImportButton({
  contextName,
  importing,
  onImport,
}: {
  contextName: string;
  importing: boolean;
  onImport: (name: string) => void;
}) {
  const handlePress = useCallback(() => onImport(contextName), [contextName, onImport]);
  return (
    <Pressable style={styles.importButton} onPress={handlePress} disabled={importing}>
      <ThemedImport size={14} uniProps={foregroundColorMapping} />
      <Text style={styles.importButtonText}>{importing ? "Importing..." : "Import"}</Text>
    </Pressable>
  );
}

function ConnectButton({
  clusterId,
  connecting,
  onConnect,
}: {
  clusterId: string;
  connecting: boolean;
  onConnect: (id: string) => void;
}) {
  const handlePress = useCallback(() => onConnect(clusterId), [clusterId, onConnect]);
  return (
    <Pressable
      style={[styles.connectButton, connecting && styles.connectButtonDisabled]}
      onPress={handlePress}
      disabled={connecting}
    >
      <Text style={styles.connectButtonText}>{connecting ? "Connecting..." : "Connect"}</Text>
    </Pressable>
  );
}

function WorkloadsButton({
  clusterId,
  onWorkloads,
}: {
  clusterId: string;
  onWorkloads: (id: string) => void;
}) {
  const handlePress = useCallback(() => onWorkloads(clusterId), [clusterId, onWorkloads]);
  return (
    <Pressable style={styles.workloadsButton} onPress={handlePress}>
      <Text style={styles.workloadsButtonText}>Workloads</Text>
    </Pressable>
  );
}

export function ClustersScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);

  const [contexts, setContexts] = useState<KubeContextInfo[]>([]);
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importingName, setImportingName] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!client) return;
    setError(null);
    try {
      const [listRes, ctxRes] = await Promise.all([client.clusterList(), client.clusterContexts()]);
      if (listRes.error) setError(listRes.error);
      else setClusters(listRes.clusters);
      if (ctxRes.error) {
        setError((prev) => (prev ? `${prev}\n${ctxRes.error}` : ctxRes.error));
      } else {
        setContexts(ctxRes.contexts);
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load clusters");
    }
  }, [client]);

  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [client, refresh]);

  const handleImport = useCallback(
    async (contextName: string) => {
      if (!client) return;
      setImportingName(contextName);
      setError(null);
      try {
        const res = await client.clusterImport({ contextName });
        if (res.error) setError(res.error);
        else await refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Import failed");
      } finally {
        setImportingName(null);
      }
    },
    [client, refresh],
  );

  const handleConnect = useCallback(
    async (id: string) => {
      if (!client) return;
      setConnectingId(id);
      setError(null);
      try {
        const res = await client.clusterConnect({ id });
        if (res.error) setError(res.error);
        else await refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Connect failed");
      } finally {
        setConnectingId(null);
      }
    },
    [client, refresh],
  );

  const handleSelectCluster = useCallback((id: string) => {
    setSelectedClusterId(id);
    setError(null);
  }, []);

  const clusteredContextNames = useMemo(
    () => new Set(clusters.map((c) => c.contextName)),
    [clusters],
  );

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      <View style={styles.headerRow}>
        <ThemedBoxes size={20} uniProps={foregroundColorMapping} />
        <Text style={styles.header}>Clusters</Text>
      </View>

      {error ? (
        <View style={styles.errorBanner}>
          <ThemedCircleAlert size={16} uniProps={redColorMapping} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* Detected contexts */}
      <Text style={styles.sectionTitle}>Detected contexts</Text>
      {contexts.length === 0 ? (
        <Text style={styles.emptyText}>No Kubernetes contexts detected.</Text>
      ) : (
        <View style={styles.sectionCard}>
          {contexts.map((ctx) => {
            const imported = clusteredContextNames.has(ctx.name);
            return (
              <View key={ctx.name} style={styles.contextRow}>
                <ContextStatusDot current={ctx.current} />
                <View style={styles.contextInfo}>
                  <Text style={styles.contextName} numberOfLines={1}>
                    {ctx.name}
                  </Text>
                  <Text style={styles.contextServer} numberOfLines={1}>
                    {ctx.server}
                  </Text>
                </View>
                {imported ? (
                  <Text style={styles.importedLabel}>Imported</Text>
                ) : (
                  <ImportButton
                    contextName={ctx.name}
                    importing={importingName === ctx.name}
                    onImport={handleImport}
                  />
                )}
              </View>
            );
          })}
        </View>
      )}

      {/* Clusters */}
      <Text style={styles.sectionTitle}>Clusters</Text>
      {clusters.length === 0 ? (
        <Text style={styles.emptyText}>No clusters imported.</Text>
      ) : (
        <View style={styles.sectionCard}>
          {clusters.map((cluster) => {
            const isConnected = cluster.state === "connected";
            const isConnecting = cluster.state === "connecting";
            return (
              <View key={cluster.id} style={styles.clusterCard}>
                <View style={styles.clusterCardHeader}>
                  <ClusterStatusDot state={cluster.state} />
                  <View style={styles.clusterInfo}>
                    <Text style={styles.clusterName} numberOfLines={1}>
                      {cluster.displayName || cluster.contextName}
                    </Text>
                    <Text style={styles.clusterState}>{cluster.state}</Text>
                  </View>
                  {isConnected ? (
                    <>
                      <Text style={styles.clusterCounts}>
                        {cluster.nodeCount ?? "?"} nodes · {cluster.podCount ?? "?"} pods
                      </Text>
                      <WorkloadsButton clusterId={cluster.id} onWorkloads={handleSelectCluster} />
                    </>
                  ) : (
                    <ConnectButton
                      clusterId={cluster.id}
                      connecting={isConnecting || connectingId === cluster.id}
                      onConnect={handleConnect}
                    />
                  )}
                </View>
                {cluster.lastError ? (
                  <Text style={styles.clusterError}>{cluster.lastError}</Text>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {/* Resource browser */}
      {selectedClusterId ? (
        <View style={styles.browserSection}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>Resources</Text>
          </View>
          <ClusterResourceBrowser serverId={serverId} clusterId={selectedClusterId} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const ThemedBoxes = withUnistyles(Boxes);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedImport = withUnistyles(Import);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const redColorMapping = (theme: Theme) => ({
  color: theme.colors.palette.red[500],
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  contentContainer: {
    padding: theme.spacing[4],
    flexGrow: 1,
    gap: theme.spacing[3],
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 120,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  header: {
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    backgroundColor: theme.colors.palette.red[100],
    borderRadius: theme.borderRadius.lg,
  },
  errorText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[800],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  browserSection: {
    minHeight: 200,
  },
  sectionCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  contextRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  contextInfo: {
    flex: 1,
    minWidth: 0,
  },
  contextName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  contextServer: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  importedLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.green[400],
    fontWeight: theme.fontWeight.medium,
  },
  importButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  importButtonText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  clusterCard: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  clusterCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
  },
  clusterInfo: {
    flex: 1,
    minWidth: 0,
  },
  clusterName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  clusterState: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  clusterCounts: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginRight: theme.spacing[2],
  },
  clusterError: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[500],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  connectButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.green[400],
  },
  connectButtonDisabled: {
    opacity: 0.6,
  },
  connectButtonText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  workloadsButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  workloadsButtonText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
