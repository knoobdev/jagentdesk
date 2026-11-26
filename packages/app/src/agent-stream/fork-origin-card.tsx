import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { AgentTimelineItem } from "@jagentdesk/protocol/agent-types";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const PAGE_SIZE = 20;

export interface ForkOriginData {
  parentAgentId: string;
  parentTitle: string | null;
  boundary: { epoch: string; seq: number } | null;
}

export function readForkOriginData(data: unknown): ForkOriginData | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.parentAgentId !== "string") return null;
  const boundary = record.boundary as Record<string, unknown> | null | undefined;
  return {
    parentAgentId: record.parentAgentId,
    parentTitle: typeof record.parentTitle === "string" ? record.parentTitle : null,
    boundary:
      boundary && typeof boundary.epoch === "string" && typeof boundary.seq === "number"
        ? { epoch: boundary.epoch, seq: boundary.seq }
        : null,
  };
}

/** The page that ends at the fork point; the tail when the fork has no recorded boundary. */
function firstPageCursor(
  boundary: ForkOriginData["boundary"],
): { epoch: string; seq: number } | null {
  return boundary ? { epoch: boundary.epoch, seq: boundary.seq + 1 } : null;
}

type HistoryRow =
  | { kind: "message"; key: string; role: "user" | "assistant"; text: string }
  | { kind: "tools"; key: string; count: number };

/** User and assistant text of the parent's rows; a run of tool calls collapses to a count. */
function toHistoryRows(items: readonly { seqStart: number; item: AgentTimelineItem }[]) {
  const rows: HistoryRow[] = [];
  for (const { seqStart, item } of items) {
    if (item.type === "user_message" || item.type === "assistant_message") {
      const role = item.type === "user_message" ? "user" : "assistant";
      const last = rows.at(-1);
      if (last?.kind === "message" && last.role === role && role === "assistant") {
        last.text += item.text;
      } else {
        rows.push({ kind: "message", key: `m${seqStart}`, role, text: item.text });
      }
    } else if (item.type === "tool_call") {
      const last = rows.at(-1);
      if (last?.kind === "tools") last.count += 1;
      else rows.push({ kind: "tools", key: `t${seqStart}`, count: 1 });
    }
  }
  return rows;
}

/**
 * The first row of a fast fork (spec 41 §6): the parent's history is read from the parent in
 * pages, by reference, never copied into this agent.
 */
export function ForkOriginCard({ serverId, data }: { serverId: string; data: ForkOriginData }) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const liveTitle = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const parent =
      session?.agents.get(data.parentAgentId) ?? session?.agentDetails.get(data.parentAgentId);
    return parent?.title?.trim() || null;
  });
  const title = liveTitle ?? data.parentTitle;
  const [entries, setEntries] = useState<{ seqStart: number; item: AgentTimelineItem }[] | null>(
    null,
  );
  const [hasOlder, setHasOlder] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const olderCursor = useRef<{ epoch: string; seq: number } | null>(null);

  const loadPage = useCallback(
    async (first: boolean) => {
      if (!client) return;
      setLoading(true);
      setError(null);
      try {
        const cursor = first ? firstPageCursor(data.boundary) : olderCursor.current;
        const page = await client.fetchAgentTimeline(data.parentAgentId, {
          direction: cursor ? "before" : "tail",
          ...(cursor ? { cursor } : {}),
          limit: PAGE_SIZE,
          projection: "projected",
        });
        if (page.error) throw new Error(page.error);
        olderCursor.current = page.startCursor;
        setHasOlder(page.hasOlder);
        const pageEntries = page.entries.map((entry) => ({
          seqStart: entry.seqStart,
          item: entry.item,
        }));
        setEntries((current) => (first || !current ? pageEntries : [...pageEntries, ...current]));
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      } finally {
        setLoading(false);
      }
    },
    [client, data.boundary, data.parentAgentId],
  );
  const loadOlder = useCallback(() => void loadPage(false), [loadPage]);
  const toggle = useCallback(() => {
    if (entries) setEntries(null);
    else void loadPage(true);
  }, [entries, loadPage]);
  const openParent = useCallback(
    () => navigateToAgent({ serverId, agentId: data.parentAgentId }),
    [data.parentAgentId, serverId],
  );

  const rows = entries ? toHistoryRows(entries) : [];
  return (
    <View style={styles.card} testID="fork-origin">
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {title
            ? t("message.actions.forkedFrom", { title })
            : t("message.actions.forkedFromUnknown")}
        </Text>
        <Pressable onPress={openParent} accessibilityRole="link" testID="fork-origin-open">
          <Text style={styles.link}>{t("message.actions.forkOpenOriginal")}</Text>
        </Pressable>
        <Pressable
          onPress={toggle}
          accessibilityRole="button"
          testID="fork-origin-toggle"
          disabled={loading}
        >
          <Text style={styles.link}>
            {entries ? t("message.actions.forkHideEarlier") : t("message.actions.forkShowEarlier")}
          </Text>
        </Pressable>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {entries ? (
        <View style={styles.history} testID="fork-origin-history">
          {hasOlder ? (
            <Pressable
              onPress={loadOlder}
              disabled={loading}
              testID="fork-origin-older"
            >
              <Text style={styles.link}>{t("message.actions.forkLoadOlder")}</Text>
            </Pressable>
          ) : null}
          {rows.map((row) =>
            row.kind === "tools" ? (
              <Text key={row.key} style={styles.meta}>
                {t("message.actions.forkToolCalls", { count: row.count })}
              </Text>
            ) : (
              <View key={row.key} style={styles.message}>
                <Text style={styles.role}>
                  {row.role === "user"
                    ? t("message.actions.forkYou")
                    : t("message.actions.forkAgent")}
                </Text>
                <Text style={styles.text} selectable>
                  {row.text}
                </Text>
              </View>
            ),
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 12,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
    marginVertical: theme.spacing[2],
  },
  header: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3], flexWrap: "wrap" },
  title: {
    flex: 1,
    minWidth: 120,
    fontSize: 14,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  link: { fontSize: 13, color: theme.colors.foregroundMuted, textDecorationLine: "underline" },
  error: { fontSize: 13, color: theme.colors.destructive },
  history: { gap: theme.spacing[2], paddingTop: theme.spacing[1] },
  message: { gap: 2 },
  role: { fontSize: 12, fontWeight: "600", color: theme.colors.foregroundMuted },
  text: { fontSize: 14, lineHeight: 20, color: theme.colors.foreground },
  meta: { fontSize: 12, color: theme.colors.foregroundMuted },
}));
