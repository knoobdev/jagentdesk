import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import type { Theme } from "@/styles/theme";

// ── Types ──

interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
}

interface HelmRevision {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
  description: string;
}

// ── Helpers ──

function formatAge(updated: string): string {
  const created = new Date(updated).getTime();
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

function formatDate(updated: string): string {
  try {
    const d = new Date(updated);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return updated;
  }
}

/** Check if the error message indicates helm CLI is missing. */
function isHelmNotInstalledError(error: string): boolean {
  const lower = error.toLowerCase();
  return (
    lower.includes("helm not found") ||
    lower.includes("helm cli not installed") ||
    lower.includes("helm is not installed") ||
    lower.includes("executable file not found") ||
    lower.includes("no such file or directory") ||
    lower.includes("command not found")
  );
}

// ── Props ──

interface ClusterHelmViewProps {
  serverId: string;
  clusterId: string;
}

// ── Main Component ──

export function ClusterHelmView({ serverId, clusterId }: ClusterHelmViewProps) {
  const client = useHostRuntimeClient(serverId);
  const [releases, setReleases] = useState<HelmRelease[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRelease, setSelectedRelease] = useState<HelmRelease | null>(null);

  const loadReleases = useCallback(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void client
      .clusterHelmList({ id: clusterId })
      .then((res) => {
        if (res.error) {
          setError(res.error);
          setReleases([]);
        } else {
          setReleases(res.releases as HelmRelease[]);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load Helm releases");
        setReleases([]);
      })
      .finally(() => setLoading(false));
  }, [client, clusterId]);

  useEffect(() => {
    loadReleases();
  }, [loadReleases]);

  const handleSelectRelease = useCallback((release: HelmRelease) => {
    setSelectedRelease(release);
  }, []);

  const handleDetailClose = useCallback(() => {
    setSelectedRelease(null);
  }, []);

  const handleDetailChanged = useCallback(() => {
    loadReleases();
  }, [loadReleases]);

  const releaseKeyExtractor = useCallback(
    (item: HelmRelease, idx: number) => `${item.namespace}/${item.name}/${idx}`,
    [],
  );

  const renderReleaseItem = useCallback(
    ({ item }: { item: HelmRelease }) => (
      <HelmReleaseRow release={item} onSelectRelease={handleSelectRelease} />
    ),
    [handleSelectRelease],
  );

  // ── Loading state ──
  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.loadingText}>Loading Helm releases...</Text>
      </View>
    );
  }

  // ── Error state (helm not installed) ──
  if (error && isHelmNotInstalledError(error)) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.helmNotInstalledTitle}>Helm CLI not installed</Text>
        <Text style={styles.helmNotInstalledBody}>
          Install Helm on the daemon host to browse releases.
        </Text>
        <Text style={styles.helmNotInstalledCode} selectable>
          curl -fsSL -o get_helm.sh
          https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm.sh
          {"\n"}chmod 700 get_helm.sh
          {"\n"}./get_helm.sh
        </Text>
      </View>
    );
  }

  // ── Error state (generic) ──
  if (error) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  // ── Empty state ──
  if (releases.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.emptyText}>No Helm releases found.</Text>
      </View>
    );
  }

  // ── Content ──
  return (
    <View style={styles.container}>
      <View style={styles.tableHeader}>
        <Text style={styles.tableHeaderName}>NAME</Text>
        <Text style={styles.tableHeaderNamespace}>NAMESPACE</Text>
        <Text style={styles.tableHeaderChart}>CHART</Text>
        <Text style={styles.tableHeaderRev}>REV</Text>
        <Text style={styles.tableHeaderStatus}>STATUS</Text>
        <Text style={styles.tableHeaderUpdated}>UPDATED</Text>
      </View>
      <FlatList
        data={releases}
        keyExtractor={releaseKeyExtractor}
        renderItem={renderReleaseItem}
        scrollEnabled={false}
      />

      {selectedRelease ? (
        <ClusterHelmDetail
          serverId={serverId}
          clusterId={clusterId}
          release={selectedRelease}
          onClose={handleDetailClose}
          onChanged={handleDetailChanged}
        />
      ) : null}
    </View>
  );
}

// ── Release Row ──

