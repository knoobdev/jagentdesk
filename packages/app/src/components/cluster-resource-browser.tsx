import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { FlatList, Pressable, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterHelmView } from "@/components/cluster-helm-view";
import { ClusterStatusDot, PodStatusDot } from "@/components/cluster-dot";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import { useClusterViewStore } from "@/stores/cluster-view-store";
import type { Theme } from "@/styles/theme";

interface KindInfo {
  kind: string;
  apiVersion: string;
  namespaced: boolean;
  category: string;
}

interface ResourceItem {
  name: string;
  namespace: string;
  creationTimestamp: string;
  phase?: string;
  ready?: string;
  restarts?: number;
}

interface MetricsEntry {
  cpuNano: number;
  memoryBytes: number;
}

/** clusterResourceList returns raw Kubernetes objects; flatten so every column is populated. */
function normalizeResourceItem(raw: Record<string, unknown>): ResourceItem {
  const md = (raw.metadata as Record<string, unknown> | undefined) ?? {};
  const status = (raw.status as Record<string, unknown> | undefined) ?? {};
  const containerStatuses = (status.containerStatuses as Array<Record<string, unknown>>) ?? [];
  const readyCount = containerStatuses.filter((c) => c.ready === true).length;
  const restarts = containerStatuses.reduce((sum, c) => sum + ((c.restartCount as number) ?? 0), 0);
  return {
    name: (md.name as string) ?? (raw.name as string) ?? "",
    namespace: (md.namespace as string) ?? (raw.namespace as string) ?? "",
    creationTimestamp: (md.creationTimestamp as string) ?? (raw.creationTimestamp as string) ?? "",
    phase: (status.phase as string) ?? (raw.phase as string) ?? undefined,
    ready:
      containerStatuses.length > 0
        ? `${readyCount}/${containerStatuses.length}`
        : ((raw.ready as string) ?? undefined),
    restarts: containerStatuses.length > 0 ? restarts : ((raw.restarts as number) ?? undefined),
  };
}

function formatAge(creationTimestamp: string): string {
  if (!creationTimestamp) return "-";
  const created = new Date(creationTimestamp).getTime();
  if (Number.isNaN(created)) return "-";
  const diffMs = Date.now() - created;
  if (diffMs < 0) return "0m";
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "0m";
  const diffHours = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays >= 1) return `${diffDays}d`;
  if (diffHours >= 1) return `${diffHours}h`;
  return `${diffMin}m`;
}

function formatCpu(cpuNano: number): string {
  return `${Math.round(cpuNano / 1e6)}m`;
}
function formatMem(memoryBytes: number): string {
  return `${Math.round(memoryBytes / 1048576)}Mi`;
}

/**
 * The resource TABLE for a cluster. The category navigation now lives in the app
 * left sidebar (SidebarClusterNav); this component only reads the selected kind
 * from the shared store and renders the Lens-style table + detail drawer.
 */
