import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  FlatList,
  Modal,
  Pressable,
  Text,
  TextInput,
  View,
  type ListRenderItem,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterHelmView } from "@/components/cluster-helm-view";
import { ClusterOverviewDashboard } from "@/components/cluster-overview-dashboard";
import { ClusterStatusDot, PodStatusDot } from "@/components/cluster-dot";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import { useClusterViewStore } from "@/stores/cluster-view-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Skeleton, useSkeletonPulse } from "@/components/ui/skeleton";
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

function PodCells({ item, isCompact }: { item: ResourceItem; isCompact: boolean }) {
  return (
    <>
      <Text style={styles.cellNarrow} numberOfLines={1}>
        {item.ready ?? "-"}
      </Text>
      {isCompact ? null : (
        <>
          <Text style={styles.cellNarrow} numberOfLines={1}>
            {item.restarts ?? 0}
          </Text>
          <Text style={styles.cellStatus} numberOfLines={1}>
            {item.phase || "-"}
          </Text>
        </>
      )}
    </>
  );
}

function MetricCells({ metrics }: { metrics: MetricsEntry | undefined }) {
  return (
    <>
      <Text style={styles.cellMetric} numberOfLines={1}>
        {metrics ? formatCpu(metrics.cpuNano) : "-"}
      </Text>
      <Text style={styles.cellMetric} numberOfLines={1}>
        {metrics ? formatMem(metrics.memoryBytes) : "-"}
      </Text>
    </>
  );
}

function ResourceRow({
  item,
  isPod,
  isNodeOrPod,
  isCompact,
  hasMetrics,
  metrics,
  onPress,
}: {
  item: ResourceItem;
  isPod: boolean;
  isNodeOrPod: boolean;
  isCompact: boolean;
  hasMetrics: boolean;
  metrics: MetricsEntry | undefined;
  onPress: () => void;
}) {
  const sub = isPod && item.phase ? `${item.namespace} · ${item.phase}` : item.namespace;
  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.cellName}>
        {isPod && item.phase ? (
          <PodStatusDot phase={item.phase} statusReason={item.phase} />
        ) : (
          <ClusterStatusDot state="connected" />
        )}
        <View style={styles.cellNameInner}>
          <Text style={styles.cellNameText} numberOfLines={1}>
            {item.name || "-"}
          </Text>
          {isCompact && item.namespace ? (
            <Text style={styles.cellNameSub} numberOfLines={1}>
              {sub}
            </Text>
          ) : null}
        </View>
      </View>
      {isCompact ? null : (
        <Text style={styles.cellNs} numberOfLines={1}>
          {item.namespace || "-"}
        </Text>
      )}
      {isPod ? <PodCells item={item} isCompact={isCompact} /> : null}
      {!isCompact && isNodeOrPod && hasMetrics ? <MetricCells metrics={metrics} /> : null}
      <Text style={styles.cellAge} numberOfLines={1}>
        {formatAge(item.creationTimestamp)}
      </Text>
    </Pressable>
  );
}

