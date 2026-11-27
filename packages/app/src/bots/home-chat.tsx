// The bot page's centre (spec 37.4.2): a Home Chat tab that is always there and never closes
// (Orca dfdb4fda (MIT) src/renderer/src/components/bots/BotHomeChat.tsx:10-37 — the daemon makes the
// chat again when it is gone), a tab for a home file the Files tab opened, the first-run screen until
// the owner's first turn ends, the Home Chat timeline, its cards, and the composer.
import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { X } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FilePanelView } from "@/file-panels/view";
import { AgentTimeline, MessageComposer } from "./chat";
import { BotAvatar } from "./avatar";
import { useBotsConnection, useBotsMutation } from "./queries";
import { useBotPanel, useBotPanelStore } from "./panel-store";
import { useHomeChatFocus } from "./home-chat-draft";
import { BotFirstScreen } from "./first-screen";
import { BotHomeChatCards } from "./chat-cards/home-chat-cards";

const ThemedX = withUnistyles(X);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || path;
}

export function BotCentreTabs({ bot }: { bot: Bot }) {
  const { t } = useTranslation();
  const panel = useBotPanel(bot.id);
  const showHome = useCallback(
    () => useBotPanelStore.getState().setOpenFile(bot.id, null),
    [bot.id],
  );
  const closeFile = showHome;
  const homeActive = panel.openFile === null;
  const homeState = useMemo(() => ({ selected: homeActive }), [homeActive]);
  const homeTabStyle = useMemo(() => [styles.tab, homeActive && styles.tabActive], [homeActive]);
  const homeTextStyle = useMemo(
    () => [styles.tabText, homeActive && styles.tabTextActive],
    [homeActive],
  );
  return (
    <View style={styles.tabs} accessibilityRole="tablist" testID="bot-centre-tabs">
      <Tooltip delayDuration={500}>
        <TooltipTrigger
          onPress={showHome}
          style={homeTabStyle}
          accessibilityRole="tab"
          accessibilityState={homeState}
          testID="bot-home-chat-tab"
        >
          <Text style={homeTextStyle}>{t("bots.chats.home")}</Text>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" offset={6} maxWidth={320}>
          <Text style={styles.tooltip} testID="bot-home-chat-tooltip">
            {t("bots.tabs.homeDetail")}
          </Text>
        </TooltipContent>
      </Tooltip>
      {panel.openFile ? (
        <View style={[styles.tab, styles.tabActive]} accessibilityRole="tab">
          <Text style={[styles.tabText, styles.tabTextActive]} numberOfLines={1}>
            {basename(panel.openFile)}
          </Text>
          <Pressable
            onPress={closeFile}
            accessibilityRole="button"
            accessibilityLabel={t("bots.jad.close")}
            style={styles.close}
          >
            <ThemedX size={14} uniProps={muted} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

export function BotHomeChat({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const panel = useBotPanel(bot.id);
  const { enabled } = useBotsConnection(serverId);
  const send = useBotsMutation(serverId, "bots.chat.send.request");
  const focusRequest = useHomeChatFocus((state) => state.requests[bot.id] ?? 0);
  const sendMessage = useCallback(
    (text: string) => send.mutateAsync({ botId: bot.id, text }),
    [send, bot.id],
  );
  const homeAgentId = bot.homeAgentId ?? bot.agentId;
  const location = useMemo(
    () => (panel.openFile ? { path: panel.openFile } : null),
    [panel.openFile],
  );
  if (location && bot.home)
    return (
      <View style={styles.column}>
        <FilePanelView
          serverId={serverId}
          workspaceRoot={bot.home}
          location={location}
          navigationRevision={0}
        />
      </View>
    );
  // `bot-chat-persona.tsx`: an empty Home Chat greets as the bot — picture, name, the Orca line.
  // A new bot greets this way under its first-run screen even once its Home Chat agent exists.
  const persona =
    homeAgentId && !bot.firstRun ? null : (
      <View style={styles.empty}>
        <BotAvatar bot={bot} serverId={serverId} size={56} radius={14} />
        <Text style={styles.personaName}>{bot.name}</Text>
        <Text style={styles.emptyText} testID="bot-home-chat-empty">
          {t("bots.chat.emptySubtitle", { name: bot.name })}
        </Text>
      </View>
    );
  let conversation;
  // `NativeChatBotHomeScope.tsx`: the first-run screen leads until the owner's first turn ends.
  if (bot.firstRun)
    conversation = (
      <ScrollView contentContainerStyle={styles.firstRun}>
        <BotFirstScreen serverId={serverId} bot={bot} />
        {persona}
      </ScrollView>
    );
  else if (homeAgentId) conversation = <AgentTimeline serverId={serverId} agentId={homeAgentId} />;
  else conversation = persona;
  return (
    <View style={styles.column} testID="bot-home-chat">
      {conversation}
      <BotHomeChatCards serverId={serverId} bot={bot} />
      <MessageComposer
        serverId={serverId}
        draftId={`bot:${bot.id}`}
        pending={send.isPending}
        error={send.error}
        send={sendMessage}
        hint={t("bots.chat.mentionPlaceholder")}
        disabled={!enabled}
        autoFocusKey={focusRequest > 0 ? String(focusRequest) : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  tabs: {
    height: 40,
    flexDirection: "row",
    alignItems: "stretch",
    gap: 4,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    maxWidth: 220,
    borderBottomWidth: 2,
    borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: theme.colors.foreground },
  tabText: { fontSize: 14, fontWeight: "500", color: theme.colors.foregroundMuted },
  tabTextActive: { color: theme.colors.foreground },
  close: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.popoverForeground },
  column: { flex: 1, minHeight: 0 },
  firstRun: { paddingHorizontal: 32, paddingVertical: 32 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8 },
  emptyText: { fontSize: 16, color: theme.colors.foregroundMuted, textAlign: "center" },
  personaName: { fontSize: 18, fontWeight: "600", color: theme.colors.foreground },
}));
