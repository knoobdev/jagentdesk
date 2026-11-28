import { memo, useCallback, useEffect, useState, type ReactElement } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { StatusRing } from "@/components/status-ring";
import { useIsCompactFormFactor } from "@/constants/layout";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { AgentBackgroundWorkSummary } from "@jagentdesk/protocol/messages";
import { backgroundWorkText } from "./presentation";
import { formatBackgroundElapsed } from "./format";
import { requestBackgroundWorkTrackOpen, useBackgroundWorkSnapshot } from "./shared";

/** Running tasks according to the directory summary, which is all a list row has for free. */
export function countRunningBackgroundWork(
  summary: AgentBackgroundWorkSummary | null | undefined,
): number {
  return summary?.runningCount ?? summary?.count ?? 0;
}

function useNow(active: boolean, startedAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  // Seconds only show for the first minute; after that the line changes once a minute at most.
  const firstMinute = startedAtMs !== null && now - startedAtMs < 60_000;
  useEffect(() => {
    if (!active || startedAtMs === null) return;
    const handle = setInterval(() => setNow(Date.now()), firstMinute ? 1000 : 15_000);
    return () => clearInterval(handle);
  }, [active, startedAtMs, firstMinute]);
  return now;
}

export interface BackgroundWorkLineProps {
  serverId: string;
  /** The agent whose first task names the line, and the one a press opens. */
  agentId: string;
  /** Tasks the row stands for — more than this agent's when a row covers a whole workspace. */
  totalCount: number;
  testID?: string;
}

/**
 * The second line under an agent (or workspace) name while background work runs: a small ring,
 * the first task and how long it has run, and "+n" for the rest. Spec 38 §4.4b.
 */
export const BackgroundWorkLine = memo(function BackgroundWorkLine({
  serverId,
  agentId,
  totalCount,
  testID,
}: BackgroundWorkLineProps): ReactElement | null {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const { items } = useBackgroundWorkSnapshot(serverId, agentId, totalCount > 0);
  const first = items?.[0] ?? null;
  const startedAtMs = first ? Date.parse(first.startedAt) : null;
  const now = useNow(first !== null, startedAtMs);
  const open = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      requestBackgroundWorkTrackOpen(serverId, agentId);
      navigateToAgent({ serverId, agentId });
    },
    [agentId, serverId],
  );
  if (totalCount <= 0 || (items !== null && items.length === 0)) return null;

  let label = t("message.backgroundWork.running");
  if (first) {
    const kind = t(`message.backgroundWork.${first.kind === "monitor" ? "monitor" : "shell"}`);
    const { title, command } = backgroundWorkText(first, kind);
    label = command ?? title;
    if (startedAtMs !== null && Number.isFinite(startedAtMs))
      label = `${label} · ${formatBackgroundElapsed(now - startedAtMs)}`;
  }
  const extra = Math.max(totalCount, items?.length ?? 0) - 1;
  const content = (
    <>
      <View style={styles.ring}>
        <StatusRing />
      </View>
      <Text style={styles.text} numberOfLines={1}>
        {label}
      </Text>
      {extra > 0 ? (
        <Text style={styles.more}>{t("message.backgroundWork.more", { count: extra })}</Text>
      ) : null}
    </>
  );
  // On a phone the line is a 16 px strip under the row's name, far below a finger's target: a tap
  // meant for the row landed on it and brought the agent back with its Background work sheet
  // open (user report 2026-11-28, iPhone). There it only shows the work; the row opens the agent.
  if (compact) {
    return (
      <View style={styles.line} testID={testID ?? `background-work-line-${agentId}`}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t("message.backgroundWork.openTrack", { label })}
      onPress={open}
      style={styles.line}
      testID={testID ?? `background-work-line-${agentId}`}
    >
      {content}
    </Pressable>
  );
});

const styles = StyleSheet.create((theme) => ({
  // As wide as its text, not the row: the line opens the background track, and a press on the
  // empty rest of the row's second line has to open the agent like the rest of the row does.
  line: {
    alignSelf: "flex-start",
    maxWidth: "100%",
    height: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minWidth: 0,
  },
  // The shared ring is 12 px; the sidebar line asks for 10 (spec 38 §4.4b).
  ring: {
    width: 10,
    height: 10,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ scale: 10 / 12 }],
  },
  text: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  more: {
    flexShrink: 0,
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
}));
