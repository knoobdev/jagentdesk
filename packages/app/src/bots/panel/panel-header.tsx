// Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/BotPanelHeader.tsx:31-288: the top
// of a bot's Home panel — its picture, name, what it is doing now or runs next, the Items filter, the
// gear and More (spec 37.4.4 item 1).
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Copy, MoreHorizontal, Pause, Play, Settings, Share2 } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotAutomation } from "@jagentdesk/protocol/bots/views";
import type { Theme } from "@/styles/theme";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { BotAvatar } from "../avatar";
import { botRowLineText, formatBotWaitTime } from "../row-line";
import type { BotLiveState } from "../bot-status";
import { useBotsMutation, useBotsRead } from "../queries";
import { useBotPanelStore } from "../panel-store";
import { BotItemsFilterButton } from "../items/items-section";

const ThemedSettings = withUnistyles(Settings);
const ThemedMore = withUnistyles(MoreHorizontal);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const PLAY_ICON = <Play size={16} />;
const PAUSE_ICON = <Pause size={16} />;
const SHARE_ICON = <Share2 size={16} />;
const COPY_ICON = <Copy size={16} />;

export interface BotQuietFacts {
  running: string | null;
  next: { name: string; at: number } | null;
}

/** `botQuietLine`: "Running Mentions triage", else "Idle · next 8:00 PM · Look around", else "Idle". */
export function botQuietFacts(automations: readonly BotAutomation[], now: number): BotQuietFacts {
  const running = automations.find((row) => row.state === "running");
  const next = automations
    .filter((row) => row.enabled && row.nextAt_ms !== undefined && row.nextAt_ms > now)
    .sort((a, b) => (a.nextAt_ms ?? 0) - (b.nextAt_ms ?? 0))[0];
  return {
    running: running ? running.name : null,
    next: next?.nextAt_ms !== undefined ? { name: next.name, at: next.nextAt_ms } : null,
  };
}

function useQuietLine(quiet: BotQuietFacts, now: number): string {
  const { t } = useTranslation();
  if (quiet.running !== null) return t("bots.panel.runningNamed", { name: quiet.running });
  if (!quiet.next) return t("bots.panel.idle");
  const at = new Date(quiet.next.at);
  const today = at.toDateString() === new Date(now).toDateString();
  const tomorrow = at.toDateString() === new Date(now + 24 * 60 * 60 * 1000).toDateString();
  const time = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  let when = formatBotWaitTime(quiet.next.at, now);
  if (today) when = time;
  else if (tomorrow) when = t("bots.panel.tomorrowAt", { time });
  return t("bots.panel.idleNext", { when, name: quiet.next.name });
}

export function BotPanelHeader({
  serverId,
  bot,
  live,
  now,
}: {
  serverId: string;
  bot: Bot;
  live: BotLiveState;
  now: number;
}) {
  const { t } = useTranslation();
  const automations = useBotsRead(
    serverId,
    "bots.automations.list.request",
    { botId: bot.id },
    { select: (payload) => payload.automations },
  );
  const quiet = useMemo(() => botQuietFacts(automations.data ?? [], now), [automations.data, now]);
  const quietLine = useQuietLine(quiet, now);
  const pause = useBotsMutation(serverId, "bots.pause.request");
  // The row line says Paused / need you / working first; otherwise what its automations do.
  const line = live.line.kind === "idle" ? quietLine : botRowLineText(live.line, t, now);
  const settingsLabel = t("bots.row.settings");
  const moreLabel = t("bots.panel.more");
  const openSettings = useCallback(
    () => useBotPanelStore.getState().openSettings(bot.id),
    [bot.id],
  );
  const togglePause = useCallback(
    () => pause.mutate({ botId: bot.id, paused: !bot.paused }),
    [pause, bot.id, bot.paused],
  );
  const openShare = useCallback(
    () => useBotPanelStore.getState().openSettings(bot.id, "share"),
    [bot.id],
  );
  const copyPath = useCallback(() => {
    if (bot.home) void copyToClipboard(bot.home);
  }, [bot.home]);
  return (
    <View style={styles.header} testID="bot-panel-header">
      <View style={styles.picture}>
        <BotAvatar bot={bot} serverId={serverId} size={28} radius={7} />
        {!bot.paused && (live.needsYou > 0 || live.working > 0 || quiet.running !== null) ? (
          <View
            style={[styles.state, live.needsYou > 0 ? styles.stateNeeds : styles.stateWorking]}
          />
        ) : null}
      </View>
      <View style={styles.names}>
        <Text style={styles.name} numberOfLines={1}>
          {bot.name}
        </Text>
        <Text style={styles.line} numberOfLines={1} testID="bot-panel-line">
          {line}
        </Text>
      </View>
      <BotItemsFilterButton serverId={serverId} bot={bot} />
      <Tooltip delayDuration={300}>
        <TooltipTrigger
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel={settingsLabel}
          onPress={openSettings}
          testID="bot-panel-settings"
        >
          <ThemedSettings size={16} uniProps={muted} />
        </TooltipTrigger>
        <TooltipContent side="bottom" align="center" offset={4}>
          <Text style={styles.tooltip}>{settingsLabel}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.iconButton}
          accessibilityRole="button"
          accessibilityLabel={moreLabel}
          testID="bot-panel-more"
        >
          <ThemedMore size={16} uniProps={muted} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={220}>
          <DropdownMenuItem leading={bot.paused ? PLAY_ICON : PAUSE_ICON} onSelect={togglePause}>
            {bot.paused ? t("bots.row.resume") : t("bots.row.pause")}
          </DropdownMenuItem>
          <DropdownMenuItem leading={SHARE_ICON} onSelect={openShare}>
            {t("bots.share.shareBot")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem leading={COPY_ICON} disabled={!bot.home} onSelect={copyPath}>
            {t("bots.row.copyPath")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  picture: { width: 28, height: 28 },
  state: {
    position: "absolute",
    right: -3,
    bottom: -3,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: theme.colors.surface0,
  },
  stateNeeds: { backgroundColor: theme.colors.palette.amber[500] },
  stateWorking: { backgroundColor: theme.colors.palette.amber[500] },
  names: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: theme.colors.foreground },
  line: { fontSize: 13, lineHeight: 18, color: theme.colors.foregroundMuted },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.popoverForeground },
}));
