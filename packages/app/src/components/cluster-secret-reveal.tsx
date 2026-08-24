import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

interface ClusterSecretRevealProps {
  client: {
    clusterRevealSecret: (options: {
      id: string;
      namespace: string;
      name: string;
    }) => Promise<{ data: Record<string, string> | null; error: string | null }>;
  };
  clusterId: string;
  namespace: string;
  name: string;
}

export function ClusterSecretReveal({
  client,
  clusterId,
  namespace,
  name,
}: ClusterSecretRevealProps) {
  const [revealed, setRevealed] = useState(false);
  const [data, setData] = useState<Record<string, string> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReveal = useCallback(() => {
    if (revealed) {
      setRevealed(false);
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    void client
      .clusterRevealSecret({ id: clusterId, namespace, name })
      .then((res) => {
        if (res.error) {
          setError(res.error);
          setData(null);
        } else {
          setData(res.data);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to reveal secret");
      })
      .finally(() => setLoading(false));
    setRevealed(true);
  }, [client, clusterId, namespace, name, revealed]);

  let buttonLabel: string;
  if (loading) {
    buttonLabel = "Revealing...";
  } else if (revealed) {
    buttonLabel = "Hide";
  } else {
    buttonLabel = "Reveal";
  }

  const revealedContent = useMemo(() => {
    if (!revealed || loading) return null;
    if (error) {
      return <Text style={styles.errorText}>{error}</Text>;
    }
    if (data) {
      return (
        <>
          <View style={styles.warningBar}>
            <Text style={styles.warningText}>Sensitive — revealed values</Text>
          </View>
          <ScrollView style={styles.dataScroll} nestedScrollEnabled>
            {Object.entries(data).map(([key, value]) => (
              <View key={key} style={styles.dataRow}>
                <Text style={styles.dataKey}>{key}:</Text>
                <Text style={styles.dataValue} selectable>
                  {value}
                </Text>
              </View>
            ))}
          </ScrollView>
        </>
      );
    }
    return <Text style={styles.emptyText}>No data</Text>;
  }, [revealed, loading, error, data]);

  return (
    <View>
      <Pressable style={styles.revealButton} onPress={handleReveal} disabled={loading}>
        <Text style={styles.revealButtonText}>{buttonLabel}</Text>
      </Pressable>

      {revealed && !loading ? <View style={styles.revealedArea}>{revealedContent}</View> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  revealButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  revealButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  revealedArea: {
    marginTop: theme.spacing[3],
    gap: theme.spacing[2],
    minHeight: 60,
  },
  warningBar: {
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.palette.amber[500],
    borderRadius: theme.borderRadius.md,
  },
  warningText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.palette.black,
  },
  dataScroll: {
    maxHeight: 240,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
  },
  dataRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  dataKey: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
    minWidth: 100,
  },
  dataValue: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    flexShrink: 1,
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
}));