interface HelmReleaseRowProps {
  release: HelmRelease;
  onSelectRelease: (release: HelmRelease) => void;
}

const HelmReleaseRow = React.memo(function HelmReleaseRow({
  release,
  onSelectRelease,
}: HelmReleaseRowProps) {
  const handlePress = useCallback(() => onSelectRelease(release), [onSelectRelease, release]);

  return (
    <Pressable style={styles.releaseRow} onPress={handlePress}>
      <Text style={styles.releaseName} numberOfLines={1}>
        {release.name}
      </Text>
      <Text style={styles.releaseNamespace} numberOfLines={1}>
        {release.namespace}
      </Text>
      <Text style={styles.releaseChart} numberOfLines={1}>
        {release.chart}
      </Text>
      <Text style={styles.releaseRev}>{release.revision}</Text>
      <Text style={styles.releaseStatus} numberOfLines={1}>
        {release.status}
      </Text>
      <Text style={styles.releaseUpdated}>{formatAge(release.updated)}</Text>
    </Pressable>
  );
});

// ── Detail Modal ──

type HelmDetailTab = "values" | "history";

interface ClusterHelmDetailProps {
  serverId: string;
  clusterId: string;
  release: HelmRelease;
  onClose: () => void;
  onChanged: () => void;
}

function ClusterHelmDetail({
  serverId,
  clusterId,
  release,
  onClose,
  onChanged,
}: ClusterHelmDetailProps) {
  const client = useHostRuntimeClient(serverId);
  const [tab, setTab] = useState<HelmDetailTab>("values");

  // Uninstall
  const [uninstallConfirm, setUninstallConfirm] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallError, setUninstallError] = useState<string | null>(null);

  const handleUninstall = useCallback(() => {
    if (!uninstallConfirm) {
      setUninstallConfirm(true);
      return;
    }
    if (!client) return;
    setUninstalling(true);
    setUninstallError(null);
    void client
      .clusterHelmUninstall({
        id: clusterId,
        namespace: release.namespace,
        name: release.name,
      })
      .then((res) => {
        if (res.error) {
          setUninstallError(res.error);
        } else if (res.result?.ok) {
          onChanged();
          onClose();
        } else {
          setUninstallError(res.result?.message ?? "Uninstall failed");
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setUninstallError(e instanceof Error ? e.message : "Uninstall failed");
      })
      .finally(() => {
        setUninstalling(false);
        setUninstallConfirm(false);
      });
  }, [uninstallConfirm, client, clusterId, release, onChanged, onClose]);

  const header = useMemo(
    () => ({
      title: release.name,
      subtitle: `Helm · ${release.namespace}`,
    }),
    [release],
  );

  const uninstallLabel = useMemo(() => {
    if (uninstalling) return "Uninstalling...";
    if (uninstallConfirm) return "Confirm uninstall?";
    return "Uninstall";
  }, [uninstalling, uninstallConfirm]);

  const handleTabValues = useCallback(() => setTab("values"), []);
  const handleTabHistory = useCallback(() => setTab("history"), []);

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} scrollable={false}>
      <View style={styles.tabBar}>
        <Pressable
          style={[styles.tabItem, tab === "values" && styles.tabItemActive]}
          onPress={handleTabValues}
        >
          <Text style={[styles.tabItemText, tab === "values" && styles.tabItemTextActive]}>
            Values
          </Text>
        </Pressable>
        <Pressable
          style={[styles.tabItem, tab === "history" && styles.tabItemActive]}
          onPress={handleTabHistory}
        >
          <Text style={[styles.tabItemText, tab === "history" && styles.tabItemTextActive]}>
            History
          </Text>
        </Pressable>
      </View>

      {tab === "values" ? (
        <HelmValuesContent
          client={client}
          clusterId={clusterId}
          namespace={release.namespace}
          name={release.name}
        />
      ) : (
        <HelmHistoryContent
          client={client}
          clusterId={clusterId}
          namespace={release.namespace}
          name={release.name}
        />
      )}

      {uninstallError ? (
        <View style={styles.messageBar}>
          <Text style={styles.messageText}>{uninstallError}</Text>
        </View>
      ) : null}

      <Pressable
        style={[styles.uninstallButton, uninstallConfirm && styles.uninstallButtonConfirm]}
        onPress={handleUninstall}
        disabled={uninstalling}
      >
        <Text
          style={[
            styles.uninstallButtonText,
            uninstallConfirm && styles.uninstallButtonTextConfirm,
          ]}
        >
          {uninstallLabel}
        </Text>
      </Pressable>
    </AdaptiveModalSheet>
  );
}

