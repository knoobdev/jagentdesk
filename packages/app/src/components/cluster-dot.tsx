import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ClusterInfo } from "@jagentdesk/protocol/cluster/rpc-schemas";

function podBucket(
  phase: string,
  statusReason?: string,
): "bad" | "pending" | "running" | "unknown" {
  if (statusReason === "CrashLoopBackOff" || statusReason === "Error" || phase === "Failed")
    return "bad";
  if (phase === "Pending") return "pending";
  if (phase === "Running") return "running";
  return "unknown";
}

export function ClusterStatusDot({ state }: { state: ClusterInfo["state"] }) {
  styles.useVariants({ clusterState: state });
  return <View style={styles.dot} />;
}
export function PodStatusDot({ phase, statusReason }: { phase: string; statusReason?: string }) {
  styles.useVariants({ pod: podBucket(phase, statusReason) });
  return <View style={styles.dot} />;
}
export function ContextStatusDot({ current }: { current: boolean }) {
  styles.useVariants({ current: current ? "yes" : "no" });
  return <View style={styles.dot} />;
}

const styles = StyleSheet.create((theme) => ({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    flexShrink: 0,
    backgroundColor: theme.colors.border,
    variants: {
      clusterState: {
        connected: { backgroundColor: theme.colors.palette.green[400] },
        connecting: { backgroundColor: theme.colors.palette.amber[500] },
        error: { backgroundColor: theme.colors.palette.red[500] },
        saved: { backgroundColor: theme.colors.border },
      },
      pod: {
        bad: { backgroundColor: theme.colors.palette.red[500] },
        pending: { backgroundColor: theme.colors.palette.amber[500] },
        running: { backgroundColor: theme.colors.palette.green[400] },
        unknown: { backgroundColor: theme.colors.foregroundMuted },
      },
      current: {
        yes: { backgroundColor: theme.colors.palette.green[400] },
        no: { backgroundColor: theme.colors.border },
      },
    },
  },
}));
