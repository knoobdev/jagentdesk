import { useCallback, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

interface ClusterNodeOpsProps {
  client: {
    clusterNodeOp: (options: {
      id: string;
      name: string;
      op: "cordon" | "uncordon";
    }) => Promise<{ result: { ok: boolean; message: string } | null; error: string | null }>;
  };
  clusterId: string;
  name: string;
  onChanged?: () => void;
}

export function ClusterNodeOps({ client, clusterId, name, onChanged }: ClusterNodeOpsProps) {
  const [operating, setOperating] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const doOp = useCallback(
    (op: "cordon" | "uncordon") => {
      setOperating(op);
      setMessage(null);
      void client
        .clusterNodeOp({ id: clusterId, name, op })
        .then((res) => {
          if (res.error) {
            setMessage(res.error);
          } else {
            setMessage(res.result?.message ?? `${op} done`);
            if (res.result?.ok) {
              onChanged?.();
            }
          }
          return undefined;
        })
        .catch((e: unknown) => {
          setMessage(e instanceof Error ? e.message : `${op} failed`);
        })
        .finally(() => setOperating(null));
    },
    [client, clusterId, name, onChanged],
  );

  const handleCordon = useCallback(() => doOp("cordon"), [doOp]);
  const handleUncordon = useCallback(() => doOp("uncordon"), [doOp]);

  return (
    <View style={styles.container}>
      <Pressable style={styles.actionButton} onPress={handleCordon} disabled={operating !== null}>
        <Text style={styles.actionButtonText}>
          {operating === "cordon" ? "Cordoning..." : "Cordon"}
        </Text>
      </Pressable>
      <Pressable style={styles.actionButton} onPress={handleUncordon} disabled={operating !== null}>
        <Text style={styles.actionButtonText}>
          {operating === "uncordon" ? "Uncordoning..." : "Uncordon"}
        </Text>
      </Pressable>
      {message ? (
        <View style={styles.messageBar}>
          <Text style={styles.messageText}>{message}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  actionButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  messageBar: {
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  messageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
