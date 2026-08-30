import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Boxes, CircleAlert } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ContextStatusDot, ClusterStatusDot } from "@/components/cluster-dot";
import { buildClusterWorkloadsRoute } from "@/utils/host-routes";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import type { Theme } from "@/styles/theme";
import type { ClusterInfo, KubeContextInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";

function ContextRow({
  ctx,
  cluster,
  connecting,
  onConnect,
  onOpen,
  onDisconnect,
}: {
  ctx: KubeContextInfo;
  cluster: ClusterInfo | null;
  connecting: boolean;
  onConnect: (ctx: KubeContextInfo) => void;
  onOpen: (clusterId: string) => void;
  onDisconnect: (clusterId: string) => void;
}) {
  const connected = cluster?.state === "connected";
  const errored = cluster?.state === "error";
  const busy = connecting || cluster?.state === "connecting";
  const handleConnect = useCallback(() => onConnect(ctx), [onConnect, ctx]);
  const handleOpen = useCallback(() => {
    if (cluster) onOpen(cluster.id);
  }, [onOpen, cluster]);
  const handleDisconnect = useCallback(() => {
    if (cluster) onDisconnect(cluster.id);
  }, [onDisconnect, cluster]);

  let connectLabel = "Connect";
  if (busy) connectLabel = "Connecting…";
  else if (errored) connectLabel = "Retry";

  return (
    <View style={styles.contextRow}>
      <View style={styles.contextHeader}>
        {cluster ? (
          <ClusterStatusDot state={cluster.state} />
        ) : (
          <ContextStatusDot current={ctx.current} />
        )}
        <View style={styles.contextInfo}>
          <Text style={styles.contextName} numberOfLines={1}>
            {ctx.name}
          </Text>
          <Text style={styles.contextServer} numberOfLines={1}>
            {connected && cluster
              ? `${cluster.nodeCount ?? "?"} nodes · ${cluster.podCount ?? "?"} pods · ${ctx.server}`
              : ctx.server}
          </Text>
        </View>
        {connected && cluster ? null : (
          <Pressable
            style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
            onPress={handleConnect}
            disabled={busy}
          >
            <Text style={styles.btnPrimaryText}>{connectLabel}</Text>
          </Pressable>
        )}
      </View>

      {errored && cluster?.lastError ? (
        <View style={styles.contextError}>
          <ThemedCircleAlert size={13} uniProps={redColorMapping} />
          <Text style={styles.contextErrorText} numberOfLines={4}>
            {cluster.lastError}
          </Text>
        </View>
      ) : null}

      {/* Connected: the name/link stays on the header row above; the actions wrap
          onto their own row so a phone width can't clip "Disconnect" or squeeze
          the cluster name to nothing. */}
      {connected && cluster ? (
        <View style={styles.contextActions}>
          <Pressable style={[styles.btn, styles.btnPrimary]} onPress={handleOpen}>
            <Text style={styles.btnPrimaryText}>Open workloads</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={handleDisconnect}>
            <Text style={styles.btnGhostText}>Disconnect</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export function ClustersScreen() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? "";
  const client = useHostRuntimeClient(serverId);
  const clearLastCluster = useClusterNavStore((s) => s.clearLastCluster);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();

  // Phones render this screen with no native header, so pad past the status
  // bar / notch. 0 on desktop, real inset on iOS + Android.
  const contentContainerStyle = useMemo(
    () => [styles.contentContainer, isCompact ? { paddingTop: insets.top } : null],
    [isCompact, insets.top],
  );

  const [contexts, setContexts] = useState<KubeContextInfo[]>([]);
  const [clusters, setClusters] = useState<ClusterInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyContext, setBusyContext] = useState<string | null>(null);

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

  const clusterByContext = useMemo(() => {
    const map = new Map<string, ClusterInfo>();
    for (const c of clusters) map.set(c.contextName, c);
    return map;
  }, [clusters]);

  // One-click: import (if needed) then connect.
  const handleConnect = useCallback(
    async (ctx: KubeContextInfo) => {
      if (!client) return;
      setBusyContext(ctx.name);
      setError(null);
      try {
        let cluster = clusterByContext.get(ctx.name) ?? null;
        if (!cluster) {
          const imp = await client.clusterImport({ contextName: ctx.name });
          if (imp.error) {
            setError(imp.error);
            return;
          }
          cluster = imp.clusters.find((c) => c.contextName === ctx.name) ?? null;
        }
        if (!cluster) {
          setError("Could not resolve cluster for context");
          return;
        }
        const con = await client.clusterConnect({ id: cluster.id });
        if (con.error) setError(con.error);
        await refresh();
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : "Connect failed");
      } finally {
        setBusyContext(null);
      }
    },
    [client, clusterByContext, refresh],
  );

  const handleOpenWorkloads = useCallback(
    (clusterId: string) => {
      router.push(buildClusterWorkloadsRoute(serverId, clusterId));
    },
    [router, serverId],
  );

  const handleDisconnect = useCallback(
    (clusterId: string) => {
      if (!client) return;
      setError(null);
      // Drop the "return to last cluster" jump target so the sidebar's Clusters
      // entry goes to the list after an explicit disconnect, instead of reopening
      // this cluster and silently reconnecting it (which left namespace on "Error").
      clearLastCluster(clusterId);
      void client
        .clusterDisconnect({ id: clusterId })
        .then((res) => {
          if (res.error) setError(res.error);
          return refresh();
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : "Disconnect failed"));
    },
    [client, refresh, clearLastCluster],
  );

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ThemedLoadingSpinner size="large" uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={contentContainerStyle}>
      <View style={styles.headerRow}>
        <ThemedBoxes size={20} uniProps={foregroundColorMapping} />
        <Text style={styles.header}>Clusters</Text>
      </View>
      <Text style={styles.headerHint}>Connect a Kubernetes context, then open its workloads.</Text>

      {error ? (
        <View style={styles.errorBanner}>
          <ThemedCircleAlert size={16} uniProps={redColorMapping} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {contexts.length === 0 ? (
        <Text style={styles.emptyText}>No Kubernetes contexts detected in ~/.kube/config.</Text>
      ) : (
        <View style={styles.sectionCard}>
          {contexts.map((ctx) => (
            <ContextRow
              key={ctx.name}
              ctx={ctx}
              cluster={clusterByContext.get(ctx.name) ?? null}
              connecting={busyContext === ctx.name}
              onConnect={handleConnect}
              onOpen={handleOpenWorkloads}
              onDisconnect={handleDisconnect}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const ThemedBoxes = withUnistyles(Boxes);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const redColorMapping = (theme: Theme) => ({ color: theme.colors.palette.red[500] });

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
  headerHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: -theme.spacing[2],
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
  contextError: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[4],
    paddingTop: theme.spacing[1],
  },
  contextErrorText: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.red[500],
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
    flexDirection: "column",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  contextHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  contextActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    paddingLeft: theme.spacing[4],
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
  btn: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  btnPrimary: {
    backgroundColor: theme.colors.accent,
  },
  btnPrimaryText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentForeground,
  },
  btnGhost: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  btnGhostText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  btnDisabled: {
    opacity: 0.5,
  },
}));
