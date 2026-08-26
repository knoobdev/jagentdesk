import { useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { PodStatusDot } from "@/components/cluster-dot";
import { ClusterResourceEvents } from "@/components/cluster-resource-events";
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

/** "N lines" summary shown beside a ConfigMap data key. */
function dataMeta(v: string): string {
  const lines = v ? v.split("\n").length : 0;
  return `${lines} line${lines === 1 ? "" : "s"}`;
}

interface Row {
  label: string;
  value: string;
}

// Kind-specific rows. Each helper receives a `push(label, value)` that skips
// empty values, plus the parsed spec/status/metadata objects. Kept small per
// kind so the whole thing stays well under the complexity limit.
type Push = (label: string, value: unknown) => void;

const KIND_ROWS: Record<string, (p: Push, spec: Obj, status: Obj, md: Obj, data?: Obj) => void> = {
  Pod: (p, spec, status) => {
    p("Status", status.phase);
    p("Node", spec.nodeName);
    p("Pod IP", status.podIP);
    p("Host IP", status.hostIP);
    p("QoS Class", status.qosClass);
    p("Service Account", spec.serviceAccountName);
  },
  Deployment: (p, spec, status) => {
    const desired = str(spec.replicas) ?? "0";
    const ready = str(status.readyReplicas) ?? "0";
    p("Replicas", `${ready}/${desired} ready`);
    p("Available", status.availableReplicas);
    p("Updated", status.updatedReplicas);
    p("Strategy", asObj(spec.strategy).type);
  },
  DaemonSet: (p, _spec, status) => {
    p("Desired", status.desiredNumberScheduled);
    p("Current", status.currentNumberScheduled);
    p("Ready", status.numberReady);
    p("Available", status.numberAvailable);
    p("Up-to-date", status.updatedNumberScheduled);
  },
  Service: (p, spec, status) => {
    p("Type", spec.type);
    p("Cluster IP", spec.clusterIP);
    p("External IP", str(asObj(asObj(status.loadBalancer)).ingress) ?? spec.externalName);
    p("Selector", entriesToStr(asObj(spec.selector)));
    const ports = asArr(spec.ports)
      .map((port) => {
        const node = str(port.nodePort);
        return `${str(port.port) ?? "?"}/${str(port.protocol) ?? "TCP"}${node ? ` →${node}` : ""}`;
      })
      .join(", ");
    if (ports) p("Ports", ports);
  },
  Ingress: (p, spec) => {
    p("Class", spec.ingressClassName);
    const hosts = asArr(spec.rules)
      .map((r) => str(r.host))
      .filter(Boolean)
      .join(", ");
    if (hosts) p("Hosts", hosts);
  },
  Node: (p, _spec, status) => {
    const info = asObj(status.nodeInfo);
    p("OS", info.operatingSystem);
    p("Architecture", info.architecture);
    p("Kernel", info.kernelVersion);
    p("Kubelet", info.kubeletVersion);
    p("Container Runtime", info.containerRuntimeVersion);
    const cap = asObj(status.capacity);
    p("CPU", cap.cpu);
    p("Memory", cap.memory);
    p("Pods", cap.pods);
  },
  Job: (p, spec, status) => {
    p("Completions", spec.completions);
    p("Parallelism", spec.parallelism);
    p("Active", asArr(status.active).length || status.active);
    p("Succeeded", status.succeeded);
    p("Failed", status.failed);
  },
  CronJob: (p, spec, status) => {
    p("Schedule", spec.schedule);
    p("Suspend", spec.suspend);
    p("Active", asArr(status.active).length || undefined);
    p("Last Schedule", str(status.lastScheduleTime));
  },
  // ConfigMap keys/values are rendered as a dedicated Data table below, not as
  // a single joined summary row.
  ConfigMap: () => {},
  Secret: (p, spec, _status, _md, data) => {
    p("Type", spec.type);
    p("Keys", str(Object.keys(asObj(data)).length));
  },
  PersistentVolumeClaim: (p, spec, status) => {
    p("Status", status.phase);
    p("Volume", spec.volumeName);
    p("Capacity", asObj(status.capacity).storage ?? asObj(asObj(spec.resources).requests).storage);
    p("Access Modes", asArr(spec.accessModes).join(", ") || spec.accessModes);
    p("Storage Class", spec.storageClassName);
  },
  PersistentVolume: (p, spec, status) => {
    p("Status", status.phase);
    p("Capacity", asObj(spec.capacity).storage);
    p("Access Modes", asArr(spec.accessModes).join(", ") || spec.accessModes);
    p("Reclaim Policy", spec.persistentVolumeReclaimPolicy);
    p("Storage Class", spec.storageClassName);
  },
  Namespace: (p, _spec, status) => p("Status", asObj(status).phase),
  ServiceAccount: (p, _spec, _status, md) =>
    p("Secrets", asArr(md.secrets ?? []).length || undefined),
  HorizontalPodAutoscaler: (p, spec, status) => {
    p("Target", `${str(asObj(spec.scaleTargetRef).kind)}/${str(asObj(spec.scaleTargetRef).name)}`);
    p("Min Replicas", spec.minReplicas);
    p("Max Replicas", spec.maxReplicas);
    p("Current Replicas", status.currentReplicas);
    p("Desired Replicas", status.desiredReplicas);
  },
};
KIND_ROWS.StatefulSet = KIND_ROWS.Deployment;
KIND_ROWS.ReplicaSet = KIND_ROWS.Deployment;
KIND_ROWS.ReplicationController = KIND_ROWS.Deployment;

function entriesToStr(obj: Obj): string {
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${str(v) ?? ""}`)
    .join(", ");
}

function buildRows(kind: string, spec: Obj, status: Obj, md: Obj, data?: Obj): Row[] {
  const rows: Row[] = [];
  const push: Push = (label, value) => {
    const v = str(value);
    if (v) rows.push({ label, value: v });
  };
  push("Namespace", md.namespace);
  const createdAge = age(md.creationTimestamp);
  if (createdAge) rows.push({ label: "Created", value: `${createdAge} ago` });
  KIND_ROWS[kind]?.(push, spec, status, md, data);
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

export function ClusterResourceOverview({
  obj,
  kind,
  eventsServerId,
  eventsClusterId,
  eventsNamespace,
  eventsName,
}: {
  obj: Obj;
  kind: string;
  eventsServerId?: string;
  eventsClusterId?: string;
  eventsNamespace?: string;
  eventsName?: string;
}) {
  const { rows, labels, annotations, containers, conditions, dataEntries } = useMemo(() => {
    const md = asObj(obj.metadata);
    const spec = asObj(obj.spec);
    const status = asObj(obj.status);
    const cs = asArr(status.containerStatuses);
    const statusByName = new Map(cs.map((c) => [str(c.name) ?? "", c]));
    return {
      rows: buildRows(kind, spec, status, md, asObj(obj.data)),
      dataEntries:
        kind === "ConfigMap" || kind === "Secret"
          ? Object.entries(asObj(obj.data)).map(([k, v]) => [k, str(v) ?? ""] as [string, string])
          : [],
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

      {dataEntries.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Data</Text>
          {dataEntries.map(([k, v]) => (
            <View key={k} style={styles.dataEntry}>
              <View style={styles.dataEntryHead}>
                <Text style={styles.dataEntryKey} selectable numberOfLines={1}>
                  {k}
                </Text>
                {kind === "ConfigMap" ? (
                  <Text style={styles.dataEntryMeta}>{dataMeta(v)}</Text>
                ) : null}
              </View>
              {kind === "Secret" ? (
                <View style={styles.secretMasked}>
                  <Text style={styles.secretMaskedText}>•••••••••••• · use Reveal to view</Text>
                </View>
              ) : (
                <ScrollView style={styles.codeBlock} nestedScrollEnabled>
                  <ScrollView
                    horizontal
                    nestedScrollEnabled
                    contentContainerStyle={styles.codeBlockContent}
                    showsHorizontalScrollIndicator
                  >
                    <Text style={styles.codeText} selectable>
                      {v}
                    </Text>
                  </ScrollView>
                </ScrollView>
              )}
            </View>
          ))}
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

      {eventsServerId && eventsClusterId && eventsName ? (
        <ClusterResourceEvents
          serverId={eventsServerId}
          clusterId={eventsClusterId}
          namespace={eventsNamespace}
          name={eventsName}
          kind={kind}
        />
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
  dataEntry: { gap: theme.spacing[1] },
  dataEntryHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  dataEntryKey: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  dataEntryMeta: {
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
  codeBlock: {
    maxHeight: 360,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  codeBlockContent: { padding: theme.spacing[3] },
  codeText: {
    fontSize: theme.fontSize.code,
    lineHeight: 18,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  secretMasked: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  secretMaskedText: {
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
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
