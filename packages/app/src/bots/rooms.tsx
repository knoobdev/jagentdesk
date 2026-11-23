import { useCallback, useMemo } from "react";
import { useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Bot, BotRoom } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useBotsMutation, useBotsConnection } from "./queries";
import { styles } from "./styles";
import { RoomFormModel } from "./room-model";
import { Input, ErrorNotice } from "./ui";
import { Messages, MessageComposer } from "./chat";
function MemberOption({
  bot,
  selected,
  toggle,
}: {
  bot: Bot;
  selected: boolean;
  toggle: (id: string) => void;
}) {
  const press = useCallback(
    function press() {
      toggle(bot.id);
    },
    [toggle, bot],
  );
  return (
    <Button
      variant={selected ? "secondary" : "outline"}
      onPress={press}
      testID={`bot-room-member-${bot.slug}`}
    >
      {selected ? "✓ " : ""}
      {bot.name} · @{bot.slug}
    </Button>
  );
}
export function RoomSheet({
  serverId,
  bots,
  room,
  onClose,
  onSaved,
}: {
  serverId: string;
  bots: Bot[];
  room: BotRoom | null;
  onClose: () => void;
  onSaved: (room: BotRoom) => void;
}) {
  const { t } = useTranslation();
  const [model] = useState(() => new RoomFormModel(room));
  const draft = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const save = useBotsMutation(serverId, "bots.rooms.save.request");
  const header = useMemo(() => ({ title: t("bots.rooms") }), [t]);
  const submit = useCallback(
    function submit() {
      save.mutate(
        { room: { id: room?.id, name: draft.name.trim(), memberBotIds: draft.memberBotIds } },
        { onSuccess: (result) => onSaved(result.room) },
      );
    },
    [save, room, draft, onSaved],
  );
  const setName = useCallback(
    function setName(name: string) {
      model.setName(name);
    },
    [model],
  );
  const toggle = useCallback(
    function toggle(id: string) {
      model.toggleMember(id);
    },
    [model],
  );
  return (
    <AdaptiveModalSheet visible onClose={onClose} onDismiss={onClose} header={header}>
      <ScrollView contentContainerStyle={styles.body}>
        <Input
          label={t("bots.roomName")}
          value={draft.name}
          onChange={setName}
          testID="bot-room-name"
        />
        <Text style={styles.title}>{t("bots.members")}</Text>
        {bots.map((bot) => (
          <MemberOption
            key={bot.id}
            bot={bot}
            selected={draft.memberBotIds.includes(bot.id)}
            toggle={toggle}
          />
        ))}
        <ErrorNotice error={save.error} />
        <Button
          onPress={submit}
          disabled={save.isPending || !draft.name.trim()}
          loading={save.isPending}
          testID="bot-room-save"
        >
          {t("bots.save")}
        </Button>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}
export function RoomChat({
  serverId,
  room,
  bots,
  onDeleted,
}: {
  serverId: string;
  room: BotRoom;
  bots: Bot[];
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const { enabled } = useBotsConnection(serverId);
  const send = useBotsMutation(serverId, "bots.rooms.send.request");
  const remove = useBotsMutation(serverId, "bots.rooms.delete.request");
  const members = bots.filter((bot) => room.memberBotIds.includes(bot.id));
  const deleteRoom = useCallback(
    async function deleteRoom() {
      if (
        await confirmDialog({ title: t("bots.deleteRoom"), message: room.name, destructive: true })
      )
        remove.mutate({ roomId: room.id }, { onSuccess: onDeleted });
    },
    [t, room, remove, onDeleted],
  );
  const openMembers = useCallback(
    function openMembers() {
      setEditing(true);
    },
    [setEditing],
  );
  const closeMembers = useCallback(
    function closeMembers() {
      setEditing(false);
    },
    [setEditing],
  );
  const sendMessage = useCallback(
    function sendMessage(text: string) {
      return send.mutateAsync({ roomId: room.id, text });
    },
    [send, room],
  );
  return (
    <View style={styles.column} testID="bots-room">
      <View style={styles.body}>
        <Text style={styles.muted}>
          {members.map((bot) => `${bot.name} (@${bot.slug})`).join(", ")}
        </Text>
        <View style={styles.row}>
          <Button size="sm" variant="outline" onPress={openMembers}>
            {t("bots.members")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={remove.isPending}
            loading={remove.isPending}
            onPress={deleteRoom}
          >
            {t("bots.delete")}
          </Button>
        </View>
        <ErrorNotice error={remove.error} />
      </View>
      <Messages messages={room.messages} bots={bots} />
      <MessageComposer
        pending={send.isPending}
        error={send.error}
        send={sendMessage}
        hint={t("bots.mention")}
        disabled={!enabled}
      />
      {editing ? (
        <RoomSheet
          serverId={serverId}
          bots={bots}
          room={room}
          onClose={closeMembers}
          onSaved={closeMembers}
        />
      ) : null}
    </View>
  );
}
