import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Brain } from "lucide-react-native";
import {
  AdaptiveModalSheet,
  navigateToAgent,
  useSessionStore,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";
import type { MemoryUsedEntry } from "../shared/types";
import { readMemoryUsedData } from "./memory-used-data";

/**
 * "Used N memories" on a turn (spec 41 §3.3). The list is frozen when the turn used them: it shows
 * exactly what was sent to the provider or found by search, even after a later edit.
 */
export function MemoryUsedChip({ serverId, item }: { serverId: string; item: { data: unknown } }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);
  const header = useMemo(() => ({ title: t("memory.usedSheetTitle") }), [t]);
  const data = readMemoryUsedData(item.data);
  if (!data || data.memories.length === 0) return null;
  const count = data.memories.length;
  return (
    <View style={styles.wrapper}>
      <Pressable
        onPress={show}
        accessibilityRole="button"
        style={chipStyle}
        testID="memory-used-chip"
      >
        <ThemedBrain size={14} uniProps={mutedColor} />
        <Text style={styles.chipText}>{t("memory.usedChip", { count })}</Text>
      </Pressable>
      {open ? (
        <AdaptiveModalSheet
          visible
          onClose={hide}
          header={header}
          desktopMaxWidth={560}
          testID="memory-used-sheet"
        >
          <View style={styles.list}>
            {data.memories.map((entry) => (
              <UsedEntry key={entry.id} serverId={serverId} entry={entry} />
            ))}
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </View>
  );
}

function UsedEntry({ serverId, entry }: { serverId: string; entry: MemoryUsedEntry }) {
  const { t } = useTranslation();
  const agentId = entry.source.agentId;
  const openSource = useCallback(() => {
    if (agentId) navigateToAgent({ serverId, agentId });
  }, [agentId, serverId]);
  const agentTitle = useSessionStore((state) => {
    if (!agentId) return null;
    const session = state.sessions[serverId];
    return (session?.agents.get(agentId) ?? session?.agentDetails.get(agentId))?.title ?? null;
  });
  const source =
    entry.source.by === "user"
      ? t("memory.source.user")
      : (agentTitle ?? (agentId ? t("memory.source.unknownAgent") : t("memory.source.agent")));
  const meta = [
    entry.scope === "global" ? t("memory.tabs.global") : t("memory.tabs.project"),
    entry.kind === "searched" ? t("memory.searched") : t("memory.injected"),
    ...(entry.score !== null
      ? [t("memory.score", { score: entry.score.toFixed(2) })]
      : [t("memory.pinned")]),
  ].join(" · ");
  return (
    <View style={styles.entry} testID="memory-used-entry">
      <Text style={styles.entryText} selectable>
        {entry.text}
      </Text>
      <View style={styles.entryMeta}>
        <Text style={styles.meta}>{`${meta} · `}</Text>
        <Pressable
          disabled={!agentId}
          onPress={openSource}
          accessibilityRole={agentId ? "link" : undefined}
        >
          <Text style={[styles.meta, agentId ? styles.link : null]}>{source}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function chipStyle({ hovered }: { hovered?: boolean }) {
  return [styles.chip, hovered ? styles.chipHovered : null];
}

const ThemedBrain = withUnistyles(Brain);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const styles = StyleSheet.create((theme: Theme) => ({
  wrapper: { flexDirection: "row", paddingVertical: theme.spacing[1] },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: theme.colors.surface2,
  },
  chipHovered: { backgroundColor: theme.colors.surface3 },
  chipText: { fontSize: 14, fontWeight: "500", color: theme.colors.foregroundMuted },
  list: { gap: 0 },
  entry: {
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    gap: 4,
  },
  entryText: { fontSize: 14, lineHeight: 20, color: theme.colors.foreground },
  entryMeta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  meta: { fontSize: 13, color: theme.colors.foregroundMuted },
  link: { textDecorationLine: "underline" },
}));
