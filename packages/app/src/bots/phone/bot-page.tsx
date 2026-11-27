// The bot page on a phone (spec 37.6), and under 992 px on the desktop shell where the inspector is a
// full-screen sheet (as the workspace's, docs/mobile-panels.md): the Home Chat screen — first-run screen, timeline, the bot's
// cards (item notes, worker cards, worker approvals) and the composer — under the compact header that
// names the bot (`header.tsx`); the header's right button opens the bot panel sheet.
// Orca dfdb4fda (MIT) has no bot route on phones either: a bot is its home session
// (`mobile/app/h/[hostId]/session/[worktreeId].tsx`) plus `MobileSessionBotSheet.tsx`.
import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { BotAvatar } from "@/bots/avatar";
import { minuteNow, useBotLiveState } from "@/bots/bot-status";
import { BotCentreTabs, BotHomeChat } from "@/bots/home-chat";
import { useHomeChatFocus } from "@/bots/home-chat-draft";
import { useBotPanel } from "@/bots/panel-store";
import { closePhoneBotPanel, usePhoneBotPanel } from "./panel-store";
import { PhoneBotPanelSheet } from "./panel-sheet";
import { PhoneBotPanelButton } from "./header";

export function PhoneBotPage({
  serverId,
  bot,
  header = false,
}: {
  serverId: string;
  bot: Bot;
  /** A tablet width under the desktop shell has no compact header: the page heads itself. */
  header?: boolean;
}) {
  const now = minuteNow();
  const live = useBotLiveState(serverId, bot, now);
  const panel = useBotPanel(bot.id);
  // A page asked for from anywhere (an item chip in the chat, "Bot settings…", a Settings link to
  // Connectors) opens the sheet on it, as `MobileSessionBotSheet.tsx` opens `botPanel`.
  const asksPage = panel.view.kind !== "activity" || panel.tab === "connectors";
  useEffect(() => {
    if (asksPage) usePhoneBotPanel.getState().open(bot.id);
  }, [asksPage, panel.view, bot.id]);
  // "New automation" and "Change in chat" write the Home Chat's draft: the chat comes back up.
  const focus = useHomeChatFocus((state) => state.requests[bot.id] ?? 0);
  const seenFocus = useRef(focus);
  useEffect(() => {
    if (focus === seenFocus.current) return;
    seenFocus.current = focus;
    closePhoneBotPanel(bot.id);
  }, [focus, bot.id]);
  // Leaving the page leaves its panel too.
  useEffect(
    () => () => {
      if (usePhoneBotPanel.getState().openBotId === bot.id) closePhoneBotPanel(bot.id);
    },
    [bot.id],
  );
  return (
    <View style={styles.screen} testID="bot-page">
      {header ? (
        <View style={styles.header} testID="bot-page-header">
          <BotAvatar bot={bot} serverId={serverId} size={16} radius={4} />
          <Text style={styles.title} numberOfLines={1}>
            {bot.name}
          </Text>
          <PhoneBotPanelButton serverId={serverId} bot={bot} buttonStyle={styles.button} />
        </View>
      ) : null}
      {panel.openFile ? <BotCentreTabs bot={bot} /> : null}
      <BotHomeChat serverId={serverId} bot={bot} />
      <PhoneBotPanelSheet serverId={serverId} bot={bot} live={live} />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
  // The desktop page's header (spec 38.4.4): 64 px, the bot's mascot and name, 18/600.
  header: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 20,
    paddingRight: 10,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: { flex: 1, fontSize: 18, fontWeight: "600", color: theme.colors.foreground },
  button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
}));
