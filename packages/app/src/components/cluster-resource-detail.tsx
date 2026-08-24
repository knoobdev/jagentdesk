import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { AdaptiveModalSheet, AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import type { Theme } from "@/styles/theme";

interface ClusterResourceDetailProps {
  serverId: string;
  clusterId: string;
  kind: string;
  namespace?: string;
  name: string;
  onClose: () => void;
  onChanged?: () => void;
}

const WORKLOAD_KINDS = new Set(["Deployment", "DaemonSet", "StatefulSet", "ReplicaSet"]);
const RESTARTABLE_KINDS = new Set(["Deployment", "DaemonSet", "StatefulSet"]);

function parseContainersFromYaml(yaml: string): string[] {
  const containers: string[] = [];
  const lines = yaml.split("\n");
  let inContainers = false;
  let containersIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!inContainers) {
      if (trimmed === "containers:") {
        inContainers = true;
        containersIndent = line.length - trimmed.length;
      }
    } else {
      const indent = line.length - trimmed.length;
      if (indent <= containersIndent && trimmed.length > 0 && !trimmed.startsWith("#")) {
        break;
      }
      const nameMatch = trimmed.match(/^-\s+name:\s+(\S+)/);
      if (nameMatch) {
        containers.push(nameMatch[1]);
      }
    }
  }

  return containers;
}

