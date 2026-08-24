import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === "object" ? (v as Obj) : {});
const str = (v: unknown): string =>
  v === null || v === undefined || typeof v === "object" ? "" : String(v);

function age(ts: string): string {
  if (!ts) return "";
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "just now";
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ago`;
  if (h >= 1) return `${h}h ago`;
  return `${min}m ago`;
}

interface EventRow {
  key: string;
  type: string;
  reason: string;
  message: string;
  count: string;
  age: string;
}

/**
 * The Events section of a resource detail — the same "what just happened to this
 * object" feed Lens shows in its detail drawer. Fetched via the generic resource
 * list (kind "Event") and filtered to this object's involvedObject; renders
 * nothing when events are unavailable or empty so it never adds visual noise.
 */
export function ClusterResourceEvents({
  serverId,
  clusterId,
  namespace,
  name,
  kind,
}: {
  serverId: string;
  clusterId: string;
  namespace?: string;
  name: string;
  kind: string;
}) {
  const client = useHostRuntimeClient(serverId);
  const [events, setEvents] = useState<EventRow[] | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client
      .clusterResourceList({ id: clusterId, kind: "Event", ...(namespace ? { namespace } : {}) })
      .then((res) => {
        if (cancelled) return undefined;
        const items = ((res as { items?: Obj[] }).items ?? []) as Obj[];
        const rows = items
          .filter((e) => {
            const io = asObj(e.involvedObject);
            return str(io.name) === name && str(io.kind) === kind;
          })
          .map((e) => ({
            reason: str(e.reason),
            type: str(e.type),
            message: str(e.message),
            count: str(e.count),
            lastTs:
              str(e.lastTimestamp) || str(e.eventTime) || str(asObj(e.metadata).creationTimestamp),
          }))
          .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
          .slice(0, 25)
          .map((e, i) => ({
            key: `${e.reason}-${i}`,
            type: e.type,
            reason: e.reason,
            message: e.message,
            count: e.count,
            age: age(e.lastTs),
          }));
        setEvents(rows);
        return undefined;
      })
      .catch(() => {
        if (!cancelled) setEvents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, clusterId, namespace, name, kind]);

  if (!events || events.length === 0) return null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>Events</Text>
      {events.map((e) => (
        <View key={e.key} style={styles.row}>
          <View style={styles.badge}>
            <Text
              style={[styles.badgeText, e.type === "Warning" ? styles.warnText : styles.normalText]}
              numberOfLines={1}
            >
              {e.reason || e.type || "Event"}
            </Text>
          </View>
          <Text style={styles.message} numberOfLines={2}>
            {e.message}
          </Text>
          <Text style={styles.age} numberOfLines={1}>
            {e.count && e.count !== "1" ? `×${e.count} · ` : ""}
            {e.age}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  section: { gap: theme.spacing[2], paddingTop: theme.spacing[2] },
  sectionTitle: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundExtraMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  badge: {
    flexShrink: 0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  badgeText: { fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.medium },
  normalText: { color: theme.colors.foregroundMuted },
  warnText: { color: theme.colors.palette.amber[500] },
  message: { flex: 1, minWidth: 0, fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  age: {
    flexShrink: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