// ── Values Tab ──

interface HelmValuesContentProps {
  client: ReturnType<typeof useHostRuntimeClient>;
  clusterId: string;
  namespace: string;
  name: string;
}

function HelmValuesContent({ client, clusterId, namespace, name }: HelmValuesContentProps) {
  const [values, setValues] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!client) {
      setLoading(false);
      setError("No client connection");
      return;
    }
    setLoading(true);
    setError(null);
    setValues(null);
    void client
      .clusterHelmValues({ id: clusterId, namespace, name })
      .then((res) => {
        if (res.error) {
          setError(res.error);
        } else {
          setValues(res.values);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load values");
      })
      .finally(() => setLoading(false));
  }, [client, clusterId, namespace, name]);

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.loadingText}>Loading values...</Text>
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
  if (values === null || values === "") {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.emptyText}>No values</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.valuesScroll} nestedScrollEnabled>
      <Text style={styles.valuesText} selectable>
        {values}
      </Text>
    </ScrollView>
  );
}

function getRollbackLabel(rollingBack: boolean, isConfirming: boolean, isCurrent: boolean): string {
  if (rollingBack && isCurrent) return "Rolling back...";
  if (isConfirming) return "Confirm?";
  return "Rollback";
}

// ── Revision Row ──

interface HelmRevisionRowProps {
  revision: HelmRevision;
  rollbackRev: number | null;
  rollingBack: boolean;
  onRollback: (revision: number) => void;
}

function HelmRevisionRow({ revision, rollbackRev, rollingBack, onRollback }: HelmRevisionRowProps) {
  const isConfirming = rollbackRev === revision.revision && !rollingBack;
  const label = getRollbackLabel(rollingBack, isConfirming, rollbackRev === revision.revision);
  const handlePress = useCallback(
    () => onRollback(revision.revision),
    [onRollback, revision.revision],
  );

  return (
    <View style={styles.historyRow}>
      <Text style={styles.historyRev}>{revision.revision}</Text>
      <Text style={styles.historyStatus} numberOfLines={1}>
        {revision.status}
      </Text>
      <Text style={styles.historyUpdated} numberOfLines={1}>
        {formatDate(revision.updated)}
      </Text>
      <Pressable
        style={[styles.rollbackButton, isConfirming && styles.rollbackButtonConfirm]}
        onPress={handlePress}
        disabled={rollingBack}
      >
        <Text style={[styles.rollbackButtonText, isConfirming && styles.rollbackButtonTextConfirm]}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

// ── History Tab ──

interface HelmHistoryContentProps {
  client: ReturnType<typeof useHostRuntimeClient>;
  clusterId: string;
  namespace: string;
  name: string;
}

function HelmHistoryContent({ client, clusterId, namespace, name }: HelmHistoryContentProps) {
  const [revisions, setRevisions] = useState<HelmRevision[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rollbackRev, setRollbackRev] = useState<number | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadHistory = useCallback(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void client
      .clusterHelmHistory({ id: clusterId, namespace, name })
      .then((res) => {
        if (res.error) {
          setError(res.error);
          setRevisions([]);
        } else {
          setRevisions(res.revisions as HelmRevision[]);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load history");
        setRevisions([]);
      })
      .finally(() => setLoading(false));
  }, [client, clusterId, namespace, name]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory, refreshKey]);

  const handleRollback = useCallback(
    (revision: number) => {
      if (rollbackRev !== revision) {
        setRollbackRev(revision);
        setRollbackError(null);
        return;
      }
      if (!client) return;
      setRollingBack(true);
      setRollbackError(null);
      void client
        .clusterHelmRollback({ id: clusterId, namespace, name, revision })
        .then((res) => {
          if (res.error) {
            setRollbackError(res.error);
          } else if (res.result?.ok) {
            setRollbackRev(null);
            setRefreshKey((k) => k + 1);
          } else {
            setRollbackError(res.result?.message ?? "Rollback failed");
          }
          return undefined;
        })
        .catch((e: unknown) => {
          setRollbackError(e instanceof Error ? e.message : "Rollback failed");
        })
        .finally(() => setRollingBack(false));
    },
    [rollbackRev, client, clusterId, namespace, name],
  );

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.loadingText}>Loading history...</Text>
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
  if (revisions.length === 0) {
    return (
      <View style={styles.centerContainer}>
        <Text style={styles.emptyText}>No history available.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.historyScroll} nestedScrollEnabled>
      {rollbackError ? (
        <View style={styles.messageBar}>
          <Text style={styles.messageText}>{rollbackError}</Text>
        </View>
      ) : null}
      <View style={styles.historyTable}>
        <View style={styles.historyHeader}>
          <Text style={styles.historyHeaderRev}>REV</Text>
          <Text style={styles.historyHeaderStatus}>STATUS</Text>
          <Text style={styles.historyHeaderUpdated}>UPDATED</Text>
          <View style={styles.historyHeaderAction} />
        </View>
        {revisions.map((rev) => (
          <HelmRevisionRow
            key={rev.revision}
            revision={rev}
            rollbackRev={rollbackRev}
            rollingBack={rollingBack}
            onRollback={handleRollback}
          />
        ))}
      </View>
    </ScrollView>
  );
}

