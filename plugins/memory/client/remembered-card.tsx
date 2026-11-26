import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Brain } from "lucide-react-native";
import type { MemoryRecordWire } from "@jagentdesk/protocol/memory";
import {
  Button,
  useHostRuntimeClient,
  useToast,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import type { MemoryRememberedItemData } from "../shared/types";
import { MemoryEditorSheet } from "./memory-editor-sheet";

/** The `memory-remembered` row's data, or null when this app does not understand it. */
export function readRememberedData(data: unknown): MemoryRememberedItemData | null {
  if (!data || typeof data !== "object") return null;
  const memory = (data as Record<string, unknown>).memory;
  if (!memory || typeof memory !== "object") return null;
  const record = memory as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.text !== "string") return null;
  if (record.scope !== "project" && record.scope !== "global") return null;
  return {
    memory: {
      id: record.id,
      text: record.text,
      scope: record.scope,
      tags: Array.isArray(record.tags) ? record.tags.filter((tag) => typeof tag === "string") : [],
      pinned: record.pinned === true,
    },
  };
}

/** `Remembered · {{text}}` with Undo (delete) and Edit (spec 41 §2). */
export function RememberedRow({ serverId, item }: { serverId: string; item: { data: unknown } }) {
  const data = readRememberedData(item.data);
  return data ? <RememberedCard serverId={serverId} saved={data.memory} /> : null;
}

function RememberedCard({
  serverId,
  saved,
}: {
  serverId: string;
  saved: MemoryRememberedItemData["memory"];
}) {
  const client = useHostRuntimeClient(serverId);
  const { t } = useTranslation();
  const toast = useToast();
  const [memory, setMemory] = useState(saved);
  const [removed, setRemoved] = useState(false);
  const [editing, setEditing] = useState(false);

  const startEditing = useCallback(() => setEditing(true), []);
  const stopEditing = useCallback(() => setEditing(false), []);
  // The editor reads the full record; fields the row does not carry are filled for display only.
  const editTarget = useMemo(
    () => ({ kind: "edit" as const, memory: asRecord(memory) }),
    [memory],
  );
  const undo = useCallback(() => {
    client
      ?.deleteMemory(memory.id)
      .then(() => setRemoved(true))
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  }, [client, memory.id, toast]);

  return (
    <View style={styles.card} testID="memory-remembered-card">
      <ThemedBrain size={16} uniProps={mutedColor} />
      <Text style={[styles.text, removed ? styles.removed : null]} numberOfLines={3}>
        {removed ? t("memory.rememberedUndone") : t("memory.remembered", { text: memory.text })}
      </Text>
      {removed ? null : (
        <View style={styles.actions}>
          <Button size="sm" variant="ghost" onPress={undo} disabled={!client} testID="memory-undo">
            {t("memory.actions.undo")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={startEditing}
            disabled={!client}
            testID="memory-edit"
          >
            {t("memory.actions.edit")}
          </Button>
        </View>
      )}
      {editing ? (
        <MemoryEditorSheet
          serverId={serverId}
          target={editTarget}
          onClose={stopEditing}
          onSaved={setMemory}
        />
      ) : null}
    </View>
  );
}

function asRecord(memory: MemoryRememberedItemData["memory"]): MemoryRecordWire {
  return {
    ...memory,
    projectId: null,
    source: { by: "agent" },
    createdAtMs: 0,
    updatedAtMs: 0,
    lastUsedAtMs: null,
    useCount: 0,
  };
}

const ThemedBrain = withUnistyles(Brain);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme: Theme) => ({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  text: { flex: 1, fontSize: 14, color: theme.colors.foreground },
  removed: { color: theme.colors.foregroundMuted },
  actions: { flexDirection: "row", gap: theme.spacing[1] },
}));
