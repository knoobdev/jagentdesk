import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ClusterResourceDetail } from "@/components/cluster-resource-detail";
import { ClusterHelmView } from "@/components/cluster-helm-view";
import { ClusterStatusDot, PodStatusDot } from "@/components/cluster-dot";
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
  const created = new Date(creationTimestamp).getTime();
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
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<{
    kind: string;
    namespace: string;
    name: string;
  } | null>(null);
  const [showingHelm, setShowingHelm] = useState(false);
  const kindListRef = useRef<ScrollView>(null);

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

  const handleSelectKind = useCallback(
    (kind: string) => {
      if (!client) return;
      setShowingHelm(false);
      setSelectedKind(kind);
      setLoadingItems(true);
      setError(null);
      setMetricsMap({});
      setMetricsError(null);
      void client
        .clusterResourceList({ id: clusterId, kind })
        .then((res) => {
          if (res.error) {
            setError(res.error);
            setItems([]);
          } else {
            setItems(res.items as ResourceItem[]);
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
            if (res.error) {
              setMetricsError(res.error);
              return;
            }
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
          .catch((e: unknown) => {
            setMetricsError(e instanceof Error ? e.message : "Metrics unavailable");
          });
      }
    },
    [client, clusterId],
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
    // Reload the current resource list
    if (client && selectedKind) {
      setLoadingItems(true);
      setError(null);
      setMetricsMap({});
      setMetricsError(null);
      void client
        .clusterResourceList({ id: clusterId, kind: selectedKind })
        .then((res) => {
          if (res.error) {
            setError(res.error);
            setItems([]);
          } else {
            setItems(res.items as ResourceItem[]);
          }
          return undefined;
        })
        .catch((e: unknown) => {
          setError(e instanceof Error ? e.message : "Failed to load resources");
          setItems([]);
        })
        .finally(() => setLoadingItems(false));

      if (selectedKind === "Node" || selectedKind === "Pod") {
        const scope = selectedKind === "Node" ? "nodes" : "pods";
        void client
          .clusterMetrics({ id: clusterId, scope })
          .then((res) => {
            if (res.error) {
              setMetricsError(res.error);
              return;
            }
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
          .catch((e: unknown) => {
            setMetricsError(e instanceof Error ? e.message : "Metrics unavailable");
          });
      }
    }
  }, [client, clusterId, selectedKind]);

  const grouped = useMemo(() => groupByCategory(kinds), [kinds]);

  const renderResourceItem: ListRenderItem<ResourceItem> = useCallback(
    ({ item }) => {
      const isPod = selectedKind === "Pod";
      const isNodeOrPod = selectedKind === "Node" || isPod;
      const podPhase = isPod
        ? ((
            (item as unknown as Record<string, unknown>).status as
              | Record<string, unknown>
              | undefined
          )?.phase as string | undefined)
        : undefined;
      const metricsKey = isPod ? `${item.namespace ?? ""}/${item.name}` : item.name;
      const metrics = isNodeOrPod ? metricsMap[metricsKey] : undefined;
      let metricsContent: React.ReactNode = null;
      if (isNodeOrPod) {
        if (metrics) {
          metricsContent = (
            <>
              <Text style={styles.resourceCpu}>{formatCpu(metrics.cpuNano)}</Text>
              <Text style={styles.resourceMem}>{formatMem(metrics.memoryBytes)}</Text>
            </>
          );
        } else if (metricsError) {
          metricsContent = (
            <Text style={styles.metricsUnavailable} numberOfLines={1}>
              metrics unavailable
            </Text>
          );
        } else {
          metricsContent = (
            <>
              <Text style={styles.resourceCpu}>-</Text>
              <Text style={styles.resourceMem}>-</Text>
            </>
          );
        }
      }
      return (
        <Pressable style={styles.resourceRow} onPress={handleResourcePress(item)}>
          <View style={styles.resourceNameCell}>
            {isPod && podPhase ? (
              <PodStatusDot phase={podPhase} />
            ) : (
              <ClusterStatusDot state="connected" />
            )}
            <Text style={styles.resourceName} numberOfLines={1}>
              {item.name}
            </Text>
          </View>
          <Text style={styles.resourceNamespace} numberOfLines={1}>
            {item.namespace ?? "-"}
          </Text>
          {metricsContent}
          <Text style={styles.resourceAge}>{formatAge(item.creationTimestamp)}</Text>
        </Pressable>
      );
    },
    [selectedKind, handleResourcePress, metricsMap, metricsError],
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
    return (
      <>
        <View style={styles.tableHeader}>
          <Text style={styles.tableHeaderName}>NAME</Text>
          <Text style={styles.tableHeaderNamespace}>NAMESPACE</Text>
          {selectedKind === "Node" || selectedKind === "Pod" ? (
            <>
              <Text style={styles.tableHeaderCpu}>CPU</Text>
              <Text style={styles.tableHeaderMem}>MEM</Text>
            </>
          ) : null}
          <Text style={styles.tableHeaderAge}>AGE</Text>
        </View>
        <FlatList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderResourceItem}
          scrollEnabled={false}
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
  // ── Table ──
  tableHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  tableHeaderName: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  tableHeaderNamespace: {
    width: 140,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  tableHeaderAge: {
    width: 60,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    textAlign: "right" as const,
  },
  tableHeaderCpu: {
    width: 60,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    textAlign: "right" as const,
  },
  tableHeaderMem: {
    width: 60,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    textAlign: "right" as const,
  },
  resourceRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  resourceNameCell: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minWidth: 0,
  },
  resourceName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flex: 1,
    minWidth: 0,
  },
  resourceNamespace: {
    width: 140,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  resourceCpu: {
    width: 60,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "right" as const,
  },
  resourceMem: {
    width: 60,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "right" as const,
  },
  metricsUnavailable: {
    width: 120,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic" as const,
    textAlign: "right" as const,
  },
  resourceAge: {
    width: 60,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "right" as const,
  },
}));
