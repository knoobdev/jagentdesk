import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { ChevronDown } from "lucide-react-native";
import type { Theme } from "@/styles/theme";

interface NamespaceItem {
  name: string;
  namespace: string;
  creationTimestamp: string;
}

interface ClusterNamespaceSelectorProps {
  serverId: string;
  clusterId: string;
  value: string | undefined;
  onChange: (namespace: string | undefined) => void;
}

function NamespaceRow({
  name,
  isSelected,
  onSelect,
}: {
  name: string;
  isSelected: boolean;
  onSelect: (name: string) => void;
}) {
  const handlePress = useCallback(() => onSelect(name), [onSelect, name]);
  return (
    <Pressable onPress={handlePress}>
      {({ pressed }) => (
        <View style={[styles.row, isSelected && styles.rowSelected, pressed && styles.rowPressed]}>
          <Text style={[styles.rowText, isSelected && styles.rowTextSelected]}>{name}</Text>
        </View>
      )}
    </Pressable>
  );
}

function NamespaceSheet({
  namespaces,
  value,
  onSelect,
  onSelectAll,
  onClose,
}: {
  namespaces: NamespaceItem[];
  value: string | undefined;
  onSelect: (ns: string) => void;
  onSelectAll: () => void;
  onClose: () => void;
}) {
  return (
    <Pressable style={styles.overlay} onPress={onClose}>
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle}>Namespace</Text>
        <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
          <Pressable onPress={onSelectAll}>
            {({ pressed }) => (
              <View
                style={[
                  styles.row,
                  value === undefined && styles.rowSelected,
                  pressed && styles.rowPressed,
                ]}
              >
                <Text style={[styles.rowText, value === undefined && styles.rowTextSelected]}>
                  All namespaces
                </Text>
              </View>
            )}
          </Pressable>
          {namespaces.map((ns) => (
            <NamespaceRow
              key={ns.name}
              name={ns.name}
              isSelected={value === ns.name}
              onSelect={onSelect}
            />
          ))}
        </ScrollView>
      </View>
    </Pressable>
  );
}

export function ClusterNamespaceSelector({
  serverId,
  clusterId,
  value,
  onChange,
}: ClusterNamespaceSelectorProps) {
  const client = useHostRuntimeClient(serverId);
  const [namespaces, setNamespaces] = useState<NamespaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!client) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void client
      .clusterResourceList({ id: clusterId, kind: "Namespace" })
      .then((res) => {
        if (res.error) {
          setError(res.error);
          setNamespaces([]);
        } else {
          // clusterResourceList returns raw Kubernetes objects, so the name lives
          // under metadata.name — reading `.name` directly leaves every row blank.
          const parsed = (res.items as Array<Record<string, unknown>>)
            .map((raw) => {
              const md = (raw.metadata as Record<string, unknown> | undefined) ?? {};
              return {
                name: (md.name as string) ?? (raw.name as string) ?? "",
                namespace: "",
                creationTimestamp: (md.creationTimestamp as string) ?? "",
              };
            })
            .filter((ns) => ns.name)
            .sort((a, b) => a.name.localeCompare(b.name));
          setNamespaces(parsed);
        }
        return undefined;
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "Failed to load namespaces");
        setNamespaces([]);
      })
      .finally(() => setLoading(false));
  }, [client, clusterId]);

  const handleSelect = useCallback(
    (ns: string | undefined) => {
      onChange(ns);
      setOpen(false);
    },
    [onChange],
  );

  const handleOpen = useCallback(() => setOpen(true), []);
  const handleClose = useCallback(() => setOpen(false), []);
  const handleSelectAll = useCallback(() => handleSelect(undefined), [handleSelect]);
  const handleSelectNamespace = useCallback((ns: string) => handleSelect(ns), [handleSelect]);

  const triggerLabel = useMemo(() => {
    if (loading) return "Loading...";
    if (error) return "Error";
    return value ?? "All namespaces";
  }, [loading, error, value]);

  return (
    <>
      <Pressable style={styles.trigger} onPress={handleOpen} disabled={loading}>
        <Text style={styles.triggerText} numberOfLines={1}>
          {triggerLabel}
        </Text>
        <ChevronDown size={14} color={styles.triggerText.color} />
      </Pressable>

      <Modal transparent visible={open} animationType="fade" onRequestClose={handleClose}>
        <NamespaceSheet
          namespaces={namespaces}
          value={value}
          onSelect={handleSelectNamespace}
          onSelectAll={handleSelectAll}
          onClose={handleClose}
        />
      </Modal>
    </>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    maxWidth: 200,
  },
  triggerText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flex: 1,
    minWidth: 0,
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: theme.spacing[6],
  },
  sheet: {
    width: "100%",
    maxWidth: 360,
    maxHeight: "70%",
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    overflow: "hidden",
  },
  sheetTitle: {
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.surface2,
  },
  list: {
    flexShrink: 1,
    minHeight: 0,
  },
  listContent: {
    paddingVertical: theme.spacing[1],
  },
  row: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    opacity: 0.8,
  },
  rowText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  rowTextSelected: {
    fontWeight: theme.fontWeight.medium,
  },
}));
