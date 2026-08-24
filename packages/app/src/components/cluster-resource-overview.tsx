import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PodStatusDot } from "@/components/cluster-dot";
import type { Theme } from "@/styles/theme";

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const asArr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as Obj[]) : []);
const str = (v: unknown): string | undefined =>
  v === null || v === undefined || typeof v === "object" ? undefined : String(v);

function age(creationTimestamp: unknown): string | undefined {
  const s = str(creationTimestamp);
  if (!s) return undefined;
  const created = new Date(s).getTime();
  if (Number.isNaN(created)) return undefined;
  const min = Math.floor((Date.now() - created) / 60000);
  if (min < 1) return "just now";
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d`;
  if (h >= 1) return `${h}h`;
  return `${min}m`;
}

interface Row {
  label: string;
  value: string;
}

function buildRows(kind: string, spec: Obj, status: Obj, md: Obj): Row[] {
  const rows: Row[] = [];
  const push = (label: string, value: unknown) => {
    const v = str(value);
    if (v) rows.push({ label, value: v });
  };
  push("Namespace", md.namespace);
  const createdAge = age(md.creationTimestamp);
  if (createdAge) rows.push({ label: "Created", value: `${createdAge} ago` });

  if (kind === "Pod") {
    push("Status", status.phase);
    push("Node", spec.nodeName);
    push("Pod IP", status.podIP);
    push("Host IP", status.hostIP);
    push("QoS Class", status.qosClass);
    push("Service Account", spec.serviceAccountName);
  } else if (kind === "Deployment" || kind === "StatefulSet" || kind === "ReplicaSet") {
    const desired = str(spec.replicas) ?? "0";
    const ready = str(status.readyReplicas) ?? "0";
    rows.push({ label: "Replicas", value: `${ready}/${desired} ready` });
    push("Available", status.availableReplicas);
    push("Updated", status.updatedReplicas);
    push("Strategy", asObj(spec.strategy).type);
  } else if (kind === "Service") {
    push("Type", spec.type);
    push("Cluster IP", spec.clusterIP);
    const ports = asArr(spec.ports)
      .map((p) => `${str(p.port) ?? "?"}/${str(p.protocol) ?? "TCP"}`)
      .join(", ");
    if (ports) rows.push({ label: "Ports", value: ports });
  } else if (kind === "Node") {
    const info = asObj(status.nodeInfo);
    push("OS", info.operatingSystem);
    push("Kernel", info.kernelVersion);
    push("Kubelet", info.kubeletVersion);
    push("Container Runtime", info.containerRuntimeVersion);
  } else if (kind === "Job" || kind === "CronJob") {
    push("Schedule", spec.schedule);
    push("Active", asArr(status.active).length || undefined);
    push("Succeeded", status.succeeded);
  }
  return rows;
}

function SummarySection({ rows }: { rows: Row[] }) {
  return (
    <View style={styles.grid}>
      {rows.map((r) => (
        <View key={r.label} style={styles.gridRow}>
          <Text style={styles.gridLabel}>{r.label}</Text>
          <Text style={styles.gridValue} numberOfLines={2}>
            {r.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ChipList({ entries }: { entries: [string, string][] }) {
  return (
    <View style={styles.chips}>
      {entries.map(([k, v]) => (
        <View key={k} style={styles.chip}>
          <Text style={styles.chipText} numberOfLines={1}>
            {k}
            {v ? `: ${v}` : ""}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function ClusterResourceOverview({ obj, kind }: { obj: Obj; kind: string }) {
  const { rows, labels, annotations, containers, conditions } = useMemo(() => {
    const md = asObj(obj.metadata);
    const spec = asObj(obj.spec);
    const status = asObj(obj.status);
    const cs = asArr(status.containerStatuses);
    const statusByName = new Map(cs.map((c) => [str(c.name) ?? "", c]));
    return {
      rows: buildRows(kind, spec, status, md),
      labels: Object.entries(asObj(md.labels)).map(
        ([k, v]) => [k, str(v) ?? ""] as [string, string],
      ),
      annotations: Object.entries(asObj(md.annotations)).map(
        ([k, v]) => [k, str(v) ?? ""] as [string, string],
      ),
      containers: asArr(spec.containers).map((c) => {
        const name = str(c.name) ?? "";
        const st = statusByName.get(name);
        return {
          name,
          image: str(c.image) ?? "",
          ready: st ? st.ready === true : undefined,
          restarts: st ? (str(st.restartCount) ?? "0") : undefined,
        };
      }),
      conditions: asArr(status.conditions).map((c) => ({
        type: str(c.type) ?? "",
        status: str(c.status) ?? "",
        reason: str(c.reason) ?? "",
      })),
    };
  }, [obj, kind]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} nestedScrollEnabled>
      {rows.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Details</Text>
          <SummarySection rows={rows} />
        </View>
      ) : null}

      {containers.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Containers</Text>
          {containers.map((c) => (
            <View key={c.name} style={styles.containerRow}>
              {c.ready === undefined ? null : (
                <PodStatusDot phase={c.ready ? "Running" : "Pending"} />
              )}
              <View style={styles.containerInfo}>
                <Text style={styles.containerName} numberOfLines={1}>
                  {c.name}
                </Text>
                <Text style={styles.containerImage} numberOfLines={1}>
                  {c.image}
                </Text>
              </View>
              {c.restarts !== undefined ? (
                <Text style={styles.containerMeta}>{c.restarts} restarts</Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {conditions.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Conditions</Text>
          {conditions.map((c) => (
            <View key={c.type} style={styles.condRow}>
              <Text style={styles.condType} numberOfLines={1}>
                {c.type}
              </Text>
              <Text style={c.status === "True" ? styles.condOk : styles.condBad}>{c.status}</Text>
              {c.reason ? (
                <Text style={styles.condReason} numberOfLines={1}>
                  {c.reason}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      {labels.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Labels</Text>
          <ChipList entries={labels} />
        </View>
      ) : null}

      {annotations.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Annotations</Text>
          <ChipList entries={annotations} />
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: { flex: 1, minHeight: 0 },
  content: { padding: theme.spacing[3], gap: theme.spacing[4] },
  section: { gap: theme.spacing[2] },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundExtraMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  grid: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  gridRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  gridLabel: {
    width: 140,
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  gridValue: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  containerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  containerInfo: { flex: 1, minWidth: 0 },
  containerName: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  containerImage: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  containerMeta: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  condRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  condType: {
    width: 160,
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  condOk: { fontSize: theme.fontSize.sm, color: theme.colors.palette.green[400] },
  condBad: { fontSize: theme.fontSize.sm, color: theme.colors.palette.amber[500] },
  condReason: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[1.5] },
  chip: {
    maxWidth: "100%",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  chipText: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
