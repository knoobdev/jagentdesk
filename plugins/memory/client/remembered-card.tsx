import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Brain } from "lucide-react-native";
import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import type { MemoryRecordWire } from "@jagentdesk/protocol/memory";
import { getJAgentDeskToolLeafName } from "@jagentdesk/protocol/tool-name-normalization";
import {
  Button,
  unwrapToolResultPayload,
  useToast,
  type BuiltinToolCallCardProps,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { MemoryEditorSheet } from "./memory-editor-sheet";

export interface RememberToolMatch {
  memory: MemoryRecordWire;
}

function isRememberPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const memory = (value as Record<string, unknown>).memory;
  if (!memory || typeof memory !== "object") return false;
  const record = memory as Record<string, unknown>;
  return (
    typeof record.id === "string" && record.id.startsWith("mem_") && typeof record.text === "string"
  );
}

/** A finished `remember` call that saved a memory; failures keep the generic tool row. */
export function matchRememberToolCall(
  toolName: string,
  detail: ToolCallDetail | undefined,
): RememberToolMatch | null {
  if (!detail || getJAgentDeskToolLeafName(toolName) !== "remember") return null;
  let raw: unknown;
  if (detail.type === "unknown") raw = detail.output;
  else if (detail.type === "plain_text") raw = detail.text;
  else return null;
  if (raw === undefined || raw === null) return null;
  const payload = unwrapToolResultPayload(raw, isRememberPayload);
  return payload ? { memory: payload.memory as MemoryRecordWire } : null;
}

/** `Remembered · {{text}}` with Undo (delete) and Edit (spec 41 §2). */
export function RememberedCard({ client, match }: BuiltinToolCallCardProps<RememberToolMatch>) {
  const { t } = useTranslation();
  const toast = useToast();
  const [memory, setMemory] = useState(match.memory);
  const [removed, setRemoved] = useState(false);
  const [editing, setEditing] = useState(false);
  const serverId = client?.getLastServerInfoMessage()?.serverId ?? null;

  const startEditing = useCallback(() => setEditing(true), []);
  const stopEditing = useCallback(() => setEditing(false), []);
  const editTarget = useMemo(() => ({ kind: "edit" as const, memory }), [memory]);
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
            disabled={!client || !serverId}
            testID="memory-edit"
          >
            {t("memory.actions.edit")}
          </Button>
        </View>
      )}
      {editing && serverId ? (
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
