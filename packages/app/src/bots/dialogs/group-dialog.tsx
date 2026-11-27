// New group / Manage members (spec 37.3.6). Ported from Orca dfdb4fda (MIT) src/renderer/src/components/
// bots/BotGroupMembersDialog.tsx:90-290 (name, members with "{{count}} picked", "Pick 2 or more bots",
// Delete group, Save / Create) and BotGroupReplyPicker.tsx:51-107 (who answers: one bot, "All bots",
// "Only when mentioned"). Groups are the daemon's rooms (`bots.rooms.save` with `replyMode`).
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react-native";
import type { Bot, BotGroupReplyMode } from "@jagentdesk/protocol/bots/types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { Theme } from "@/styles/theme";
import { BotAvatar } from "@/bots/avatar";
import { openBotRoom } from "@/bots/navigation";
import { botErrorMessage, useBots, useBotsMutation, useRooms } from "@/bots/queries";

const ThemedCheck = withUnistyles(Check);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });

type ReplyKey = "mentions" | "all" | `bot:${string}`;

function replyKey(mode: BotGroupReplyMode | undefined): ReplyKey {
  if (!mode || mode.kind === "mentions") return "mentions";
  return mode.kind === "all" ? "all" : `bot:${mode.botId}`;
}
function replyMode(key: ReplyKey): BotGroupReplyMode {
  if (key === "mentions" || key === "all") return { kind: key };
  return { kind: "bot", botId: key.slice("bot:".length) };
}

export function BotGroupDialog({
  serverId,
  roomId,
  onClose,
}: {
  serverId: string;
  roomId?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const bots = useBots(serverId);
  const rooms = useRooms(serverId);
  const room = rooms.data?.find((entry) => entry.id === roomId) ?? null;
  // Seeded once from the room it opened on: a background refetch never resets what was typed.
  const [name, setName] = useState(room?.name ?? "");
  const [members, setMembers] = useState<string[]>(room?.memberBotIds ?? []);
  const [reply, setReply] = useState<ReplyKey>(replyKey(room?.replyMode));
  const [submitted, setSubmitted] = useState(false);
  const save = useBotsMutation(serverId, "bots.rooms.save.request");
  const remove = useBotsMutation(serverId, "bots.rooms.delete.request");
  const list = bots.data ?? [];
  const tooFew = members.length < 2;
  const replyBot = reply.startsWith("bot:") ? reply.slice("bot:".length) : null;
  // The bot that answers must still be a member; else the group answers when mentioned.
  const shownReply: ReplyKey = replyBot && !members.includes(replyBot) ? "mentions" : reply;
  const toggle = useCallback((botId: string) => {
    setMembers((previous) =>
      previous.includes(botId) ? previous.filter((id) => id !== botId) : [...previous, botId],
    );
  }, []);
  const submit = useCallback(async () => {
    setSubmitted(true);
    if (tooFew || !name.trim()) return;
    try {
      const result = await save.mutateAsync({
        room: {
          id: room?.id,
          name: name.trim(),
          memberBotIds: members,
          replyMode: replyMode(shownReply),
        },
      });
      onClose();
      if (!room) openBotRoom(serverId, result.room.id);
    } catch {
      // Shown from the mutation's error.
    }
  }, [members, name, onClose, room, save, serverId, shownReply, tooFew]);
  const press = useCallback(() => void submit(), [submit]);
  const deleteGroup = useCallback(async () => {
    if (!room) return;
    const confirmed = await confirmDialog({
      title: t("bots.groups.deleteTitle", { name: room.name }),
      message: t("bots.groups.deleteDescription"),
      confirmLabel: t("bots.groups.deleteConfirm"),
      destructive: true,
    });
    if (!confirmed) return;
    remove.mutate({ roomId: room.id }, { onSuccess: onClose });
  }, [onClose, remove, room, t]);
  const pressDelete = useCallback(() => void deleteGroup(), [deleteGroup]);
  const header = useMemo(
    () => ({
      title: room ? t("bots.groups.manageMembers") : t("bots.groups.newGroup"),
      subtitle: t("bots.groups.dialogDescription"),
    }),
    [room, t],
  );
  let saveLabel = room ? t("bots.groups.save") : t("bots.groups.create");
  if (save.isPending) saveLabel = t("bots.groups.saving");
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {room ? (
          <Button variant="outline" size="sm" onPress={pressDelete} disabled={remove.isPending}>
            {t("bots.groups.deleteGroup")}
          </Button>
        ) : null}
        <View style={styles.grow} />
        <Button variant="ghost" size="sm" onPress={onClose}>
          {t("bots.groups.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={press}
          loading={save.isPending}
          disabled={save.isPending}
          testID="bot-group-save"
        >
          {saveLabel}
        </Button>
      </View>
    ),
    [onClose, press, pressDelete, remove.isPending, room, save.isPending, saveLabel, t],
  );
  const memberBots = list.filter((bot) => members.includes(bot.id));
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={480}
      testID="bot-group-dialog"
    >
      <View style={styles.body}>
        <Field
          label={t("bots.groups.name")}
          error={submitted && !name.trim() ? t("bots.groups.nameIt") : null}
        >
          <FormTextInput
            value={name}
            initialValue={name}
            webControlled
            onChangeText={setName}
            placeholder={t("bots.groups.namePlaceholder")}
            accessibilityLabel={t("bots.groups.name")}
            maxLength={100}
            size="sm"
            testID="bot-group-name"
          />
        </Field>
        <View style={styles.membersHeading}>
          <Text style={styles.label}>{t("bots.groups.members")}</Text>
          {members.length ? (
            <Text style={styles.muted}>{t("bots.groups.picked", { count: members.length })}</Text>
          ) : null}
        </View>
        <ScrollView style={styles.members}>
          {list.map((bot) => (
            <MemberRow
              key={bot.id}
              bot={bot}
              selected={members.includes(bot.id)}
              onToggle={toggle}
            />
          ))}
        </ScrollView>
        {submitted && tooFew ? (
          <Text style={styles.error} accessibilityRole="alert">
            {t("bots.groups.pickTwo")}
          </Text>
        ) : null}
        <Text style={styles.label}>{t("bots.groups.whoAnswers")}</Text>
        <View accessibilityRole="radiogroup" style={styles.replies}>
          {memberBots.map((bot) => (
            <ReplyRow
              key={bot.id}
              value={`bot:${bot.id}`}
              label={bot.name}
              bot={bot}
              selected={shownReply === `bot:${bot.id}`}
              onSelect={setReply}
            />
          ))}
          <ReplyRow
            value="all"
            label={t("bots.groups.allBots")}
            selected={shownReply === "all"}
            onSelect={setReply}
          />
          <ReplyRow
            value="mentions"
            label={t("bots.groups.onlyWhenMentioned")}
            selected={shownReply === "mentions"}
            onSelect={setReply}
          />
        </View>
        <MutationErrors errors={[save.error, remove.error]} />
      </View>
    </AdaptiveModalSheet>
  );
}

