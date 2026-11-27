// The bot page (spec 37.4.2-37.4.3): the bot's Home Chat in the centre, its inspector on the right.
// Orca opens a bot as the workspace of its home folder; JAgentDesk keeps the route
// `/h/<serverId>/bots?botId=<id>` and lays the same parts out itself. Round-1 links
// (`?botId=…&tab=items|soulMemory|schedules|settings`, `&itemId=…`) land on the matching panel.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { router, useLocalSearchParams, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PanelRight } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/headers/page-header";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { GUMLOOP_INSPECTOR_WIDTH } from "@/components/gumloop-shell/sidebar-state";
import { Bot as BotIcon } from "lucide-react-native";
import { BotAvatar } from "./avatar";
import { minuteNow, useBotLiveState } from "./bot-status";
import { useBots, useBotsConnection, useBotsPushes, useRooms } from "./queries";
import { buildBotsRoute } from "./model";
import { applyBotPanelTarget, legacyBotTarget } from "./navigation";
import { useBotPanelStore } from "./panel-store";
import { BotCentreTabs, BotHomeChat } from "./home-chat";
import { BotRightPanel } from "./panel/right-panel";
import { RoomChat } from "./rooms";
import { openBotsDialog } from "./dialogs-store";
import { Button } from "@/components/ui/button";

const ThemedPanelRight = withUnistyles(PanelRight);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function BotsScreen() {
  const serverId = useHostRouteServerId();
  return serverId ? <HostBotsScreen serverId={serverId} /> : null;
}

function HostBotsScreen({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{
    botId?: string;
    roomId?: string;
    itemId?: string;
    tab?: string;
  }>();
  const connection = useBotsConnection(serverId);
  useBotsPushes(serverId);
  const bots = useBots(serverId);
  const rooms = useRooms(serverId);
  const bot = bots.data?.find((entry) => entry.id === params.botId) ?? null;
  const room = rooms.data?.find((entry) => entry.id === params.roomId) ?? null;
  // An old link's tab or item opens once, when the bot is there.
  const applied = useRef<string | null>(null);
  useEffect(() => {
    if (!bot) return;
    const key = `${bot.id}:${params.tab ?? ""}:${params.itemId ?? ""}`;
    if (applied.current === key) return;
    applied.current = key;
    applyBotPanelTarget(bot.id, legacyBotTarget(params));
  }, [bot, params]);
  // No bot named: open the first one, as Orca has no list page; none yet, the empty card.
  const first = bots.data?.[0];
  const backToBots = useCallback(
    () => router.replace(buildBotsRoute(serverId) as Href),
    [serverId],
  );
  const openNewBot = useCallback(() => openBotsDialog({ kind: "newBot", serverId }), [serverId]);
  const openTemplates = useCallback(
    () => openBotsDialog({ kind: "templates", serverId }),
    [serverId],
  );
  useEffect(() => {
    if (!params.botId && !params.roomId && first)
      router.replace(buildBotsRoute(serverId, { botId: first.id }) as Href);
  }, [params.botId, params.roomId, first, serverId]);

  if (!connection.connected && !bots.data) return <Notice text={t("bots.jad.offline")} />;
  if (connection.supported && !connection.orca) return <Notice text={t("bots.jad.unsupported")} />;
  if (room)
    return (
      <View style={styles.screen}>
        <PageHeader icon={BotIcon} title={room.name} description={t("bots.jad.mention")} />
        <RoomChat
          key={room.id}
          serverId={serverId}
          room={room}
          bots={bots.data ?? []}
          onDeleted={backToBots}
        />
      </View>
    );
  if (bot) return <BotPage key={bot.id} serverId={serverId} bot={bot} />;
  if ((params.botId || params.roomId) && bots.isSuccess && rooms.isSuccess)
    return <Notice text={t("bots.jad.missing")} />;
  if (bots.isSuccess && bots.data.length === 0)
    return (
      <View style={styles.screen} testID="bots-screen">
        <PageHeader icon={BotIcon} title={t("bots.section.title")} />
        <View style={styles.emptyPage}>
          <Text style={styles.emptyTitle}>{t("bots.section.emptyCardTitle")}</Text>
          <View style={styles.emptyActions}>
            <Button onPress={openNewBot}>{t("bots.section.newBot")}</Button>
            <Button variant="outline" onPress={openTemplates}>
              {t("bots.section.emptyTemplates")}
            </Button>
          </View>
        </View>
      </View>
    );
  return null;
}

function Notice({ text }: { text: string }) {
  return (
    <View style={styles.notice}>
      <Alert title={text} />
    </View>
  );
}

function BotPage({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const now = minuteNow();
  const live = useBotLiveState(serverId, bot, now);
  // Desktop keeps the inspector open across bots; a phone opens it over the chat on demand.
  const desktopOpen = useBotPanelStore((state) => state.inspectorOpen);
  const [compactOpen, setCompactOpen] = useState(false);
  const inspectorOpen = compact ? compactOpen : desktopOpen;
  const toggleInspector = useCallback(() => {
    if (compact) setCompactOpen((open) => !open);
    else useBotPanelStore.getState().setInspectorOpen(!desktopOpen);
  }, [compact, desktopOpen]);
  const inspectorStyle = useMemo(
    () => [
      styles.inspector,
      compact ? styles.inspectorCompact : { width: GUMLOOP_INSPECTOR_WIDTH },
    ],
    [compact],
  );
  const panelLabel =
    live.needsYou > 0 ? t("bots.panel.showNeedYou", { count: live.needsYou }) : t("bots.items.tab");
  return (
    <View style={styles.screen} testID="bot-page">
      <View style={styles.centre}>
        <View style={styles.header} testID="bot-page-header">
          <BotAvatar bot={bot} serverId={serverId} size={16} radius={4} />
          <Text style={styles.title} numberOfLines={1}>
            {bot.name}
          </Text>
          <Pressable
            onPress={toggleInspector}
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel={panelLabel}
            testID="bot-page-toggle-panel"
          >
            <ThemedPanelRight size={18} uniProps={muted} />
          </Pressable>
        </View>
        <BotCentreTabs bot={bot} />
        <BotHomeChat serverId={serverId} bot={bot} />
      </View>
      {inspectorOpen ? (
        <View style={inspectorStyle}>
          {compact ? (
            <View style={styles.compactBar}>
              <Text style={styles.title} numberOfLines={1}>
                {bot.name}
              </Text>
              <Pressable
                onPress={toggleInspector}
                style={styles.iconButton}
                accessibilityRole="button"
                accessibilityLabel={t("bots.jad.close")}
              >
                <ThemedPanelRight size={18} uniProps={muted} />
              </Pressable>
            </View>
          ) : null}
          <BotRightPanel serverId={serverId} bot={bot} live={live} now={now} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  screen: { flex: 1, minHeight: 0, flexDirection: "row", backgroundColor: theme.colors.surface0 },
  centre: { flex: 1, minWidth: 0, minHeight: 0 },
  // 64 px, the agent title left-aligned 18/600 (spec 38.4.4), here the bot's name and mascot.
  header: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: { flex: 1, fontSize: 18, fontWeight: "600", color: theme.colors.foreground },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  inspector: {
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  inspectorCompact: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  compactBar: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  notice: { padding: 32 },
  emptyPage: { paddingHorizontal: 32, paddingTop: 16, gap: 12 },
  emptyTitle: { fontSize: 16, fontWeight: "600", color: theme.colors.foreground },
  emptyActions: { flexDirection: "row", gap: 8 },
}));