// ── Styles ──

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 120,
    paddingHorizontal: theme.spacing[4],
  },
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
  // ── Helm CLI not installed ──
  helmNotInstalledTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
  helmNotInstalledBody: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[3],
    textAlign: "center",
  },
  helmNotInstalledCode: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    lineHeight: 20,
    maxWidth: "100%",
  },
  // ── Table header ──
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
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableHeaderNamespace: {
    width: 120,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableHeaderChart: {
    width: 120,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableHeaderRev: {
    width: 40,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    textAlign: "right",
  },
  tableHeaderStatus: {
    width: 80,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  tableHeaderUpdated: {
    width: 60,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    textAlign: "right",
  },
  // ── Release row ──
  releaseRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  releaseName: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    minWidth: 0,
  },
  releaseNamespace: {
    width: 120,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  releaseChart: {
    width: 120,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  releaseRev: {
    width: 40,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
  },
  releaseStatus: {
    width: 80,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  releaseUpdated: {
    width: 60,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    textAlign: "right",
  },
  // ── Tab bar ──
  tabBar: {
    flexDirection: "row",
    gap: theme.spacing[1],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    marginBottom: theme.spacing[3],
  },
  tabItem: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  tabItemActive: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.foregroundMuted,
  },
  tabItemText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  tabItemTextActive: {
    color: theme.colors.foreground,
  },
  // ── Values ──
  valuesScroll: {
    maxHeight: 300,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    marginBottom: theme.spacing[3],
  },
  valuesText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    lineHeight: 20,
  },
  // ── History ──
  historyScroll: {
    maxHeight: 300,
    marginBottom: theme.spacing[3],
  },
  historyTable: {
    gap: 0,
  },
  historyHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  historyHeaderRev: {
    width: 40,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  historyHeaderStatus: {
    width: 80,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  historyHeaderUpdated: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  historyHeaderAction: {
    width: 80,
  },
  historyRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  historyRev: {
    width: 40,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  historyStatus: {
    width: 80,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  historyUpdated: {
    flex: 1,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  rollbackButton: {
    width: 80,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
  },
  rollbackButtonConfirm: {
    backgroundColor: theme.colors.palette.amber[500],
    borderColor: theme.colors.palette.amber[500],
  },
  rollbackButtonText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  rollbackButtonTextConfirm: {
    color: "#ffffff",
  },
  // ── Uninstall ──
  uninstallButton: {
    alignSelf: "flex-end",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.destructive,
  },
  uninstallButtonConfirm: {
    backgroundColor: theme.colors.palette.red[500],
  },
  uninstallButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.destructiveForeground,
  },
  uninstallButtonTextConfirm: {
    color: "#ffffff",
  },
  // ── Message bar ──
  messageBar: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    marginBottom: theme.spacing[2],
  },
  messageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