export function ClusterResourceBrowser({
  serverId,
  clusterId,
}: {
  serverId: string;
  clusterId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const selectedKind = useClusterNavStore((s) => s.selectedKind);
  const showingHelm = useClusterNavStore((s) => s.showingHelm);
  const selectedNamespace = useClusterNavStore((s) => s.selectedNamespace);

  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [metricsMap, setMetricsMap] = useState<Record<string, MetricsEntry>>({});
  const openDetail = useClusterViewStore((s) => s.openDetail);
  const listRefreshKey = useClusterViewStore((s) => s.listRefreshKey);

  useEffect(() => {
    if (!client) return;
    void client
      .clusterKinds({ id: clusterId })
      .then((res) => {
        if (!res.error) setKinds(res.kinds as KindInfo[]);
        return undefined;
      })
      .catch(() => {});
  }, [client, clusterId]);

  const isNamespaced = useMemo(
    () => kinds.find((k) => k.kind === selectedKind)?.namespaced ?? false,
    [kinds, selectedKind],
  );
  const hasMetrics = useMemo(() => Object.keys(metricsMap).length > 0, [metricsMap]);

  const loadResources = useCallback(
    (kind: string, namespace: string | undefined, namespaced: boolean) => {
      if (!client) return;
      setLoadingItems(true);
      setError(null);
      setMetricsMap({});
      void client
        .clusterResourceList({
          id: clusterId,
          kind,
          ...(namespaced && namespace ? { namespace } : {}),
        })
        .then((res) => {
          if (res.error) {
            setError(res.error);
            setItems([]);
          } else {
            setItems((res.items as Array<Record<string, unknown>>).map(normalizeResourceItem));
          }
          return undefined;
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "Failed to load resources");
          setItems([]);
        })
        .finally(() => setLoadingItems(false));

      if (kind === "Node" || kind === "Pod") {
        const scope = kind === "Node" ? "nodes" : "pods";
        void client
          .clusterMetrics({ id: clusterId, scope })
          .then((res) => {
            if (res.error) return;
            const map: Record<string, MetricsEntry> = {};
            for (const item of res.items as Array<{
              name: string;
              namespace?: string;
              cpuNano: number;
              memoryBytes: number;
            }>) {
              const key = scope === "pods" ? `${item.namespace ?? ""}/${item.name}` : item.name;
              map[key] = { cpuNano: item.cpuNano, memoryBytes: item.memoryBytes };
            }
            setMetricsMap(map);
            return undefined;
          })
          .catch(() => {});
      }
    },
    [client, clusterId],
  );

  // Reload whenever the sidebar selection or namespace changes.
  useEffect(() => {
    if (!client || showingHelm || !selectedKind) return;
    loadResources(selectedKind, selectedNamespace, isNamespaced);
  }, [client, showingHelm, selectedKind, selectedNamespace, isNamespaced, loadResources]);

  const handleResourcePress = useCallback(
    (item: ResourceItem) => () => {
      openDetail(clusterId, {
        kind: selectedKind ?? "",
        namespace: item.namespace || undefined,
        name: item.name,
      });
    },
    [openDetail, clusterId, selectedKind],
  );

  // Reload the list when a detail tab mutates a resource (delete/apply/scale).
  useEffect(() => {
    if (listRefreshKey === 0 || !client || showingHelm || !selectedKind) return;
    loadResources(selectedKind, selectedNamespace, isNamespaced);
  }, [
    listRefreshKey,
    client,
    showingHelm,
    selectedKind,
    selectedNamespace,
    isNamespaced,
    loadResources,
  ]);

  const renderResourceItem: ListRenderItem<ResourceItem> = useCallback(
    ({ item }) => {
      const isPod = selectedKind === "Pod";
      const isNodeOrPod = isPod || selectedKind === "Node";
      const metricsKey = isPod ? `${item.namespace ?? ""}/${item.name}` : item.name;
      const metrics = isNodeOrPod ? metricsMap[metricsKey] : undefined;
      return (
        <Pressable style={styles.row} onPress={handleResourcePress(item)}>
          <View style={styles.cellName}>
            {isPod && item.phase ? (
              <PodStatusDot phase={item.phase} statusReason={item.phase} />
            ) : (
              <ClusterStatusDot state="connected" />
            )}
            <Text style={styles.cellNameText} numberOfLines={1}>
              {item.name || "-"}
            </Text>
          </View>
          <Text style={styles.cellNs} numberOfLines={1}>
            {item.namespace || "-"}
          </Text>
          {isPod ? (
            <>
              <Text style={styles.cellNarrow} numberOfLines={1}>
                {item.ready ?? "-"}
              </Text>
              <Text style={styles.cellNarrow} numberOfLines={1}>
                {item.restarts ?? 0}
              </Text>
              <Text style={styles.cellStatus} numberOfLines={1}>
                {item.phase || "-"}
              </Text>
            </>
          ) : null}
          {isNodeOrPod && hasMetrics ? (
            <>
              <Text style={styles.cellMetric} numberOfLines={1}>
                {metrics ? formatCpu(metrics.cpuNano) : "-"}
              </Text>
              <Text style={styles.cellMetric} numberOfLines={1}>
                {metrics ? formatMem(metrics.memoryBytes) : "-"}
              </Text>
            </>
          ) : null}
          <Text style={styles.cellAge} numberOfLines={1}>
            {formatAge(item.creationTimestamp)}
          </Text>
        </Pressable>
      );
    },
    [selectedKind, handleResourcePress, metricsMap, hasMetrics],
  );

  const keyExtractor = useCallback(
    (item: ResourceItem, idx: number) => `${item.namespace ?? ""}/${item.name}/${idx}`,
    [],
  );

  let content: ReactElement;
  if (showingHelm) {
    content = <ClusterHelmView serverId={serverId} clusterId={clusterId} />;
  } else if (!selectedKind) {
    content = (
      <View style={styles.center}>
        <Text style={styles.muted}>Pick a resource on the left to browse.</Text>
      </View>
    );
  } else if (loadingItems) {
    content = (
      <View style={styles.center}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  } else if (error) {
    content = (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  } else {
    const isPodKind = selectedKind === "Pod";
    const isNodeOrPodKind = isPodKind || selectedKind === "Node";
    content = (
      <>
        <View style={styles.toolbar}>
          <Text style={styles.toolbarTitle}>{selectedKind}</Text>
          <Text style={styles.toolbarCount}>{items.length}</Text>
          <View style={styles.toolbarSpacer} />
          <Text style={styles.toolbarNs}>{selectedNamespace ?? "All namespaces"}</Text>
        </View>
        <View style={styles.header}>
          <Text style={styles.headerName}>NAME</Text>
          <Text style={styles.headerNs}>NAMESPACE</Text>
          {isPodKind ? (
            <>
              <Text style={styles.headerNarrow}>READY</Text>
              <Text style={styles.headerNarrow}>RESTARTS</Text>
              <Text style={styles.headerStatus}>STATUS</Text>
            </>
          ) : null}
          {isNodeOrPodKind && hasMetrics ? (
            <>
              <Text style={styles.headerMetric}>CPU</Text>
              <Text style={styles.headerMetric}>MEM</Text>
            </>
          ) : null}
          <Text style={styles.headerAge}>AGE</Text>
        </View>
        {items.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.muted}>No {selectedKind} resources found.</Text>
          </View>
        ) : (
          <FlatList data={items} keyExtractor={keyExtractor} renderItem={renderResourceItem} />
        )}
      </>
    );
  }

  return <View style={styles.container}>{content}</View>;
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 120 },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, fontStyle: "italic" },
  errorText: { fontSize: theme.fontSize.sm, color: theme.colors.palette.red[500] },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  toolbarTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  toolbarCount: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  toolbarSpacer: { flex: 1 },
  toolbarNs: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerName: {
    flex: 1,
    minWidth: 150,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  headerNs: {
    width: 130,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  headerNarrow: {
    width: 60,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  headerStatus: {
    width: 96,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  headerMetric: {
    width: 48,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    textAlign: "right" as const,
  },
  headerAge: {
    width: 48,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    textAlign: "right" as const,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  cellName: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 150,
  },
  cellNameText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  cellNs: { width: 130, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  cellNarrow: { width: 60, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  cellStatus: { width: 96, fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  cellMetric: {
    width: 48,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "right" as const,
  },
  cellAge: {
    width: 48,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "right" as const,
  },
}));