/** Friendly message for a failed list — flags RBAC/permission errors clearly. */
function describeClusterListError(kind: string, raw: string): string {
  if (/forbidden|cannot list|not allowed|unauthorized|permission|rbac/i.test(raw)) {
    return `You don't have permission to view ${kind} in this cluster.\n\n${raw}`;
  }
  return raw;
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
  const showingOverview = useClusterNavStore((s) => s.showingOverview);
  const selectedNamespace = useClusterNavStore((s) => s.selectedNamespace);
  const isCompact = useIsCompactFormFactor();

  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A centered popup shown when listing the selected kind fails — most often a
  // permission (RBAC) error on a restricted cluster where the kind is in the menu
  // but the user isn't allowed to list it.
  const [errorPopup, setErrorPopup] = useState<string | null>(null);
  const [metricsMap, setMetricsMap] = useState<Record<string, MetricsEntry>>({});
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<"name" | "age">("name");
  const [sortAsc, setSortAsc] = useState(true);
  const openDetail = useClusterViewStore((s) => s.openDetail);
  const listRefreshKey = useClusterViewStore((s) => s.listRefreshKey);

  // Clear the search box + any error popup when switching kinds so a stale
  // filter/error never carries over to a fresh list.
  useEffect(() => {
    setErrorPopup(null);
    setQuery("");
  }, [selectedKind]);

  const toggleSort = useCallback(
    (key: "name" | "age") => {
      if (sortKey === key) setSortAsc((v) => !v);
      else {
        setSortKey(key);
        setSortAsc(true);
      }
    },
    [sortKey],
  );
  const sortByName = useCallback(() => toggleSort("name"), [toggleSort]);
  const sortByAge = useCallback(() => toggleSort("age"), [toggleSort]);
  const dismissErrorPopup = useCallback(() => setErrorPopup(null), []);
  const sortArrow = useCallback(
    (key: "name" | "age") => {
      if (sortKey !== key) return "";
      return sortAsc ? " ↑" : " ↓";
    },
    [sortKey, sortAsc],
  );

  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? items.filter(
          (it) =>
            it.name.toLowerCase().includes(q) || (it.namespace ?? "").toLowerCase().includes(q),
        )
      : items;
    const sorted = [...filtered].sort((a, b) => {
      if (sortKey === "age") {
        // creationTimestamp is ISO, so a string compare orders by time (older =
        // smaller). Ascending shows oldest first.
        return (a.creationTimestamp ?? "").localeCompare(b.creationTimestamp ?? "");
      }
      return a.name.localeCompare(b.name);
    });
    return sortAsc ? sorted : sorted.toReversed();
  }, [items, query, sortKey, sortAsc]);

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
      const activeClient = client;
      setLoadingItems(true);
      setError(null);
      setMetricsMap({});
      const listOnce = () =>
        activeClient.clusterResourceList({
          id: clusterId,
          kind,
          ...(namespaced && namespace ? { namespace } : {}),
        });
      void (async () => {
        try {
          let res = await listOnce();
          // The daemon holds the kube connection in memory; it's dropped on a
          // daemon restart (e.g. after an app update). Re-establish it once and
          // retry before surfacing "cluster not connected" as a dead-end error.
          if (res.error && /not connected/i.test(res.error)) {
            const con = await activeClient.clusterConnect({ id: clusterId });
            if (!con.error) res = await listOnce();
          }
          if (res.error) {
            setError(res.error);
            setErrorPopup(describeClusterListError(kind, res.error));
            setItems([]);
          } else {
            setItems((res.items as Array<Record<string, unknown>>).map(normalizeResourceItem));
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : "Failed to load resources";
          setError(message);
          setErrorPopup(describeClusterListError(kind, message));
          setItems([]);
        } finally {
          setLoadingItems(false);
        }
      })();

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
      const metrics = isNodeOrPod && hasMetrics ? metricsMap[metricsKey] : undefined;
      return (
        <ResourceRow
          item={item}
          isPod={isPod}
          isNodeOrPod={isNodeOrPod}
          isCompact={isCompact}
          hasMetrics={hasMetrics}
          metrics={metrics}
          onPress={handleResourcePress(item)}
        />
      );
    },
    [selectedKind, handleResourcePress, metricsMap, hasMetrics, isCompact],
  );

  const keyExtractor = useCallback(
    (item: ResourceItem, idx: number) => `${item.namespace ?? ""}/${item.name}/${idx}`,
    [],
  );

  let content: ReactElement;
  if (showingOverview) {
    content = <ClusterOverviewDashboard serverId={serverId} clusterId={clusterId} />;
  } else if (showingHelm) {
    content = <ClusterHelmView serverId={serverId} clusterId={clusterId} />;
  } else if (!selectedKind) {
    content = (
      <View style={styles.center}>
        <Text style={styles.muted}>Pick a resource on the left to browse.</Text>
      </View>
    );
  } else if (loadingItems) {
    content = <ResourceListSkeleton kind={selectedKind} isCompact={isCompact} />;
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
          <Text style={styles.toolbarCount}>
            {query ? `${visibleItems.length}/${items.length}` : items.length}
          </Text>
          <TextInput
            style={styles.search}
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${selectedKind}…`}
            placeholderTextColor={styles.toolbarNs.color}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {isCompact ? null : (
            <>
              <View style={styles.toolbarSpacer} />
              <Text style={styles.toolbarNs}>{selectedNamespace ?? "All namespaces"}</Text>
            </>
          )}
        </View>
        <View style={styles.header}>
          <Pressable style={styles.headerNameBtn} onPress={sortByName}>
            <Text style={styles.headerName}>NAME{sortArrow("name")}</Text>
          </Pressable>
          {isCompact ? null : <Text style={styles.headerNs}>NAMESPACE</Text>}
          {isPodKind ? (
            <>
              <Text style={styles.headerNarrow}>READY</Text>
              {isCompact ? null : (
                <>
                  <Text style={styles.headerNarrow}>RESTARTS</Text>
                  <Text style={styles.headerStatus}>STATUS</Text>
                </>
              )}
            </>
          ) : null}
          {!isCompact && isNodeOrPodKind && hasMetrics ? (
            <>
              <Text style={styles.headerMetric}>CPU</Text>
              <Text style={styles.headerMetric}>MEM</Text>
            </>
          ) : null}
          <Pressable onPress={sortByAge}>
            <Text style={styles.headerAge}>AGE{sortArrow("age")}</Text>
          </Pressable>
        </View>
        {visibleItems.length === 0 ? (
          <View style={styles.center}>
            <Text style={styles.muted}>
              {items.length === 0
                ? `No ${selectedKind} resources found.`
                : `No matches for “${query}”.`}
            </Text>
          </View>
        ) : (
          <FlatList
            data={visibleItems}
            keyExtractor={keyExtractor}
            renderItem={renderResourceItem}
          />
        )}
      </>
    );
  }

  return (
    <View style={styles.container}>
      {content}
      <ClusterErrorPopup message={errorPopup} onDismiss={dismissErrorPopup} />
    </View>
  );
}

/** Centered popup for a failed resource list (typically an RBAC permission error). */
function ClusterErrorPopup({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  return (
    <Modal visible={message !== null} transparent animationType="fade" onRequestClose={onDismiss}>
      <Pressable style={styles.modalBackdrop} onPress={onDismiss}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>Cannot load this resource</Text>
          <Text style={styles.modalMessage}>{message}</Text>
          <Pressable style={styles.modalButton} onPress={onDismiss} testID="cluster-error-dismiss">
            <Text style={styles.modalButtonText}>OK</Text>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}

const RESOURCE_SKELETON_KEYS = Array.from({ length: 10 }, (_, i) => `cluster-res-skel-${i}`);

/** Table placeholder shown while a resource kind's list is loading. */
function ResourceListSkeleton({ kind, isCompact }: { kind: string | null; isCompact: boolean }) {
  const pulse = useSkeletonPulse();
  return (
    <>
      <View style={styles.toolbar}>
        <Text style={styles.toolbarTitle}>{kind ?? ""}</Text>
        <Skeleton pulse={pulse} width={28} height={12} />
      </View>
      <View style={styles.header}>
        <Text style={styles.headerName}>NAME</Text>
        {isCompact ? null : <Text style={styles.headerNs}>NAMESPACE</Text>}
        <Text style={styles.headerAge}>AGE</Text>
      </View>
      {RESOURCE_SKELETON_KEYS.map((key) => (
        <View key={key} style={styles.row}>
          <View style={styles.cellName}>
            <Skeleton pulse={pulse} width={8} height={8} radius={4} />
            <View style={styles.cellNameInner}>
              <Skeleton pulse={pulse} width="70%" height={13} />
            </View>
          </View>
          {isCompact ? null : (
            <View style={styles.cellNs}>
              <Skeleton pulse={pulse} width="80%" height={12} />
            </View>
          )}
          <View style={styles.cellAge}>
            <Skeleton pulse={pulse} width={24} height={12} />
          </View>
        </View>
      ))}
    </>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 120 },
  muted: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, fontStyle: "italic" },
  errorText: { fontSize: theme.fontSize.sm, color: theme.colors.palette.red[500] },
  modalBackdrop: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.5)",
    padding: theme.spacing[4],
  },
  modalCard: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[3],
    padding: theme.spacing[4],
    borderRadius: 14,
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.border,
    borderWidth: StyleSheet.hairlineWidth,
  },
  modalTitle: { fontSize: theme.fontSize.base, fontWeight: "600", color: theme.colors.foreground },
  modalMessage: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 20,
  },
  modalButton: {
    alignSelf: "flex-end",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: 8,
    backgroundColor: theme.colors.surface3,
  },
  modalButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
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
  search: {
    width: 240,
    marginLeft: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  headerNameBtn: {
    flex: 1,
    minWidth: 150,
  },
  headerName: {
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
  cellNameInner: {
    flex: 1,
    minWidth: 0,
  },
  cellNameText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  cellNameSub: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
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
