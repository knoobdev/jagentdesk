import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterNamespaceSelector } from "@/components/cluster-namespace-selector";
import { ClusterResourceDetail } from "@/components/cluster-resource-detail";
import { ClusterHelmView } from "@/components/cluster-helm-view";
import { ClusterStatusDot, PodStatusDot } from "@/components/cluster-dot";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { askAgentAboutResource } from "./cluster-ask-agent";
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

/**
 * clusterResourceList returns raw Kubernetes objects (fields live under
 * item.metadata / item.status), while clusterResources returned flat DTOs.
 * Normalize both shapes into a flat ResourceItem so NAME / NAMESPACE / AGE /
 * STATUS columns are always populated.
 */
function normalizeResourceItem(raw: Record<string, unknown>): ResourceItem {
  const md = (raw.metadata as Record<string, unknown> | undefined) ?? {};
  const status = (raw.status as Record<string, unknown> | undefined) ?? {};
  const name = (md.name as string) ?? (raw.name as string) ?? "";
  const namespace = (md.namespace as string) ?? (raw.namespace as string) ?? "";
  const creationTimestamp =
    (md.creationTimestamp as string) ?? (raw.creationTimestamp as string) ?? "";
  const containerStatuses = (status.containerStatuses as Array<Record<string, unknown>>) ?? [];
  const readyCount = containerStatuses.filter((c) => c.ready === true).length;
  const restarts = containerStatuses.reduce((sum, c) => sum + ((c.restartCount as number) ?? 0), 0);
  return {
    name,
    namespace,
    creationTimestamp,
    phase: (status.phase as string) ?? (raw.phase as string) ?? undefined,
    ready:
      containerStatuses.length > 0
        ? `${readyCount}/${containerStatuses.length}`
        : ((raw.ready as string) ?? undefined),
    restarts: containerStatuses.length > 0 ? restarts : ((raw.restarts as number) ?? undefined),
  };
}

const CATEGORY_ORDER = [
  "Cluster",
  "Workloads",
  "Config",
  "Network",
  "Storage",
  "Access",
  "Custom",
] as const;

