import { useEffect, useMemo, useState } from "react";
import { ScrollView, type StyleProp, Text, View, type ViewStyle } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useClusterViewStore } from "@/stores/cluster-view-store";
import type { Theme } from "@/styles/theme";

/**
 * k8s-Lens-style cluster Overview: the default view when a cluster opens.
 * Composes headline counts + a pod-health breakdown from the existing
 * cluster/resource/list RPC (no new protocol surface).
 */
// Raw k8s list items: name is at metadata.name, phase at status.phase.
interface Item {
  name?: string;
  metadata?: { name?: string };
  status?: {
    phase?: string;
    containerStatuses?: Array<{ restartCount?: number }>;
  };
}

const asItems = (v: unknown): Item[] => (Array.isArray(v) ? (v as Item[]) : []);
const nameOf = (i: Item): string => i.metadata?.name ?? i.name ?? "";

interface OverviewData {
  nodes: Item[];
  pods: Item[];
  deployments: number;
  services: number;
  namespaces: number;
  events: number;
}

interface PodStats {
  running: number;
  pending: number;
  failed: number;
  other: number;
  restarts: number;
  total: number;
}

function computePodStats(pods: Item[]): PodStats {
  let running = 0;
  let pending = 0;
  let failed = 0;
  let other = 0;
  let restarts = 0;
  for (const p of pods) {
    const ph = (p.status?.phase ?? "").toLowerCase();
    restarts += (p.status?.containerStatuses ?? []).reduce((s, c) => s + (c.restartCount ?? 0), 0);
    if (ph === "running" || ph === "succeeded") running += 1;
    else if (ph === "pending") pending += 1;
    else if (ph === "failed" || ph.includes("crash") || ph.includes("error")) failed += 1;
    else other += 1;
  }
  return { running, pending, failed, other, restarts, total: pods.length };
}

export function ClusterOverviewDashboard({
  serverId,
  clusterId,
  clusterName,
}: {
  serverId: string;
  clusterId: string;
  clusterName?: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<OverviewData | null>(null);
  const [resolvedName, setResolvedName] = useState<string | undefined>(clusterName);
  // Reload when the screen (re)connects the cluster, so the Overview isn't left
  // empty after an auto-connect following a daemon restart / direct open.
  const listRefreshKey = useClusterViewStore((s) => s.listRefreshKey);

  useEffect(() => {
    if (clusterName || !client) return;
    let cancelled = false;
    void client
      .clusterList()
      .then((r) => {
        if (cancelled) return undefined;
        const c = (r.clusters ?? []).find((x) => x.id === clusterId);
        if (c) setResolvedName(c.displayName ?? c.contextName ?? clusterId);
        return undefined;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, clusterId, clusterName]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const listOf = async (kind: string): Promise<Item[]> => {
      try {
        const r = await client.clusterResourceList({ id: clusterId, kind });
        return r.error ? [] : asItems(r.items);
      } catch {
        return [];
      }
    };
    void (async () => {
      try {
        const [nodes, pods, deps, svcs, nss, events] = await Promise.all([
          listOf("Node"),
          listOf("Pod"),
          listOf("Deployment"),
          listOf("Service"),
          listOf("Namespace"),
          listOf("Event"),
        ]);
        if (cancelled) return;
        setData({
          nodes,
          pods,
          deployments: deps.length,
          services: svcs.length,
          namespaces: nss.length,
          events: events.length,
        });
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load overview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, clusterId, listRefreshKey]);

  const podStats = useMemo(() => computePodStats(data?.pods ?? []), [data]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Text style={styles.muted}>Loading cluster overview…</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.title}>{resolvedName ?? "Cluster"}</Text>
        <Text style={styles.subtitle}>Cluster overview</Text>
      </View>

      <View style={styles.kpiGrid}>
        <Kpi label="Nodes" value={data?.nodes.length ?? 0} />
        <Kpi label="Pods" value={podStats.total} sub={`${podStats.running} running`} />
        <Kpi label="Deployments" value={data?.deployments ?? 0} />
        <Kpi label="Services" value={data?.services ?? 0} />
        <Kpi label="Namespaces" value={data?.namespaces ?? 0} />
        <Kpi
          label="Restarts"
          value={podStats.restarts}
          tone={podStats.restarts > 0 ? "warn" : "default"}
        />
      </View>

      <PodHealthBar podStats={podStats} />

      {data && data.nodes.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Nodes</Text>
          <View style={styles.list}>
            {data.nodes.map((n) => (
              <View key={nameOf(n)} style={styles.listRow}>
                <View style={styles.dotRun} />
                <Text style={styles.listName} numberOfLines={1}>
                  {nameOf(n)}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}

function PodHealthBar({ podStats }: { podStats: PodStats }) {
  const total = podStats.total || 1;
  const seg = (n: number) => `${(n / total) * 100}%` as const;
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Pod health</Text>
      <View style={styles.bar}>
        {podStats.running > 0 ? (
          <View style={[styles.barRun, { width: seg(podStats.running) }]} />
        ) : null}
        {podStats.pending > 0 ? (
          <View style={[styles.barPend, { width: seg(podStats.pending) }]} />
        ) : null}
        {podStats.failed > 0 ? (
          <View style={[styles.barFail, { width: seg(podStats.failed) }]} />
        ) : null}
        {podStats.other > 0 ? (
          <View style={[styles.barOther, { width: seg(podStats.other) }]} />
        ) : null}
      </View>
      <View style={styles.legend}>
        <Legend color={styles.dotRun} label="Running" n={podStats.running} />
        <Legend color={styles.dotPend} label="Pending" n={podStats.pending} />
        <Legend color={styles.dotFail} label="Failed" n={podStats.failed} />
        {podStats.other > 0 ? (
          <Legend color={styles.dotOther} label="Other" n={podStats.other} />
        ) : null}
      </View>
    </View>
  );
}

function Kpi({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: number;
  sub?: string;
  tone?: "default" | "warn";
}) {
  return (
    <View style={styles.kpi}>
      <Text style={tone === "warn" ? styles.kpiValueWarn : styles.kpiValue}>{value}</Text>
      <Text style={styles.kpiLabel}>{label}</Text>
      {sub ? <Text style={styles.kpiSub}>{sub}</Text> : null}
    </View>
  );
}

function Legend({ color, label, n }: { color: StyleProp<ViewStyle>; label: string; n: number }) {
  return (
    <View style={styles.legendItem}>
      <View style={color} />
      <Text style={styles.legendText}>
        {label} {n}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  content: { padding: theme.spacing[4], gap: theme.spacing[4] },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: theme.spacing[6] },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[500], fontSize: theme.fontSize.sm },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  subtitle: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  kpiGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  kpi: {
    minWidth: 120,
    flexGrow: 1,
    flexBasis: 120,
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  kpiValue: {
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  kpiValueWarn: {
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.palette.amber[500],
  },
  kpiLabel: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  kpiSub: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundExtraMuted },
  section: { gap: theme.spacing[2] },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundExtraMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  bar: {
    flexDirection: "row",
    height: 10,
    borderRadius: 5,
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
  },
  barRun: { backgroundColor: theme.colors.palette.green[500] },
  barPend: { backgroundColor: theme.colors.palette.amber[500] },
  barFail: { backgroundColor: theme.colors.palette.red[500] },
  barOther: { backgroundColor: theme.colors.foregroundExtraMuted },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  legendItem: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  legendText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  dotRun: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.palette.green[500],
  },
  dotPend: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.palette.amber[500],
  },
  dotFail: { width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.palette.red[500] },
  dotOther: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  list: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  listName: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
}));