export function ClusterResourceDetail({
  serverId,
  clusterId,
  kind,
  namespace,
  name,
  onClose,
  onChanged,
}: ClusterResourceDetailProps) {
  const client = useHostRuntimeClient(serverId);

  const [yaml, setYaml] = useState<string | null>(null);
  const [editedYaml, setEditedYaml] = useState("");
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [deletingConfirm, setDeletingConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scaleReplicas, setScaleReplicas] = useState("");
  const [scaling, setScaling] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [editedYamlResetKey, setEditedYamlResetKey] = useState(0);

  // Logs state
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [containers, setContainers] = useState<string[]>([]);
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);

  const isWorkload = WORKLOAD_KINDS.has(kind);
  const canRestart = RESTARTABLE_KINDS.has(kind);
  const isPod = kind.toLowerCase() === "pod";

  useEffect(() => {
    if (!client) {
      setLoading(false);
      setError("No client connection");
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    void client
      .clusterGet({ id: clusterId, kind, namespace, name })
      .then((res) => {
        if (res.error) {
          setError(res.error);
          setYaml(null);
        } else {
          const y = res.yaml ?? "";
          setYaml(res.yaml);
          setEditedYaml(y);
          setEditedYamlResetKey((k) => k + 1);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load resource");
        setYaml(null);
      })
      .finally(() => setLoading(false));
  }, [client, clusterId, kind, namespace, name]);

  // Parse containers from YAML when it loads for Pods
  useEffect(() => {
    if (yaml && isPod) {
      setContainers(parseContainersFromYaml(yaml));
    }
  }, [yaml, isPod]);

  const fetchLogs = useCallback(
    async (container: string | null) => {
      if (!client || !namespace) {
        setLogError("No namespace available");
        setLogLoading(false);
        return;
      }
      setLogLoading(true);
      setLogError(null);
      setLogs(null);
      try {
        const res = await client.clusterLogs({
          id: clusterId,
          namespace,
          pod: name,
          ...(container ? { container } : {}),
        });
        if (res.error) {
          setLogError(res.error);
        } else {
          setLogs(res.logs);
        }
      } catch (e: unknown) {
        setLogError(e instanceof Error ? e.message : "Failed to fetch logs");
      } finally {
        setLogLoading(false);
      }
    },
    [client, clusterId, namespace, name],
  );

  const handleToggleLogs = useCallback(() => {
    const next = !showLogs;
    setShowLogs(next);
    if (next) {
      setEditing(false);
      fetchLogs(selectedContainer);
    }
  }, [showLogs, fetchLogs, selectedContainer]);

  const handleRefreshLogs = useCallback(() => {
    fetchLogs(selectedContainer);
  }, [fetchLogs, selectedContainer]);

  const handleSelectContainer = useCallback(
    (container: string) => {
      const next = selectedContainer === container ? null : container;
      setSelectedContainer(next);
      if (showLogs) {
        fetchLogs(next);
      }
    },
    [selectedContainer, showLogs, fetchLogs],
  );

  const handleDelete = useCallback(() => {
    if (!deletingConfirm) {
      setDeletingConfirm(true);
      return;
    }
    if (!client) return;
    setDeleting(true);
    setMessage(null);
    void client
      .clusterWrite({
        id: clusterId,
        kind,
        namespace,
        name,
        action: "delete",
        dryRun: false,
      })
      .then((res) => {
        if (res.error) {
          setMessage(res.error);
        } else if (res.result?.ok) {
          onChanged?.();
          onClose();
        } else {
          setMessage(res.result?.message ?? "Delete failed");
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setMessage(e instanceof Error ? e.message : "Delete failed");
      })
      .finally(() => {
        setDeleting(false);
        setDeletingConfirm(false);
      });
  }, [deletingConfirm, client, clusterId, kind, namespace, name, onChanged, onClose]);

  const handleRestart = useCallback(() => {
    if (!client) return;
    setRestarting(true);
    setMessage(null);
    setDeletingConfirm(false);
    void client
      .clusterWrite({
        id: clusterId,
        kind,
        namespace,
        name,
        action: "restart",
        dryRun: false,
      })
      .then((res) => {
        if (res.error) {
          setMessage(res.error);
        } else {
          setMessage(res.result?.message ?? "Restart initiated");
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setMessage(e instanceof Error ? e.message : "Restart failed");
      })
      .finally(() => setRestarting(false));
  }, [client, clusterId, kind, namespace, name]);

  const handleScale = useCallback(() => {
    if (!client) return;
    const replicas = parseInt(scaleReplicas, 10);
    if (isNaN(replicas) || replicas < 0) {
      setMessage("Invalid replica count");
      return;
    }
    setScaling(true);
    setMessage(null);
    setDeletingConfirm(false);
    void client
      .clusterWrite({
        id: clusterId,
        kind,
        namespace,
        name,
        action: "scale",
        replicas,
        dryRun: false,
      })
      .then((res) => {
        if (res.error) {
          setMessage(res.error);
        } else {
          setMessage(res.result?.message ?? "Scale applied");
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setMessage(e instanceof Error ? e.message : "Scale failed");
      })
      .finally(() => setScaling(false));
  }, [client, clusterId, kind, namespace, name, scaleReplicas]);

  const handleApply = useCallback(() => {
    if (!client || !editedYaml) return;
    setApplying(true);
    setMessage(null);
    setDeletingConfirm(false);
    // Dry run first
    void client
      .clusterWrite({
        id: clusterId,
        kind,
        namespace,
        name,
        action: "apply",
        manifestYaml: editedYaml,
        dryRun: true,
      })
      .then((dryRes) => {
        if (dryRes.error) {
          setMessage(dryRes.error);
          setApplying(false);
          return;
        }
        // Actual apply
        void client
          .clusterWrite({
            id: clusterId,
            kind,
            namespace,
            name,
            action: "apply",
            manifestYaml: editedYaml,
            dryRun: false,
          })
          .then((res) => {
            if (res.error) {
              setMessage(res.error);
            } else if (res.result?.ok) {
              onChanged?.();
              onClose();
            } else {
              setMessage(res.result?.message ?? "Apply failed");
            }
            return undefined;
          })
          .catch((e: unknown) => {
            setMessage(e instanceof Error ? e.message : "Apply failed");
          })
          .finally(() => setApplying(false));
        return undefined;
      })
      .catch((e: unknown) => {
        setMessage(e instanceof Error ? e.message : "Dry run failed");
        setApplying(false);
      });
  }, [client, clusterId, kind, namespace, name, editedYaml, onChanged, onClose]);

  const handleToggleEdit = useCallback(() => {
    setEditing((e) => !e);
    setDeletingConfirm(false);
    setShowLogs(false);
  }, []);

  const yamlBody = useMemo(() => {
    if (loading) {
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
    if (yaml === null) {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.emptyText}>No YAML available</Text>
        </View>
      );
    }
    if (editing) {
      return (
        <View style={styles.editArea}>
          <AdaptiveTextInput
            style={styles.yamlInput}
            value={editedYaml}
            onChangeText={setEditedYaml}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            resetKey={editedYamlResetKey}
            webControlled
          />
          <Pressable
            style={styles.applyButton}
            onPress={handleApply}
            disabled={applying || !editedYaml}
          >
            <Text style={styles.applyButtonText}>{applying ? "Applying..." : "Apply"}</Text>
          </Pressable>
        </View>
      );
    }
    return (
      <ScrollView style={styles.yamlScroll} nestedScrollEnabled>
        <Text style={styles.yamlText} selectable>
          {yaml}
        </Text>
      </ScrollView>
    );
  }, [loading, error, yaml, editing, editedYaml, editedYamlResetKey, handleApply, applying]);

  const logsBody = useMemo(() => {
    if (logLoading) {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.loadingText}>Loading logs...</Text>
        </View>
      );
    }
    if (logError) {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.errorText}>{logError}</Text>
        </View>
      );
    }
    if (logs === null) {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.emptyText}>No logs available</Text>
        </View>
      );
    }
    if (logs === "") {
      return (
        <View style={styles.centerContainer}>
          <Text style={styles.emptyText}>No logs</Text>
        </View>
      );
    }
    return (
      <ScrollView style={styles.logsScroll} nestedScrollEnabled>
        <Text style={styles.logsText} selectable>
          {logs}
        </Text>
      </ScrollView>
    );
  }, [logLoading, logError, logs]);

  const deleteButtonLabel = useMemo(() => {
    if (deleting) return "Deleting...";
    if (deletingConfirm) return "Confirm delete?";
    return "Delete";
  }, [deleting, deletingConfirm]);

  const header = useMemo(
    () => ({
      title: name,
      subtitle: `${kind}${namespace ? ` · ${namespace}` : " · cluster-scoped"}`,
    }),
    [kind, name, namespace],
  );

  return (
    <AdaptiveModalSheet header={header} visible onClose={onClose} scrollable={false}>
      {/* Action bar */}
      <View style={styles.actionBar}>
        <View style={styles.actionBarLeft}>
          {isPod ? (
            <Pressable style={styles.actionButton} onPress={handleToggleLogs} disabled={logLoading}>
              <Text style={styles.actionButtonText}>{showLogs ? "YAML" : "Logs"}</Text>
            </Pressable>
          ) : null}
          {canRestart ? (
            <Pressable style={styles.actionButton} onPress={handleRestart} disabled={restarting}>
              <Text style={styles.actionButtonText}>
                {restarting ? "Restarting..." : "Restart"}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            style={[styles.actionButton, editing && styles.actionButtonActive]}
            onPress={handleToggleEdit}
          >
            <Text style={[styles.actionButtonText, editing && styles.actionButtonTextActive]}>
              {editing ? "View YAML" : "Edit YAML"}
            </Text>
          </Pressable>
        </View>
        <Pressable
          style={[styles.deleteButton, deletingConfirm && styles.deleteButtonConfirm]}
          onPress={handleDelete}
          disabled={deleting}
        >
          <Text
            style={[styles.deleteButtonText, deletingConfirm && styles.deleteButtonTextConfirm]}
          >
            {deleteButtonLabel}
          </Text>
        </Pressable>
      </View>

      {/* Scale row */}
      {isWorkload ? (
        <View style={styles.scaleRow}>
          <Text style={styles.scaleLabel}>Replicas:</Text>
          <View style={styles.scaleInputWrapper}>
            <AdaptiveTextInput
              style={styles.scaleInput}
              value={scaleReplicas}
              onChangeText={setScaleReplicas}
              keyboardType="number-pad"
              placeholder="e.g. 3"
              resetKey={`scale-${name}`}
            />
          </View>
          <Pressable style={styles.scaleButton} onPress={handleScale} disabled={scaling}>
            <Text style={styles.scaleButtonText}>{scaling ? "Scaling..." : "Scale"}</Text>
          </Pressable>
        </View>
      ) : null}

      {showLogs ? (
        <View style={styles.logsContainer}>
          <View style={styles.logsHeader}>
            <Text style={styles.yamlSectionLabel}>Logs</Text>
            <View style={styles.logsHeaderRight}>
              {containers.length > 1 ? (
                <View style={styles.containerSelector}>
                  {containers.map((c) => (
                    <Pressable
                      key={c}
                      style={[
                        styles.containerChip,
                        selectedContainer === c && styles.containerChipActive,
                      ]}
                      // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop
                      onPress={() => handleSelectContainer(c)}
                    >
                      <Text
                        style={[
                          styles.containerChipText,
                          selectedContainer === c && styles.containerChipTextActive,
                        ]}
                      >
                        {c}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
              <Pressable
                style={styles.refreshButton}
                onPress={handleRefreshLogs}
                disabled={logLoading}
              >
                <Text style={styles.refreshButtonText}>
                  {logLoading ? "Loading..." : "Refresh"}
                </Text>
              </Pressable>
            </View>
          </View>
          {logsBody}
        </View>
      ) : (
        <View style={styles.yamlContainer}>
          <Text style={styles.yamlSectionLabel}>{editing ? "Edit YAML" : "YAML"}</Text>
          {yamlBody}
        </View>
      )}

      {/* Message */}
      {message ? (
        <View style={styles.messageBar}>
          <Text style={styles.messageText}>{message}</Text>
        </View>
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  actionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  actionBarLeft: {
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
  actionButtonActive: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.foregroundMuted,
  },
  actionButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  actionButtonTextActive: {
    color: theme.colors.foreground,
  },
  deleteButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.destructive,
  },
  deleteButtonConfirm: {
    backgroundColor: theme.colors.palette.red[500],
  },
  deleteButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.destructiveForeground,
  },
  deleteButtonTextConfirm: {
    color: "#ffffff",
  },
  scaleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  scaleLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  scaleInputWrapper: {
    flex: 1,
    maxWidth: 120,
  },
  scaleInput: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  scaleButton: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  scaleButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  yamlContainer: {
    flex: 1,
    minHeight: 200,
    paddingTop: theme.spacing[3],
  },
  yamlSectionLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    marginBottom: theme.spacing[2],
  },
  yamlScroll: {
    flex: 1,
    minHeight: 160,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
  },
  yamlText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    lineHeight: 20,
  },
  editArea: {
    flex: 1,
    minHeight: 160,
    gap: theme.spacing[2],
  },
  yamlInput: {
    flex: 1,
    minHeight: 160,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    lineHeight: 20,
    textAlignVertical: "top",
  },
  applyButton: {
    alignSelf: "flex-end",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  applyButtonText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.accentForeground,
  },
  logsContainer: {
    flex: 1,
    minHeight: 200,
    paddingTop: theme.spacing[3],
  },
  logsHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: theme.spacing[2],
  },
  logsHeaderRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  logsScroll: {
    flex: 1,
    minHeight: 160,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
  },
  logsText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
    color: theme.colors.foregroundMuted,
    lineHeight: 20,
    flexWrap: "wrap",
  },
  containerSelector: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  containerChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  containerChipActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  containerChipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  containerChipTextActive: {
    color: theme.colors.accentForeground,
  },
  refreshButton: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  refreshButtonText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    minHeight: 120,
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
  messageBar: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    marginTop: theme.spacing[2],
  },
  messageText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
}));