function formatAge(creationTimestamp: string): string {
  if (!creationTimestamp) return "-";
  const created = new Date(creationTimestamp).getTime();
  if (Number.isNaN(created)) return "-";
  const now = Date.now();
  const diffMs = now - created;
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

interface MetricsEntry {
  cpuNano: number;
  memoryBytes: number;
}

function bucketCategory(category: string): string {
  const norm = category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
  if ((CATEGORY_ORDER as readonly string[]).includes(norm)) return norm;
  return "Custom";
}

function groupByCategory(kinds: KindInfo[]): Array<{ category: string; kinds: KindInfo[] }> {
  const map = new Map<string, KindInfo[]>();
  for (const kind of kinds) {
    const cat = bucketCategory(kind.category);
    const list = map.get(cat) ?? [];
    list.push(kind);
    map.set(cat, list);
  }
  const result: Array<{ category: string; kinds: KindInfo[] }> = [];
  const seen = new Set<string>();
  for (const cat of CATEGORY_ORDER) {
    const list = map.get(cat);
    if (list) {
      result.push({ category: cat, kinds: list });
      seen.add(cat);
    }
  }
  for (const [cat, list] of map) {
    if (!seen.has(cat)) {
      result.push({ category: cat, kinds: list });
    }
  }
  return result;
}

export function ClusterResourceBrowser({
  serverId,
  clusterId,
}: {
  serverId: string;
  clusterId: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const client = useHostRuntimeClient(serverId);

  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const [items, setItems] = useState<ResourceItem[]>([]);
  const [loadingKinds, setLoadingKinds] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [kindError, setKindError] = useState<string | null>(null);
  const [metricsMap, setMetricsMap] = useState<Record<string, MetricsEntry>>({});
  const [selectedResource, setSelectedResource] = useState<{
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);
  const [selectedNamespace, setSelectedNamespace] = useState<string | undefined>(undefined);
  const [showingHelm, setShowingHelm] = useState(false);
  const kindListRef = useRef<ScrollView>(null);

  // Ask-agent wiring
  const { entries: providerEntries } = useProvidersSnapshot(serverId);
  const firstWorkspace = useSessionStore(
    (state) => state.sessions[serverId]?.workspaces.values().next().value,
  );
  const agentProvider = providerEntries?.find((e) => e.enabled)?.provider ?? null;
  const agentCwd = firstWorkspace?.workspaceDirectory ?? null;

  const handleAskAgent = useCallback(() => {
    if (!client || !agentProvider || !agentCwd || !selectedKind) return;
    void askAgentAboutResource({
      client,
      serverId,
      clusterId,
      kind: selectedKind,
      provider: agentProvider,
      cwd: agentCwd,
    });
  }, [client, serverId, clusterId, selectedKind, agentProvider, agentCwd]);

  useEffect(() => {
    if (!client) {
      setLoadingKinds(false);
      return;
    }
    setLoadingKinds(true);
    setKindError(null);
    void client
      .clusterKinds({ id: clusterId })
      .then((res) => {
        if (res.error) {
          setKindError(res.error);
          setKinds([]);
        } else {
          setKinds(res.kinds as KindInfo[]);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setKindError(e instanceof Error ? e.message : "Failed to load kinds");
        setKinds([]);
      })
      .finally(() => setLoadingKinds(false));
  }, [client, clusterId]);

  const selectedKindInfo = useMemo(
    () => kinds.find((k) => k.kind === selectedKind) ?? null,
    [kinds, selectedKind],
  );
  const isNamespaced = selectedKindInfo?.namespaced ?? false;

  const loadResources = useCallback(
    (kind: string, namespace: string | undefined) => {
      if (!client) return;
      setLoadingItems(true);
      setError(null);
      setMetricsMap({});
      void client
        .clusterResourceList({
          id: clusterId,
          kind,
          ...(isNamespaced && namespace ? { namespace } : {}),
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
    [client, clusterId, isNamespaced],
  );

  const handleSelectKind = useCallback(
    (kind: string) => {
      setShowingHelm(false);
      setSelectedKind(kind);
      loadResources(kind, selectedNamespace);
    },
    [loadResources, selectedNamespace],
  );

  const handleNamespaceChange = useCallback(
    (namespace: string | undefined) => {
      setSelectedNamespace(namespace);
      if (selectedKind) {
        loadResources(selectedKind, namespace);
      }
    },
    [selectedKind, loadResources],
  );

  const handleSelectHelm = useCallback(() => {
    setShowingHelm(true);
    setSelectedKind(null);
    setItems([]);
  }, []);

  const handleResourcePress = useCallback(
    (item: ResourceItem) => () => {
      setSelectedResource({
        kind: selectedKind ?? "",
        namespace: item.namespace ?? "",
        name: item.name,
      });
    },
    [selectedKind],
  );

  const handleDetailClose = useCallback(() => {
    setSelectedResource(null);
  }, []);

  const handleDetailChanged = useCallback(() => {
    if (client && selectedKind) {
      loadResources(selectedKind, selectedNamespace);
    }
  }, [client, selectedKind, selectedNamespace, loadResources]);

  const grouped = useMemo(() => groupByCategory(kinds), [kinds]);
  const hasMetrics = useMemo(() => Object.keys(metricsMap).length > 0, [metricsMap]);

  const renderResourceItem: ListRenderItem<ResourceItem> = useCallback(
    ({ item }) => {
      const isPod = selectedKind === "Pod";
      const isNode = selectedKind === "Node";
      const isNodeOrPod = isNode || isPod;
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

  const handleMobileChipPress = useCallback(
    (kind: string) => () => handleSelectKind(kind),
    [handleSelectKind],
  );

  const renderKindItem = useCallback(
    (kind: KindInfo) => {
      const isSelected = selectedKind === kind.kind;
      const isPod = kind.kind === "Pod";
      const onPress = handleMobileChipPress(kind.kind);
      return (
        <Pressable
          key={kind.kind}
          style={[styles.kindRow, isSelected && styles.kindRowSelected]}
          onPress={onPress}
        >
          {isPod ? <PodStatusDot phase="unknown" /> : <ClusterStatusDot state="connected" />}
          <Text style={[styles.kindName, isSelected && styles.kindNameSelected]} numberOfLines={1}>
            {kind.kind}
          </Text>
        </Pressable>
      );
    },
    [selectedKind, handleMobileChipPress],
  );

  const renderCategory = useCallback(
    (group: { category: string; kinds: KindInfo[] }) => (
      <View key={group.category} style={styles.categoryGroup}>
        <Text style={styles.categoryHeader}>{group.category}</Text>
        {group.kinds.map(renderKindItem)}
      </View>
    ),
    [renderKindItem],
  );

  const renderResourceContent = useCallback(() => {
    if (showingHelm) {
      return <ClusterHelmView serverId={serverId} clusterId={clusterId} />;
    }
    if (!selectedKind) {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.emptyText}>Select a resource kind to browse.</Text>
        </View>
      );
    }
    if (loadingItems) {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.loadingText}>Loading...</Text>
        </View>
      );
    }
    if (error) {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      );
    }
    if (items.length === 0) {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.emptyText}>No resources found.</Text>
        </View>
      );
    }
    const isPodKind = selectedKind === "Pod";
    const isNodeOrPodKind = isPodKind || selectedKind === "Node";
    return (
      <>
        <View style={styles.toolbar}>
          <Text style={styles.toolbarTitle}>{selectedKind}</Text>
          <Text style={styles.toolbarCount}>{items.length}</Text>
          <View style={styles.toolbarSpacer} />
          {isNamespaced ? (
            <ClusterNamespaceSelector
              serverId={serverId}
              clusterId={clusterId}
              value={selectedNamespace}
              onChange={handleNamespaceChange}
            />
          ) : null}
          <Pressable
            style={[styles.askBtn, (!agentProvider || !agentCwd) && styles.askBtnDisabled]}
            onPress={handleAskAgent}
            disabled={!agentProvider || !agentCwd}
          >
            <Text style={styles.askBtnText}>Ask an agent</Text>
          </Pressable>
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
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderResourceItem}
          scrollEnabled={false}
          style={styles.list}
        />
      </>
    );
  }, [
    selectedKind,
    loadingItems,
    error,
    items,
    keyExtractor,
    renderResourceItem,
    showingHelm,
    serverId,
    clusterId,
    agentProvider,
    agentCwd,
    handleAskAgent,
    isNamespaced,
    selectedNamespace,
    handleNamespaceChange,
    hasMetrics,
  ]);

  // ── Loading state ──
  if (loadingKinds) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.loadingText}>Loading kinds...</Text>
      </View>
    );
  }

  // ── Error state ──
  if (kindError) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>{kindError}</Text>
      </View>
    );
  }

  // ── Empty state ──
  if (kinds.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.emptyText}>No resource kinds found.</Text>
      </View>
    );
  }

  // ── Content ──
  if (isCompact) {
    return (
      <View style={styles.container}>
        {/* Mobile: horizontal chip nav */}
        <ScrollView
          ref={kindListRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.mobileNavScroll}
          contentContainerStyle={styles.mobileNavContent}
        >
          {grouped.map((group) => (
            <View key={group.category} style={styles.mobileCategoryGroup}>
              <Text style={styles.mobileCategoryLabel}>{group.category}</Text>
              {group.kinds.map((kind) => {
                const isSelected = selectedKind === kind.kind;
                const onPress = handleMobileChipPress(kind.kind);
                return (
                  <Pressable
                    key={kind.kind}
                    style={[styles.mobileChip, isSelected && styles.mobileChipSelected]}
                    onPress={onPress}
                  >
                    <Text
                      style={[styles.mobileChipText, isSelected && styles.mobileChipTextSelected]}
                    >
                      {kind.kind}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
          {/* Helm nav */}
          <View style={styles.mobileCategoryGroup}>
            <Text style={styles.mobileCategoryLabel}>Helm</Text>
            <Pressable
              style={[styles.mobileChip, showingHelm && styles.mobileChipSelected]}
              onPress={handleSelectHelm}
            >
              <Text style={[styles.mobileChipText, showingHelm && styles.mobileChipTextSelected]}>
                Releases
              </Text>
            </Pressable>
          </View>
        </ScrollView>

        {/* Resource table */}
        <View style={styles.contentArea}>{renderResourceContent()}</View>

        {selectedResource ? (
          <ClusterResourceDetail
            serverId={serverId}
            clusterId={clusterId}
            kind={selectedResource.kind}
            namespace={selectedResource.namespace || undefined}
            name={selectedResource.name}
            onClose={handleDetailClose}
            onChanged={handleDetailChanged}
          />
        ) : null}
      </View>
    );
  }

  // Desktop: two-column layout
  return (
    <View style={styles.container}>
      <View style={styles.desktopLayout}>
        <ScrollView style={styles.navRail} contentContainerStyle={styles.navRailContent}>
          {grouped.map(renderCategory)}
          <View style={styles.categoryGroup}>
            <Text style={styles.categoryHeader}>Helm</Text>
            <Pressable
              style={[styles.kindRow, showingHelm && styles.kindRowSelected]}
              onPress={handleSelectHelm}
            >
              <Text
                style={[styles.kindName, showingHelm && styles.kindNameSelected]}
                numberOfLines={1}
              >
                Releases
              </Text>
            </Pressable>
          </View>
        </ScrollView>

        <View style={styles.contentArea}>{renderResourceContent()}</View>
      </View>

      {selectedResource ? (
        <ClusterResourceDetail
          serverId={serverId}
          clusterId={clusterId}
          kind={selectedResource.kind}
          namespace={selectedResource.namespace || undefined}
          name={selectedResource.name}
          onClose={handleDetailClose}
          onChanged={handleDetailChanged}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  desktopLayout: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 120,
  },
  // ── Loading / Error / Empty ──
  loadingText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.palette.red[500],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
  },
  // ── Nav rail (desktop) ──
  navRail: {
    width: 200,
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    marginRight: theme.spacing[3],
  },
  navRailContent: {
    paddingVertical: theme.spacing[1],
    gap: theme.spacing[1],
  },
  categoryGroup: {
    gap: 1,
  },
  categoryHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  kindRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  kindRowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  kindName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flex: 1,
    minWidth: 0,
  },
  kindNameSelected: {
    fontWeight: theme.fontWeight.medium,
  },
  // ── Mobile nav ──
  mobileNavScroll: {
    marginBottom: theme.spacing[2],
  },
  mobileNavContent: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  mobileCategoryGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  mobileCategoryLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginRight: theme.spacing[1],
  },
  mobileChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  mobileChipSelected: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.foregroundMuted,
  },
  mobileChipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  mobileChipTextSelected: {
    fontWeight: theme.fontWeight.medium,
  },
  // ── Content area ──
  contentArea: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
  },
  // ── Toolbar ──
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
  toolbarCount: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  toolbarSpacer: {
    flex: 1,
  },
  askBtn: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  askBtnDisabled: {
    opacity: 0.5,
  },
  askBtnText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  // ── Table header ──
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
  // ── Rows ──
  list: {
    flexGrow: 0,
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
  cellNs: {
    width: 130,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  cellNarrow: {
    width: 60,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  cellStatus: {
    width: 96,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
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
