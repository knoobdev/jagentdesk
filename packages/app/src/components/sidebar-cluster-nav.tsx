import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronLeft, Boxes, Gauge } from "lucide-react-native";
import { router } from "expo-router";
import type { ClusterInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { KindIcon } from "@/components/cluster-kind-icon";
import { ClusterNamespaceSelector } from "@/components/cluster-namespace-selector";
import { ClusterStatusDot } from "@/components/cluster-dot";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import { useClusterViewStore } from "@/stores/cluster-view-store";
import { usePanelStore } from "@/stores/panel-store";
import { useIsCompactFormFactor } from "@/constants/layout";
import { buildClustersRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";

const ThemedChevronLeft = withUnistyles(ChevronLeft);
const ThemedBoxes = withUnistyles(Boxes);
const ThemedGauge = withUnistyles(Gauge);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface KindInfo {
  kind: string;
  apiVersion: string;
  namespaced: boolean;
  category: string;
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

function bucket(category: string): string {
  const norm = category.charAt(0).toUpperCase() + category.slice(1).toLowerCase();
  return (CATEGORY_ORDER as readonly string[]).includes(norm) ? norm : "Custom";
}

function groupByCategory(kinds: KindInfo[]): Array<{ category: string; kinds: KindInfo[] }> {
  const map = new Map<string, KindInfo[]>();
  for (const k of kinds) {
    const c = bucket(k.category);
    const list = map.get(c) ?? [];
    list.push(k);
    map.set(c, list);
  }
  const out: Array<{ category: string; kinds: KindInfo[] }> = [];
  const seen = new Set<string>();
  for (const c of CATEGORY_ORDER) {
    const list = map.get(c);
    if (list) {
      out.push({ category: c, kinds: list });
      seen.add(c);
    }
  }
  for (const [c, list] of map) if (!seen.has(c)) out.push({ category: c, kinds: list });
  return out;
}

function KindRow({
  kind,
  active,
  onSelect,
}: {
  kind: string;
  active: boolean;
  onSelect: (kind: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(kind), [kind, onSelect]);
  return (
    <Pressable style={[styles.row, active && styles.rowActive]} onPress={handlePress}>
      <KindIcon kind={kind} active={active} />
      <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>
        {kind}
      </Text>
    </Pressable>
  );
}

export function SidebarClusterNav({
  serverId,
  clusterId,
}: {
  serverId: string;
  clusterId: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [cluster, setCluster] = useState<ClusterInfo | null>(null);

  const selectedKind = useClusterNavStore((s) => s.selectedKind);
  const showingHelm = useClusterNavStore((s) => s.showingHelm);
  const selectedNamespace = useClusterNavStore((s) => s.selectedNamespace);
  const selectKind = useClusterNavStore((s) => s.selectKind);
  const selectHelm = useClusterNavStore((s) => s.selectHelm);
  const showingOverview = useClusterNavStore((s) => s.showingOverview);
  const selectOverview = useClusterNavStore((s) => s.selectOverview);
  const setNamespace = useClusterNavStore((s) => s.setNamespace);
  const ensureCluster = useClusterNavStore((s) => s.ensureCluster);
  const showList = useClusterViewStore((s) => s.setActive);
  const showMobileAgent = usePanelStore((s) => s.showMobileAgent);
  const isCompact = useIsCompactFormFactor();

  useEffect(() => {
    ensureCluster(clusterId);
  }, [clusterId, ensureCluster]);

  useEffect(() => {
    if (!client) return;
    void client
      .clusterKinds({ id: clusterId })
      .then((res) => {
        if (!res.error) setKinds(res.kinds as KindInfo[]);
        return undefined;
      })
      .catch(() => {});
    void client
      .clusterList()
      .then((res) => {
        if (!res.error) setCluster(res.clusters.find((c) => c.id === clusterId) ?? null);
        return undefined;
      })
      .catch(() => {});
  }, [client, clusterId]);

  const grouped = useMemo(() => groupByCategory(kinds), [kinds]);

  const handleSelectKind = useCallback(
    (kind: string) => {
      selectKind(clusterId, kind);
      showList(null); // switching kind returns to the list view
      // On phones the nav is a slide-in overlay; dismiss it so the resource list
      // is revealed instead of leaving the user to drag the sidebar away.
      if (isCompact) showMobileAgent();
    },
    [clusterId, selectKind, showList, isCompact, showMobileAgent],
  );
  const handleSelectOverview = useCallback(() => {
    selectOverview(clusterId);
    showList(null);
    if (isCompact) showMobileAgent();
  }, [clusterId, selectOverview, showList, isCompact, showMobileAgent]);
  const handleSelectHelm = useCallback(() => {
    selectHelm(clusterId);
    showList(null);
    if (isCompact) showMobileAgent();
  }, [clusterId, selectHelm, showList, isCompact, showMobileAgent]);
  // Two distinct back affordances: "Back" returns to wherever the user came from
  // (the previous screen — e.g. an agent, or the clusters list), while "Clusters"
  // always jumps to the clusters list so they can pick a different cluster.
  const handleBackToPrevious = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace(buildClustersRoute(serverId));
  }, [serverId]);
  const handleBackToClusters = useCallback(() => {
    router.replace(buildClustersRoute(serverId));
  }, [serverId]);

  return (
    <View style={styles.container}>
      <View style={styles.backRow}>
        <Pressable
          style={styles.backBtn}
          onPress={handleBackToPrevious}
          accessibilityLabel="Back to previous page"
          testID="cluster-back-previous"
        >
          <ThemedChevronLeft size={16} uniProps={mutedColor} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
        <View style={styles.backDivider} />
        <Pressable
          style={styles.backBtn}
          onPress={handleBackToClusters}
          accessibilityLabel="Back to clusters list"
          testID="cluster-back-list"
        >
          <ThemedBoxes size={15} uniProps={mutedColor} />
          <Text style={styles.backText}>Clusters</Text>
        </Pressable>
      </View>

      <View style={styles.clusterCard}>
        <ClusterStatusDot state={cluster?.state ?? "connected"} />
        <Text style={styles.clusterName} numberOfLines={1}>
          {cluster?.displayName ?? cluster?.contextName ?? "Cluster"}
        </Text>
      </View>

      <View style={styles.nsRow}>
        <ClusterNamespaceSelector
          serverId={serverId}
          clusterId={clusterId}
          value={selectedNamespace}
          onChange={setNamespace}
        />
      </View>

      <ScrollView style={styles.nav} contentContainerStyle={styles.navContent}>
        <Pressable
          style={[styles.row, showingOverview && styles.rowActive]}
          onPress={handleSelectOverview}
        >
          <ThemedGauge size={15} uniProps={mutedColor} />
          <Text style={[styles.rowLabel, showingOverview && styles.rowLabelActive]}>Overview</Text>
        </Pressable>
        {grouped.map((group) => (
          <NavGroup
            key={group.category}
            group={group}
            showingHelm={showingHelm}
            selectedKind={selectedKind}
            onSelect={handleSelectKind}
          />
        ))}
        <Text style={styles.categoryHeader}>Helm</Text>
        <Pressable style={[styles.row, showingHelm && styles.rowActive]} onPress={handleSelectHelm}>
          <ThemedBoxes size={15} uniProps={mutedColor} />
          <Text style={[styles.rowLabel, showingHelm && styles.rowLabelActive]}>Releases</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

// A category group in the resource tree. Long groups (notably "Custom"/CRDs on
// clusters with many CRDs) are capped with a Show more / Show less toggle so the
// tree stays navigable.
const GROUP_CAP = 8;
function NavGroup({
  group,
  showingHelm,
  selectedKind,
  onSelect,
}: {
  group: { category: string; kinds: KindInfo[] };
  showingHelm: boolean;
  selectedKind: string | null;
  onSelect: (kind: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);
  const overflow = group.kinds.length > GROUP_CAP;
  const visible = expanded || !overflow ? group.kinds : group.kinds.slice(0, GROUP_CAP);
  return (
    <View>
      <Text style={styles.categoryHeader}>{group.category}</Text>
      {visible.map((k) => (
        <KindRow
          key={k.kind}
          kind={k.kind}
          active={!showingHelm && selectedKind === k.kind}
          onSelect={onSelect}
        />
      ))}
      {overflow ? (
        <Pressable style={styles.showMore} onPress={toggleExpanded}>
          <Text style={styles.showMoreText}>
            {expanded ? "Show less" : `Show ${group.kinds.length - GROUP_CAP} more`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  backBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  backDivider: {
    width: StyleSheet.hairlineWidth,
    alignSelf: "stretch",
    marginVertical: theme.spacing[1],
    backgroundColor: theme.colors.border,
  },
  backText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  clusterCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  clusterName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  nsRow: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  nav: {
    flex: 1,
    minHeight: 0,
  },
  navContent: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[3],
  },
  categoryHeader: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundExtraMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
  showMore: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  showMoreText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accent,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  rowActive: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowLabel: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowLabelActive: {
    color: theme.colors.foreground,
  },
}));
