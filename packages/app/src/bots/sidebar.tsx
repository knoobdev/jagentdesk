import { useCallback } from "react";
import { useGlobalSearchParams, router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { Bot, BotRoom } from "@jagentdesk/protocol/bots/types";
import { Button } from "@/components/ui/button";
import { useBots, useRooms } from "./queries";
import { buildBotsRoute } from "./model";
import { styles } from "./styles";
import { QueryNotice } from "./ui";
function BotRow({ serverId, bot, active }: { serverId: string; bot: Bot; active: boolean }) {
  const { t } = useTranslation();
  const style = [styles.navRow, active && styles.navActive];
  const open = useCallback(
    function open() {
      router.push(buildBotsRoute(serverId, { botId: bot.id }) as Href);
    },
    [serverId, bot],
  );
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      style={style}
      testID={`bots-nav-${bot.slug}`}
    >
      <Text style={styles.text} numberOfLines={1}>
        {bot.name}
      </Text>
      <Text style={styles.muted} numberOfLines={1}>
        {bot.paused ? t("bots.paused") : bot.identity}
      </Text>
    </Pressable>
  );
}
function RoomRow({ serverId, room, active }: { serverId: string; room: BotRoom; active: boolean }) {
  const { t } = useTranslation();
  const style = [styles.navRow, active && styles.navActive];
  const open = useCallback(
    function open() {
      router.push(buildBotsRoute(serverId, { roomId: room.id }) as Href);
    },
    [serverId, room],
  );
  return (
    <Pressable accessibilityRole="button" onPress={open} style={style}>
      <Text style={styles.text} numberOfLines={1}>
        {room.name}
      </Text>
      <Text style={styles.muted} numberOfLines={1}>
        {room.memberBotIds.length} {t("bots.members")}
      </Text>
    </Pressable>
  );
}
export function BotsSidebar({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const params = useGlobalSearchParams<{
    botId?: string;
    roomId?: string;
  }>();
  const bots = useBots(serverId);
  const rooms = useRooms(serverId);
  const createBot = useCallback(
    function createBot() {
      router.push(`${buildBotsRoute(serverId)}?create=bot` as Href);
    },
    [serverId],
  );
  const createRoom = useCallback(
    function createRoom() {
      router.push(`${buildBotsRoute(serverId)}?create=room` as Href);
    },
    [serverId],
  );
  return (
    <ScrollView
      style={styles.sidebar}
      contentContainerStyle={styles.sidebarBody}
      testID="bots-left-panel"
    >
      <View style={styles.between}>
        <Text style={styles.title}>{t("bots.title")}</Text>
        <Button size="sm" variant="ghost" onPress={createBot}>
          {t("bots.newBot")}
        </Button>
      </View>
      <QueryNotice query={bots} />
      {bots.data?.map((bot) => (
        <BotRow key={bot.id} serverId={serverId} bot={bot} active={params.botId === bot.id} />
      ))}
      <View style={styles.between}>
        <Text style={styles.title}>{t("bots.rooms")}</Text>
        <Button size="sm" variant="ghost" onPress={createRoom}>
          {t("bots.newRoom")}
        </Button>
      </View>
      <QueryNotice query={rooms} />
      {rooms.data?.map((room) => (
        <RoomRow key={room.id} serverId={serverId} room={room} active={params.roomId === room.id} />
      ))}
    </ScrollView>
  );
}