function MutationErrors({ errors }: { errors: readonly (Error | null)[] }) {
  return errors.map((error) =>
    error ? (
      <Text key={botErrorMessage(error)} style={styles.error} accessibilityRole="alert">
        {botErrorMessage(error)}
      </Text>
    ) : null,
  );
}

function MemberRow({
  bot,
  selected,
  onToggle,
}: {
  bot: Bot;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const press = useCallback(() => onToggle(bot.id), [bot.id, onToggle]);
  return (
    <Pressable
      onPress={press}
      accessibilityRole="checkbox"
      aria-checked={selected}
      style={[styles.row, selected && styles.rowSelected]}
      testID={`bot-group-member-${bot.id}`}
    >
      <BotAvatar bot={bot} size={20} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {bot.name}
      </Text>
      {selected ? <ThemedCheck size={16} uniProps={foreground} /> : null}
    </Pressable>
  );
}

function ReplyRow({
  value,
  label,
  bot,
  selected,
  onSelect,
}: {
  value: ReplyKey;
  label: string;
  bot?: Bot;
  selected: boolean;
  onSelect: (value: ReplyKey) => void;
}) {
  const press = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <Pressable
      onPress={press}
      accessibilityRole="radio"
      aria-checked={selected}
      style={styles.row}
      testID={`bot-group-reply-${value}`}
    >
      {bot ? <BotAvatar bot={bot} size={20} /> : null}
      <Text style={styles.rowLabel} numberOfLines={1}>
        {label}
      </Text>
      {selected ? <ThemedCheck size={16} uniProps={foreground} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: 12 },
  membersHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  muted: { fontSize: 12, color: theme.colors.foregroundMuted },
  members: { maxHeight: 240 },
  replies: { gap: 2 },
  row: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  rowSelected: { backgroundColor: theme.chrome.selectedRow },
  rowLabel: { flex: 1, fontSize: 14, color: theme.colors.foreground },
  error: { fontSize: 12, color: theme.colors.statusDanger },
  footer: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
}));
