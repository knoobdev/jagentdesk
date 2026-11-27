// Automations in the bot's Home panel (spec 37.4.4 item 4): Look around, Tidy memory, the bot's
// automations and its open waits, failed first, then running, then soonest; five automations show,
// then "All {{count}} automations". Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/BotUpcomingSection.tsx:20-110, BotUpcomingRows.tsx:60-325,
// BotLookAroundRow.tsx:50-137 and bot-upcoming-rows.ts. There is no editor: "New automation" fills the
// Home Chat composer with "Set up an automation that " (Orca `BotUpcomingSection.tsx:70`).
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  CalendarClock,
  ChevronRight,
  CirclePlay,
  Hourglass,
  Moon,
  MoreHorizontal,
  Plus,
  Zap,
} from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotAutomation } from "@jagentdesk/protocol/bots/views";
import { lookAroundSupported } from "@jagentdesk/protocol/bots/rules";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildSchedulesRoute } from "@/utils/host-routes";
import { botErrorCode, botErrorMessage, useBotsMutation, useBotsRead } from "@/bots/queries";
import { useBotPanelStore } from "@/bots/panel-store";
import { prefillHomeChat } from "@/bots/home-chat-draft";
import { BotPanelNote, BotPanelSection } from "./panel-section";
import {
  AUTOMATION_CARD_CAP,
  automationCardView,
  automationRowDetail,
  automationRowState,
  type AutomationRowState,
} from "./automation-rows";

const muted = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const ThemedPlus = withUnistyles(Plus);
const ThemedMore = withUnistyles(MoreHorizontal);
const ThemedChevronRight = withUnistyles(ChevronRight);
const KIND_ICONS = {
  look_around: withUnistyles(CirclePlay),
  tidy_up: withUnistyles(Moon),
  wait: withUnistyles(Hourglass),
  schedule: withUnistyles(CalendarClock),
  event: withUnistyles(Zap),
} as const;

function useStateLabel() {
  const { t } = useTranslation();
  return useCallback(
    (row: BotAutomation, state: AutomationRowState): string | null => {
      switch (state) {
        case "failed":
          return t("bots.automations.failed");
        case "running":
          return row.kind === "look_around"
            ? t("bots.upNext.lookingShort")
            : t("bots.automations.running");
        case "stopped":
          return t("bots.upcoming.stopped");
        case "paused":
          return t("bots.automations.paused");
        case null:
          return null;
      }
    },
    [t],
  );
}

function rowName(t: (key: string) => string, row: BotAutomation): string {
  if (row.kind === "look_around") return t("bots.settingsBots.lookAround.title");
  if (row.kind === "tidy_up") return t("bots.upcoming.tidyUp");
  return row.name;
}

