import { useCallback, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { MemoryRecordWire } from "@jagentdesk/protocol/memory";
import { formatTimeAgo, type Theme } from "../../../packages/app/src/plugins/builtin/host-api";
import { MemoryEditorSheet } from "./memory-editor-sheet";
import { MemoryRow } from "./memory-row";
import { useAgentMemories } from "./use-memory";

/** Inspector → Memory (spec 41 §5): what this agent remembered and what it used. */
export function MemoryInspectorTab({ serverId, agentId }: { serverId: string; agentId: string }) {
  const { t } = useTranslation();
  const state = useAgentMemories(serverId, agentId);
  const [editing, setEditing] = useState<MemoryRecordWire | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const editTarget = useMemo(
    () => (editing ? { kind: "edit" as const, memory: editing } : null),
    [editing],
  );
  const created = state.status === "ready" ? state.data.created : [];
  // One row per memory: its latest use.
  const used =
    state.status === "ready"
      ? state.data.used.filter(
          (use, index, all) =>
            all.findIndex((other) => other.memory.id === use.memory.id) === index,
        )
      : [];
  return (
    <ScrollView contentContainerStyle={styles.content} testID="memory-inspector">
      {state.status === "error" ? <Text style={styles.empty}>{state.error}</Text> : null}
      {state.status === "ready" && created.length === 0 && used.length === 0 ? (
        <Text style={styles.empty}>{t("memory.inspector.none")}</Text>
      ) : null}
      {created.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t("memory.inspector.created")}</Text>
          {created.map((memory) => (
            <MemoryRow
              key={memory.id}
              serverId={serverId}
              memory={memory}
              onEdit={setEditing}
              dense
            />
          ))}
        </View>
      ) : null}
      {used.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.heading}>{t("memory.inspector.used")}</Text>
          {used.map((use) => (
            <MemoryRow
              dense
              key={use.memory.id}
              serverId={serverId}
              memory={use.memory}
              onEdit={setEditing}
              note={`${use.kind === "searched" ? t("memory.searched") : t("memory.injected")} · ${formatTimeAgo(new Date(use.usedAtMs))}`}
            />
          ))}
        </View>
      ) : null}
      {editTarget ? (
        <MemoryEditorSheet
          serverId={serverId}
          target={editTarget}
          onClose={close}
        />
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  content: { padding: theme.spacing[4], gap: theme.spacing[6] },
  section: { gap: 0 },
  heading: {
    fontSize: 18,
    fontWeight: "500",
    color: theme.colors.foreground,
    marginBottom: theme.spacing[2],
  },
  empty: { fontSize: 14, color: theme.colors.foregroundMuted },
}));
