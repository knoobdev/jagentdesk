import { memo, useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Pencil, Pin, PinOff, Trash2 } from "lucide-react-native";
import type { MemoryRecordWire } from "@jagentdesk/protocol/memory";
import {
  confirmDialog,
  formatTimeAgo,
  navigateToAgent,
  useHostRuntimeClient,
  useIsCompactFormFactor,
  useSessionStore,
  useToast,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";

export interface MemoryRowProps {
  serverId: string;
  memory: MemoryRecordWire;
  onEdit: (memory: MemoryRecordWire) => void;
  /** Extra line under the text (the inspector shows why it was used). */
  note?: string;
  /** Two-line rows regardless of form factor (narrow hosts such as the inspector). */
  dense?: boolean;
}

/** The agent's title, or a placeholder when the agent was deleted. */
export function useSourceLabel(serverId: string, memory: MemoryRecordWire): string {
  const { t } = useTranslation();
  const agentId = memory.source.agentId;
  const title = useSessionStore((state) => {
    if (!agentId) return null;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.title?.trim() || null;
  });
  if (memory.source.by === "user") return t("memory.source.user");
  if (!agentId) return t("memory.source.agent");
  return title ?? t("memory.source.unknownAgent");
}

/** One memory in a 44 px Gumloop table row (two lines on phones). */
export const MemoryRow = memo(function MemoryRow({
  serverId,
  memory,
  onEdit,
  note, dense }: MemoryRowProps) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor() || dense === true;
  const client = useHostRuntimeClient(serverId);
  const toast = useToast();
  const sourceLabel = useSourceLabel(serverId, memory);
  const lastUsed = memory.lastUsedAtMs
    ? formatTimeAgo(new Date(memory.lastUsedAtMs))
    : t("memory.never");
  const used = t("memory.usedCount", { count: memory.useCount });

  const openSource = useCallback(() => {
    if (memory.source.agentId) navigateToAgent({ serverId, agentId: memory.source.agentId });
  }, [memory.source.agentId, serverId]);
  const togglePin = useCallback(() => {
    client
      ?.saveMemory({ id: memory.id, pinned: !memory.pinned })
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  }, [client, memory.id, memory.pinned, toast]);
  const remove = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("memory.confirmDelete.title"),
      message: t("memory.confirmDelete.message"),
      confirmLabel: t("memory.actions.delete"),
      destructive: true,
    });
    if (!confirmed) return;
    client
      ?.deleteMemory(memory.id)
      .catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)),
      );
  }, [client, memory.id, t, toast]);
  const handleRemove = useCallback(() => void remove(), [remove]);
  const edit = useCallback(() => onEdit(memory), [memory, onEdit]);

  const actions = (
    <View style={styles.actions}>
      <IconButton
        label={memory.pinned ? t("memory.actions.unpin") : t("memory.actions.pin")}
        onPress={togglePin}
        testID="memory-row-pin"
      >
        {memory.pinned ? (
          <ThemedPinOff size={16} uniProps={mutedColor} />
        ) : (
          <ThemedPin size={16} uniProps={mutedColor} />
        )}
      </IconButton>
      <IconButton
        label={t("memory.actions.edit")}
        onPress={edit}
        testID="memory-row-edit"
      >
        <ThemedPencil size={16} uniProps={mutedColor} />
      </IconButton>
      <IconButton
        label={t("memory.actions.delete")}
        onPress={handleRemove}
        testID="memory-row-delete"
      >
        <ThemedTrash size={16} uniProps={mutedColor} />
      </IconButton>
    </View>
  );
  const source = (
    <Pressable
      onPress={openSource}
      disabled={!memory.source.agentId}
      accessibilityRole={memory.source.agentId ? "link" : undefined}
      accessibilityLabel={memory.source.agentId ? t("memory.actions.openAgent") : undefined}
    >
      <Text style={[styles.meta, memory.source.agentId ? styles.link : null]} numberOfLines={1}>
        {sourceLabel}
      </Text>
    </Pressable>
  );
  const body = (
    <View style={styles.textColumn}>
      <Text style={styles.text} selectable>
        {memory.pinned ? <Text style={styles.pinnedTag}>{`${t("memory.pinned")} · `}</Text> : null}
        {memory.text}
      </Text>
      {memory.tags.length > 0 ? (
        <View style={styles.tags}>
          {memory.tags.map((tag) => (
            <Text key={tag} style={styles.tag}>
              {tag}
            </Text>
          ))}
        </View>
      ) : null}
      {note ? <Text style={styles.meta}>{note}</Text> : null}
    </View>
  );

  if (compact) {
    return (
      <View style={[styles.row, styles.rowCompact]} testID="memory-row">
        {body}
        <View style={styles.compactMeta}>
          {source}
          <Text style={styles.meta}>{` · ${used} · ${lastUsed}`}</Text>
          <View style={styles.spacer} />
          {actions}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.row} testID="memory-row">
      {body}
      <View style={styles.sourceColumn}>{source}</View>
      <Text style={[styles.meta, styles.usedColumn]}>{used}</Text>
      <Text style={[styles.meta, styles.lastColumn]}>{lastUsed}</Text>
      {actions}
    </View>
  );
});

function IconButton({
  label,
  onPress,
  children,
  testID,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={iconButtonStyle}
      testID={testID}
    >
      {children}
    </Pressable>
  );
}

function iconButtonStyle({ hovered }: { hovered?: boolean }) {
  return [styles.iconButton, hovered ? styles.iconButtonHovered : null];
}

const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash = withUnistyles(Trash2);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const MEMORY_COLUMN_WIDTHS = { source: 160, used: 80, lastUsed: 110, actions: 104 };

const styles = StyleSheet.create((theme: Theme) => ({
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowCompact: { flexDirection: "column", alignItems: "stretch", gap: theme.spacing[1] },
  textColumn: { flex: 1, minWidth: 0, gap: 4 },
  text: { fontSize: 14, lineHeight: 20, color: theme.colors.foreground },
  pinnedTag: { color: theme.colors.foregroundMuted, fontWeight: "500" },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  tag: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  meta: { fontSize: 13, color: theme.colors.foregroundMuted },
  link: { textDecorationLine: "underline" },
  sourceColumn: { width: MEMORY_COLUMN_WIDTHS.source },
  usedColumn: { width: MEMORY_COLUMN_WIDTHS.used },
  lastColumn: { width: MEMORY_COLUMN_WIDTHS.lastUsed },
  compactMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  spacer: { flex: 1 },
  actions: { flexDirection: "row", alignItems: "center", width: MEMORY_COLUMN_WIDTHS.actions },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: { backgroundColor: theme.colors.surface2 },
}));
