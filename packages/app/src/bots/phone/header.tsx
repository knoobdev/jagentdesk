// The compact header on a bot's page (spec 37.6, 38.5): the title is the bot's mascot and name (a
// group's name in a group), and the right action opens the bot panel sheet, its Needs you count on
// it as on Orca's Items tab (`MobileBotPanelHeader.tsx:26-41`). With no bot open the action is
// "New bot", as the drawer's `+`.
import { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PanelRight, Plus } from "lucide-react-native";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { Theme } from "@/styles/theme";
import { BotAvatar } from "@/bots/avatar";
import { minuteNow, useBotLiveState } from "@/bots/bot-status";
import { openBotsDialog } from "@/bots/dialogs-store";
import { useBot, useRooms } from "@/bots/queries";
import { usePhoneBotPanel } from "./panel-store";

const ThemedPanelRight = withUnistyles(PanelRight);
const ThemedPlus = withUnistyles(Plus);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

const BOTS_ROUTE = /^\/h\/([^/]+)\/bots(?:\/|$)/;

export interface BotsRouteTarget {
  serverId: string;
  botId: string | null;
  roomId: string | null;
}

/** `/h/<serverId>/bots?botId=…|roomId=…`; null on any other route. */
export function useBotsRouteTarget(): BotsRouteTarget | null {
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ botId?: string; roomId?: string }>();
  const match = BOTS_ROUTE.exec(pathname);
  const serverId = match?.[1] ? decodeURIComponent(match[1]) : null;
  return useMemo(
    () =>
      serverId ? { serverId, botId: params.botId ?? null, roomId: params.roomId ?? null } : null,
    [serverId, params.botId, params.roomId],
  );
}

/** The bots route's title; any other route keeps the header's own (`children`). */
export function PhoneBotsHeaderTitle({
  target,
  children,
}: {
  target: BotsRouteTarget | null;
  children: ReactNode;
}) {
  if (!target) return children;
  return <BotsTitle target={target} />;
}

function BotsTitle({ target }: { target: BotsRouteTarget }) {
  const { t } = useTranslation();
  const bot = useBot(target.serverId, target.botId);
  const rooms = useRooms(target.serverId);
  const room = target.roomId ? rooms.data?.find((entry) => entry.id === target.roomId) : null;
  if (bot)
    return (
      <View style={styles.title} testID="compact-header-title">
        <BotAvatar bot={bot} serverId={target.serverId} size={20} radius={5} />
        <Text style={styles.titleText} numberOfLines={1}>
          {bot.name}
        </Text>
      </View>
    );
  return (
    <View style={styles.title} testID="compact-header-title">
      <Text style={styles.titleText} numberOfLines={1}>
        {room?.name ?? t("bots.section.title")}
      </Text>
    </View>
  );
}

/** The bots route's right action; any other route keeps the header's own (`children`). */
export function PhoneBotsHeaderAction({
  target,
  buttonStyle,
  children,
}: {
  target: BotsRouteTarget | null;
  buttonStyle: object;
  children: ReactNode;
}) {
  if (!target) return children;
  return <BotsAction target={target} buttonStyle={buttonStyle} />;
}

function BotsAction({ target, buttonStyle }: { target: BotsRouteTarget; buttonStyle: object }) {
  const bot = useBot(target.serverId, target.botId);
  if (bot)
    return <PhoneBotPanelButton serverId={target.serverId} bot={bot} buttonStyle={buttonStyle} />;
  if (target.roomId) return <View style={buttonStyle} />;
  return <NewBotButton serverId={target.serverId} buttonStyle={buttonStyle} />;
}

/** Opens the bot panel sheet; the Needs you count on its corner. */
export function PhoneBotPanelButton({
  serverId,
  bot,
  buttonStyle,
}: {
  serverId: string;
  bot: Bot;
  buttonStyle: object;
}) {
  const { t } = useTranslation();
  const live = useBotLiveState(serverId, bot, minuteNow());
  const open = useCallback(() => usePhoneBotPanel.getState().open(bot.id), [bot.id]);
  const label =
    live.needsYou > 0
      ? t("bots.phone.bots.panel.itemsNeedYou", { count: live.needsYou })
      : t("bots.phone.bots.items.tab");
  return (
    <Pressable
      onPress={open}
      style={buttonStyle}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID="phone-bot-open-panel"
    >
      <ThemedPanelRight size={22} uniProps={foreground} />
      {live.needsYou > 0 ? (
        <View style={styles.badge} testID="phone-bot-open-panel-badge">
          <Text style={styles.badgeText}>{live.needsYou}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function NewBotButton({ serverId, buttonStyle }: { serverId: string; buttonStyle: object }) {
  const { t } = useTranslation();
  const open = useCallback(() => openBotsDialog({ kind: "newBot", serverId }), [serverId]);
  return (
    <Pressable
      onPress={open}
      style={buttonStyle}
      accessibilityRole="button"
      accessibilityLabel={t("bots.phone.bots.new.title")}
      testID="phone-bots-new"
    >
      <ThemedPlus size={22} uniProps={foreground} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  title: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  titleText: { flexShrink: 1, fontSize: 17, fontWeight: "600", color: theme.colors.foreground },
  // The status chip pair (spec 38.4.6), `statusWarning`, on the button's corner.
  badge: {
    position: "absolute",
    top: 4,
    right: 2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.statusWarningBackground,
  },
  badgeText: { fontSize: 11, fontWeight: "600", color: theme.colors.statusWarning },
}));
