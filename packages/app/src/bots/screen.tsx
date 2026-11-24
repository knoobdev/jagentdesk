import Animated from "react-native-reanimated";
import { isNative } from "@/constants/platform";
import { useKeyboardShiftStyle } from "@/hooks/use-keyboard-shift-style";
import { useCallback, useMemo } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLocalSearchParams, router, type Href } from "expo-router";
import { Bot as BotIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { Bot, BotInput, BotRoom } from "@jagentdesk/protocol/bots/types";
import { PageHeader } from "@/components/headers/page-header";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { confirmDialog } from "@/utils/confirm-dialog";
import {
  useBots,
  useRooms,
  useBotsPushes,
  useBotsConnection,
  useBotsMutation,
  useItems,
} from "./queries";
import { buildBotsRoute } from "./model";
import { styles } from "./styles";
import { QueryNotice, ErrorNotice } from "./ui";
import { CreateBotSheet, BotForm } from "./bot-form";
import { BotChat } from "./chat";
import { BotItems, WorkerPermissions } from "./items";
import { HomeFiles } from "./home-files";
import { BotSchedules } from "./schedules";
import { RoomSheet, RoomChat } from "./rooms";
type BotTab = "chat" | "items" | "soulMemory" | "schedules" | "settings";
const tabs: BotTab[] = ["chat", "items", "soulMemory", "schedules", "settings"];
function BotSettings({
  serverId,
  bot,
  onDeleted,
}: {
  serverId: string;
  bot: Bot;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const save = useBotsMutation(serverId, "bots.update.request");
  const pause = useBotsMutation(serverId, "bots.pause.request");
  const remove = useBotsMutation(serverId, "bots.delete.request");
  const deleteBot = useCallback(
    async function deleteBot() {
      if (
        await confirmDialog({
          title: t("bots.deleteTitle"),
          message: t("bots.deleteHint"),
          destructive: true,
          confirmLabel: t("bots.delete"),
        })
      )
        remove.mutate({ botId: bot.id }, { onSuccess: onDeleted });
    },
    [t, remove, bot, onDeleted],
  );
  const saveBot = useCallback(
    function saveBot(input: BotInput) {
      const { slug: _slug, ...patch } = input;
      return save.mutateAsync({ botId: bot.id, patch });
    },
    [save, bot],
  );
  const togglePause = useCallback(
    function togglePause() {
      pause.mutate({ botId: bot.id, paused: !bot.paused });
    },
    [pause, bot],
  );
  return (
    <ScrollView>
      <BotForm
        key={bot.id}
        serverId={serverId}
        bot={bot}
        save={saveBot}
        pending={save.isPending}
        error={save.error}
      />
      <View style={styles.body}>
        <Button
          variant="outline"
          onPress={togglePause}
          disabled={pause.isPending}
          loading={pause.isPending}
          testID="bot-pause"
        >
          {t(bot.paused ? "bots.resume" : "bots.pause")}
        </Button>
        <ErrorNotice error={pause.error} />
        <Button
          variant="destructive"
          onPress={deleteBot}
          disabled={remove.isPending}
          loading={remove.isPending}
        >
          {t("bots.delete")}
        </Button>
        <ErrorNotice error={remove.error} />
      </View>
    </ScrollView>
  );
}
function TabButton({
  value,
  selected,
  count,
  select,
}: {
  value: BotTab;
  selected: boolean;
  count: number;
  select: (value: BotTab) => void;
}) {
  const { t } = useTranslation();
  const press = useCallback(
    function press() {
      select(value);
    },
    [select, value],
  );
  return (
    <Button
      size="sm"
      variant={selected ? "secondary" : "ghost"}
      onPress={press}
      testID={`bot-tab-${value}`}
    >
      {t(`bots.${value}`)}
      {value === "items" && count > 0 ? ` (${count})` : ""}
    </Button>
  );
}
function BotView({ serverId, bot, onBack }: { serverId: string; bot: Bot; onBack: () => void }) {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab = tabs.find((value) => value === params.tab) ?? "chat";
  const setTab = useCallback((value: BotTab) => router.setParams({ tab: value }), []);
  const items = useItems(serverId, bot.id);
  const { connected } = useBotsConnection(serverId);
  const needsYou = items.data?.filter((item) => item.status === "needs_you").length ?? 0;
  const actions = useMemo(
    () => (
      <Button size="sm" variant="ghost" onPress={onBack}>
        {t("bots.back")}
      </Button>
    ),
    [onBack, t],
  );
  let body;
  switch (tab) {
    case "items":
      body = <BotItems serverId={serverId} botId={bot.id} />;
      break;
    case "soulMemory":
      body = <HomeFiles serverId={serverId} bot={bot} />;
      break;
    case "schedules":
      body = <BotSchedules serverId={serverId} botId={bot.id} />;
      break;
    case "settings":
      body = <BotSettings serverId={serverId} bot={bot} onDeleted={onBack} />;
      break;
    default:
      body = <BotChat serverId={serverId} bot={bot} />;
  }
  return (
    <View style={styles.screen}>
      <PageHeader icon={BotIcon} title={bot.name} description={bot.identity} actions={actions} />
      {!connected ? <Alert title={t("bots.offline")} /> : null}
      {bot.paused ? <Alert title={t("bots.paused")} /> : null}
      <View>
        <ScrollView horizontal contentContainerStyle={styles.tabs}>
          {tabs.map((value) => (
            <TabButton
              key={value}
              value={value}
              selected={tab === value}
              count={needsYou}
              select={setTab}
            />
          ))}
        </ScrollView>
      </View>
      <WorkerPermissions
        serverId={serverId}
        bot={bot}
        items={items.data ?? []}
        includeSupervisor={tab !== "chat"}
      />
      {body}
    </View>
  );
}
export function BotsScreen() {
  const serverId = useHostRouteServerId();
  const { style } = useKeyboardShiftStyle({ mode: "padding", enabled: isNative });
  const containerStyle = useMemo(() => [styles.screen, style], [style]);
  return (
    <Animated.View style={containerStyle}>
      {serverId ? <HostBotsScreen serverId={serverId} /> : null}
    </Animated.View>
  );
}
function BotCard({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const open = useCallback(
    function open() {
      router.push(buildBotsRoute(serverId, { botId: bot.id }) as Href);
    },
    [serverId, bot],
  );
  return (
    <Button variant="outline" onPress={open} testID={`bot-open-${bot.slug}`}>
      {bot.name} · {bot.paused ? t("bots.paused") : bot.identity}
    </Button>
  );
}
function RoomCard({ serverId, room }: { serverId: string; room: BotRoom }) {
  const open = useCallback(
    function open() {
      router.push(buildBotsRoute(serverId, { roomId: room.id }) as Href);
    },
    [serverId, room],
  );
  return (
    <Button variant="outline" onPress={open}>
      {room.name}
    </Button>
  );
}
function MissingBotTarget({
  requested,
  botsReady,
  roomsReady,
}: {
  requested: boolean;
  botsReady: boolean;
  roomsReady: boolean;
}) {
  const { t } = useTranslation();
  if (!requested || !botsReady || !roomsReady) return null;
  return <Alert title={t("bots.missing")} />;
}
function HostBotsScreen({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{
    botId?: string;
    roomId?: string;
    create?: string;
  }>();
  const bots = useBots(serverId);
  const rooms = useRooms(serverId);
  const connection = useBotsConnection(serverId);
  useBotsPushes(serverId);
  const back = useCallback(
    function back() {
      router.push(buildBotsRoute(serverId) as Href);
    },
    [serverId],
  );
  const closeSheet = useCallback(function closeSheet() {
    router.setParams({ create: undefined });
  }, []);
  const createdBot = useCallback(
    function createdBot(bot: Bot) {
      router.replace(buildBotsRoute(serverId, { botId: bot.id }) as Href);
    },
    [serverId],
  );
  const createdRoom = useCallback(
    function createdRoom(room: BotRoom) {
      router.replace(buildBotsRoute(serverId, { roomId: room.id }) as Href);
    },
    [serverId],
  );
  const newBot = useCallback(function newBot() {
    router.setParams({ create: "bot" });
  }, []);
  const newRoom = useCallback(function newRoom() {
    router.setParams({ create: "room" });
  }, []);
  const bot = bots.data?.find((entry) => entry.id === params.botId);
  const room = rooms.data?.find((entry) => entry.id === params.roomId);
  const createSheet =
    params.create === "bot" ? (
      <CreateBotSheet serverId={serverId} onClose={closeSheet} onCreated={createdBot} />
    ) : null;
  const roomSheet =
    params.create === "room" ? (
      <RoomSheet
        serverId={serverId}
        bots={bots.data ?? []}
        room={null}
        onClose={closeSheet}
        onSaved={createdRoom}
      />
    ) : null;
  const actions = useMemo(
    () => (
      <Button size="sm" onPress={newBot} testID="bots-create">
        {t("bots.newBot")}
      </Button>
    ),
    [newBot, t],
  );
  const roomActions = useMemo(
    () => (
      <Button size="sm" variant="ghost" onPress={back}>
        {t("bots.back")}
      </Button>
    ),
    [back, t],
  );
  if (!connection.connected && !bots.data)
    return (
      <View style={styles.body}>
        <Alert title={t("bots.offline")} />
      </View>
    );
  if (!connection.supported && !bots.data)
    return (
      <View style={styles.body}>
        <Alert title={t("bots.unsupported")} />
      </View>
    );
  if (bot)
    return (
      <>
        <BotView key={bot.id} serverId={serverId} bot={bot} onBack={back} />
        {createSheet}
        {roomSheet}
      </>
    );
  if (room)
    return (
      <View style={styles.screen}>
        <PageHeader
          icon={BotIcon}
          title={room.name}
          description={t("bots.mention")}
          actions={roomActions}
        />
        {!connection.connected ? <Alert title={t("bots.offline")} /> : null}
        <RoomChat
          key={room.id}
          serverId={serverId}
          room={room}
          bots={bots.data ?? []}
          onDeleted={back}
        />
        {createSheet}
        {roomSheet}
      </View>
    );
  const requestedTarget = Boolean(params.botId || params.roomId);
  return (
    <View style={styles.screen} testID="bots-screen">
      <PageHeader
        icon={BotIcon}
        title={t("bots.title")}
        description={t("bots.description")}
        actions={actions}
      />
      <ScrollView contentContainerStyle={styles.body}>
        {!connection.connected ? <Alert title={t("bots.offline")} /> : null}
        <QueryNotice query={bots} />
        <QueryNotice query={rooms} />
        <MissingBotTarget
          requested={requestedTarget}
          botsReady={bots.isSuccess}
          roomsReady={rooms.isSuccess}
        />
        {bots.isSuccess && bots.data.length === 0 ? (
          <View style={styles.card}>
            <Text style={styles.title}>{t("bots.empty")}</Text>
            <Text style={styles.muted}>{t("bots.emptyHint")}</Text>
          </View>
        ) : null}
        {bots.data?.map((entry) => (
          <BotCard key={entry.id} serverId={serverId} bot={entry} />
        ))}
        <View style={styles.between}>
          <Text style={styles.title}>{t("bots.rooms")}</Text>
          <Button size="sm" variant="outline" onPress={newRoom} testID="bots-new-room">
            {t("bots.newRoom")}
          </Button>
        </View>
        {rooms.data?.map((entry) => (
          <RoomCard key={entry.id} serverId={serverId} room={entry} />
        ))}
      </ScrollView>
      {createSheet}
      {roomSheet}
    </View>
  );
}