function AutomationRow({
  serverId,
  bot,
  row,
  now,
}: {
  serverId: string;
  bot: Bot;
  row: BotAutomation;
  now: number;
}) {
  const { t } = useTranslation();
  const stateLabel = useStateLabel();
  const [error, setError] = useState<string | null>(null);
  const lookNow = useBotsMutation(serverId, "bots.look_around.run_now.request");
  const tidyNow = useBotsMutation(serverId, "bots.tidy_up.run_now.request");
  const runNow = useBotsMutation(serverId, "bots.automations.run_now.request");
  const cancelWait = useBotsMutation(serverId, "bots.automations.cancel_wait.request");
  const state = automationRowState(row);
  const label = stateLabel(row, state);
  const detail = automationRowDetail(t, row, now);
  const name = rowName(t, row);
  const Icon = row.event ? KIND_ICONS.event : KIND_ICONS[row.kind];
  const onError = useCallback(
    (caught: unknown) => {
      const code = botErrorCode(caught);
      if (row.kind === "look_around" && code === "already_running")
        setError(t("bots.upNext.lookNowRunning"));
      else if (row.kind === "look_around" && code === "paused")
        setError(t("bots.upNext.lookNowPaused"));
      else setError(botErrorMessage(caught));
    },
    [row.kind, t],
  );
  const run = useCallback(() => {
    setError(null);
    if (row.kind === "look_around") lookNow.mutate({ botId: bot.id }, { onError });
    else if (row.kind === "tidy_up") tidyNow.mutate({ botId: bot.id }, { onError });
    else runNow.mutate({ botId: bot.id, automationId: row.id }, { onError });
  }, [bot.id, lookNow, onError, row.id, row.kind, runNow, tidyNow]);
  const cancel = useCallback(() => {
    if (!row.itemId) return;
    setError(null);
    cancelWait.mutate({ botId: bot.id, itemId: row.itemId }, { onError });
  }, [bot.id, cancelWait, onError, row.itemId]);
  const openSettings = useCallback(() => {
    useBotPanelStore
      .getState()
      .openSettings(bot.id, row.kind === "tidy_up" ? "tidyUp" : "lookAround");
  }, [bot.id, row.kind]);
  const openSchedules = useCallback(
    () => router.push(buildSchedulesRoute({ serverId, botId: bot.id })),
    [bot.id, serverId],
  );
  const runLabel =
    row.kind === "look_around" ? t("bots.upNext.lookNow") : t("bots.automations.runNow");
  return (
    <View testID={`bot-automation-${row.id}`}>
      <View style={styles.row}>
        <Icon size={16} uniProps={muted} />
        <View style={styles.rowText}>
          <Text style={[styles.rowTitle, !row.enabled && styles.dimmed]} numberOfLines={1}>
            {name}
          </Text>
          {detail ? (
            <Text style={styles.rowDetail} numberOfLines={1}>
              {row.kind === "look_around" && row.enabled && row.nextAt_ms !== undefined
                ? `${t("bots.automations.next")} · ${detail}`
                : detail}
            </Text>
          ) : null}
        </View>
        {label ? (
          <Text style={[styles.state, state === "failed" && styles.failed]} numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        {row.kind === "wait" ? (
          <Button
            size="xs"
            variant="ghost"
            onPress={cancel}
            loading={cancelWait.isPending}
            accessibilityLabel={t("bots.waits.cancelNamed", { name: row.name })}
          >
            {t("bots.waits.cancel")}
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              style={styles.more}
              accessibilityLabel={t("bots.connector.actions", { name })}
              testID={`bot-automation-${row.id}-menu`}
            >
              <ThemedMore size={16} uniProps={muted} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width={240}>
              {state !== "running" ? (
                <DropdownMenuItem onSelect={run}>{runLabel}</DropdownMenuItem>
              ) : null}
              {row.kind === "look_around" ? (
                <DropdownMenuItem onSelect={openSettings}>
                  {t("bots.upcoming.lookAroundSettings")}
                </DropdownMenuItem>
              ) : null}
              {row.kind === "tidy_up" ? (
                <DropdownMenuItem onSelect={openSettings}>
                  {t("bots.upcoming.tidySettings")}
                </DropdownMenuItem>
              ) : null}
              {row.kind === "schedule" && !row.event ? (
                <DropdownMenuItem onSelect={openSchedules}>
                  {t("bots.automations.openOnPage")}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

export function BotAutomationsSection({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const automations = useBotsRead(serverId, "bots.automations.list.request", { botId: bot.id });
  const rows = automations.data?.automations ?? [];
  // Look around and Tidy memory run only on Claude and Codex (`bot-upcoming-rows.ts:26`).
  const supported = lookAroundSupported(bot.provider);
  const visible = supported
    ? rows
    : rows.filter((row) => row.kind !== "look_around" && row.kind !== "tidy_up");
  const { shown, listed } = automationCardView(visible);
  const now = Date.now();
  const total = automations.data?.total ?? listed;
  const hasOwn = visible.some((row) => row.kind === "schedule" || row.kind === "wait");
  const newAutomation = useCallback(
    () => prefillHomeChat(serverId, bot.id, t("bots.automations.newDraft")),
    [bot.id, serverId, t],
  );
  // Schedules filtered by the bot (spec 37.4.4): its automations are core schedules.
  const openAll = useCallback(
    () => router.push(buildSchedulesRoute({ serverId, botId: bot.id })),
    [bot.id, serverId],
  );
  const actions = useMemo(
    () => (
      <Pressable
        onPress={newAutomation}
        accessibilityRole="button"
        accessibilityLabel={t("bots.automations.new")}
        style={styles.more}
        testID="bot-automations-new"
      >
        <ThemedPlus size={16} uniProps={muted} />
      </Pressable>
    ),
    [newAutomation, t],
  );
  return (
    <BotPanelSection title={t("bots.automations.title")} testID="bot-automations" actions={actions}>
      {shown.map((row) => (
        <AutomationRow key={row.id} serverId={serverId} bot={bot} row={row} now={now} />
      ))}
      {listed > AUTOMATION_CARD_CAP ? (
        <Pressable onPress={openAll} accessibilityRole="link" style={styles.allRow}>
          <Text style={styles.allText}>{t("bots.automations.all", { count: total })}</Text>
          <ThemedChevronRight size={14} uniProps={muted} />
        </Pressable>
      ) : null}
      {automations.isSuccess && !hasOwn ? (
        <BotPanelNote testID="bot-automations-empty">
          {t("bots.upcoming.empty", { name: bot.name })}
        </BotPanelNote>
      ) : null}
      {automations.isError ? (
        <BotPanelNote>{botErrorMessage(automations.error)}</BotPanelNote>
      ) : null}
    </BotPanelSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 10 },
  rowText: { flex: 1, minWidth: 0 },
  rowTitle: { fontSize: 14, color: theme.colors.foreground },
  dimmed: { color: theme.colors.foregroundMuted },
  rowDetail: { fontSize: 12, color: theme.colors.foregroundMuted },
  state: { fontSize: 12, color: theme.colors.foregroundMuted },
  failed: { color: theme.colors.statusDanger },
  more: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  allRow: {
    height: 32,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 26,
  },
  allText: { fontSize: 12, color: theme.colors.foregroundMuted },
  error: { fontSize: 12, color: theme.colors.statusDanger, paddingLeft: 26, paddingBottom: 4 },
}));
