// The settings view's root (spec 37.4.8, order of Orca BotSettingsRoot.tsx:270-375): the bot's card
// (picture, name), Agent, Schedule (Claude/Codex only), Items, Soul and memory, Access, Sharing,
// Notifications, then "Delete bot…". Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/settings-view/BotSettingsRoot.tsx:1-380,
// BotItemsSettingsGroup.tsx:1-78, BotSharingPage.tsx:20-45,
// src/renderer/src/components/settings/bots/use-bot-notification-toggles.ts:1-45,
// src/renderer/src/components/bots/BotNameInlineEdit.tsx.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Brain,
  Eye,
  Hourglass,
  Link2,
  Moon,
  Plug,
  ShieldCheck,
  Smile,
  Users,
} from "lucide-react-native";
import {
  BOT_ITEM_DEFAULT_STALE_DAYS,
  BOT_NAME_MAX_LENGTH,
  botLookAround,
  lookAroundSupported,
} from "@jagentdesk/protocol/bots/rules";
import type { Bot, BotItemsStale, BotNotifications } from "@jagentdesk/protocol/bots/types";
import { BotAvatar } from "@/bots/avatar";
import { BotPicturePicker, type BotPictureValue } from "@/bots/dialogs/picture-picker";
import { useBotPanelStore, type BotSettingsPage } from "@/bots/panel-store";
import { botErrorMessage, useBotsMutation, useBotsRead } from "@/bots/queries";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useOptionalToast } from "@/contexts/toast-api-context";
import { AgentGroup } from "./agent-group";
import { useAllowedPeople, useBotOwnSkills } from "./access-pages";
import { useDeleteBot } from "./delete-bot";
import { BotSettingsGroup, BotSettingsRow } from "./rows";
import {
  countValue,
  ITEMS_STALE_CHOICES,
  lookAroundValue,
  tidyUpValue,
  type Translate,
} from "./row-states";

type Open = (page: BotSettingsPage) => void;

const CONNECTOR_KEYS = ["slack", "github", "gitlab", "telegram"] as const;

function staleLabel(choice: BotItemsStale, t: Translate): string {
  return choice === "never"
    ? t("bots.settingsView.itemsStale.never")
    : t("bots.settingsView.itemsStale.days", { days: choice });
}

function BotCard({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const update = useBotsMutation(serverId, "bots.update.request");
  const [picking, setPicking] = useState(false);
  const [name, setName] = useState(bot.name);
  useEffect(() => setName(bot.name), [bot.name]);
  const report = useCallback((error: unknown) => toast?.error(botErrorMessage(error)), [toast]);
  const saveName = useCallback(() => {
    const next = name.trim();
    if (!next || next === bot.name) {
      setName(bot.name);
      return;
    }
    update.mutate({ botId: bot.id, patch: { name: next } }, { onError: report });
  }, [bot.id, bot.name, name, report, update]);
  const uploaded = Boolean(bot.avatar?.startsWith("upload:"));
  const shownUpload = useBotsRead(
    serverId,
    "bots.avatar.read.request",
    { botId: bot.id },
    { enabled: uploaded && picking, select: (payload) => payload.png },
  );
  const currentUpload = uploaded ? (shownUpload.data ?? null) : null;
  const picture = useMemo(
    () => ({
      // An uploaded picture's carousel opens on the first mascot behind it.
      avatar: uploaded ? "" : (bot.avatar ?? ""),
      avatarColor: bot.avatarColor ?? "",
      avatarOutfit: bot.avatarOutfit ?? null,
      upload: currentUpload,
    }),
    [bot.avatar, bot.avatarColor, bot.avatarOutfit, currentUpload, uploaded],
  );
  const uploadPicture = useBotsMutation(serverId, "bots.avatar.upload.request");
  const changePicture = useCallback(
    (next: BotPictureValue) => {
      if (next.upload) {
        if (next.upload !== currentUpload)
          uploadPicture.mutate({ botId: bot.id, png: next.upload }, { onError: report });
        return;
      }
      update.mutate(
        {
          botId: bot.id,
          patch: {
            ...(next.avatar ? { avatar: next.avatar } : {}),
            ...(next.avatarColor ? { avatarColor: next.avatarColor } : {}),
            avatarOutfit: next.avatarOutfit,
          },
        },
        { onError: report },
      );
    },
    [bot.id, currentUpload, report, update, uploadPicture],
  );
  const openPicker = useCallback(() => setPicking(true), []);
  const closePicker = useCallback(() => setPicking(false), []);
  return (
    <View style={styles.card}>
      <Pressable
        onPress={openPicker}
        accessibilityRole="button"
        accessibilityLabel={t("bots.settingsBots.editPicture")}
        testID="bot-settings-picture"
      >
        <BotAvatar bot={bot} serverId={serverId} size={32} radius={8} />
      </Pressable>
      <View style={styles.cardName}>
        <FormTextInput
          value={name}
          initialValue={bot.name}
          webControlled
          onChangeText={setName}
          onBlur={saveName}
          onSubmitEditing={saveName}
          maxLength={BOT_NAME_MAX_LENGTH}
          accessibilityLabel={t("bots.settingsView.name")}
          size="sm"
          testID="bot-settings-name"
        />
        {bot.share?.shared ? (
          <Text style={styles.muted}>{t("bots.share.isShared", { name: bot.name })}</Text>
        ) : null}
      </View>
      {picking ? (
        <BotPicturePicker value={picture} onChange={changePicture} onClose={closePicker} />
      ) : null}
    </View>
  );
}

function ScheduleGroup({ serverId, bot, open }: { serverId: string; bot: Bot; open: Open }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const update = useBotsMutation(serverId, "bots.update.request");
  const lookAround = botLookAround(bot);
  const tidyUp = bot.tidyUp ?? { on: true, every: "night" as const };
  const report = useCallback((error: unknown) => toast?.error(botErrorMessage(error)), [toast]);
  const toggleLook = useCallback(
    (on: boolean) =>
      update.mutate({ botId: bot.id, patch: { lookAround: { on } } }, { onError: report }),
    [bot.id, report, update],
  );
  const toggleTidy = useCallback(
    (on: boolean) =>
      update.mutate({ botId: bot.id, patch: { tidyUp: { on } } }, { onError: report }),
    [bot.id, report, update],
  );
  const lookTitle = t("bots.settingsBots.lookAround.title");
  const tidyTitle = t("bots.settingsBots.tidyUp.title");
  return (
    <BotSettingsGroup title={t("bots.settingsView.schedule")} testID="bot-settings-schedule">
      <BotSettingsRow
        icon={Eye}
        title={lookTitle}
        value={lookAroundValue(lookAround, t)}
        page="lookAround"
        onOpenPage={open}
      >
        <Switch
          value={lookAround.on}
          onValueChange={toggleLook}
          accessibilityLabel={lookTitle}
          testID="bot-settings-look-around-switch"
        />
      </BotSettingsRow>
      <BotSettingsRow
        icon={Moon}
        title={tidyTitle}
        value={tidyUpValue(tidyUp, t)}
        page="tidyUp"
        onOpenPage={open}
      >
        <Switch
          value={tidyUp.on}
          onValueChange={toggleTidy}
          accessibilityLabel={tidyTitle}
          testID="bot-settings-tidy-up-switch"
        />
      </BotSettingsRow>
    </BotSettingsGroup>
  );
}

function ItemsGroup({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const update = useBotsMutation(serverId, "bots.update.request");
  const value: BotItemsStale = bot.itemsStale ?? BOT_ITEM_DEFAULT_STALE_DAYS;
  const report = useCallback((error: unknown) => toast?.error(botErrorMessage(error)), [toast]);
  const options = useMemo(
    () =>
      ITEMS_STALE_CHOICES.map((choice) => ({
        id: String(choice),
        value: String(choice),
        label: staleLabel(choice, t),
      })),
    [t],
  );
  const display = useMemo(() => ({ label: staleLabel(value, t) }), [t, value]);
  const select = useCallback(
    (next: string, _display: SelectFieldDisplay) => {
      const choice = ITEMS_STALE_CHOICES.find((entry) => String(entry) === next);
      if (choice === undefined || choice === value) return;
      update.mutate({ botId: bot.id, patch: { itemsStale: choice } }, { onError: report });
    },
    [bot.id, report, update, value],
  );
  const toggleReview = useCallback(
    (on: boolean) =>
      update.mutate({ botId: bot.id, patch: { reviewBeforeDone: on } }, { onError: report }),
    [bot.id, report, update],
  );
  const reviewTitle = t("bots.jad.settings.reviewBeforeDone");
  return (
    <BotSettingsGroup title={t("bots.settingsView.items")} testID="bot-settings-items">
      <BotSettingsRow icon={Hourglass} title={t("bots.settingsView.itemsStale.shortTitle")}>
        <SelectField
          label={t("bots.settingsView.itemsStale.title")}
          field={false}
          value={String(value)}
          selectedDisplay={display}
          options={options}
          onChange={select}
          placeholder={display.label}
          emptyText=""
          size="sm"
          triggerTestID="bot-settings-stale-after"
        />
      </BotSettingsRow>
      <BotSettingsRow
        icon={ShieldCheck}
        title={reviewTitle}
        detail={t("bots.jad.settings.reviewBeforeDoneDescription")}
      >
        <Switch
          value={bot.reviewBeforeDone === true}
          onValueChange={toggleReview}
          accessibilityLabel={reviewTitle}
          testID="bot-settings-review-before-done"
        />
      </BotSettingsRow>
    </BotSettingsGroup>
  );
}

function SoulAndMemoryGroup({ open }: { open: Open }) {
  const { t } = useTranslation();
  return (
    <BotSettingsGroup
      title={t("bots.settingsView.soulAndMemory")}
      testID="bot-settings-soul-memory"
    >
      <BotSettingsRow
        icon={Smile}
        title={t("bots.settingsBots.soul")}
        page="soul"
        onOpenPage={open}
        testID="bot-settings-soul"
      />
      <BotSettingsRow
        icon={Brain}
        title={t("bots.settingsBots.memory")}
        page="memory"
        onOpenPage={open}
        testID="bot-settings-memory"
      />
    </BotSettingsGroup>
  );
}

function AccessGroup({ serverId, bot, open }: { serverId: string; bot: Bot; open: Open }) {
  const { t } = useTranslation();
  const people = useAllowedPeople(serverId, bot.id);
  const skills = useBotOwnSkills(serverId, bot);
  const connected = CONNECTOR_KEYS.filter((key) => bot[key]?.connected).length;
  const peopleCount = people.data?.length ?? 0;
  let whoCanAsk: string | null = null;
  if (people.data) {
    whoCanAsk =
      peopleCount > 0
        ? t("bots.settingsBots.connectorPeopleCount", { count: peopleCount })
        : t("bots.settingsBots.connectorOnlyYou");
  }
  const openConnectors = useCallback(
    () => useBotPanelStore.getState().setTab(bot.id, "connectors"),
    [bot.id],
  );
  return (
    <BotSettingsGroup title={t("bots.settingsView.access")} testID="bot-settings-access">
      <BotSettingsRow
        icon={Plug}
        title={t("bots.settingsBots.connectors")}
        value={countValue(connected, t)}
        onOpen={openConnectors}
        testID="bot-settings-connectors"
      />
      <BotSettingsRow
        icon={Users}
        title={t("bots.settingsView.whoCanAsk")}
        value={whoCanAsk}
        page="whoCanAsk"
        onOpenPage={open}
        testID="bot-settings-who-can-ask-row"
      />
      <BotSettingsRow
        icon={BookOpen}
        title={t("bots.settingsBots.skills.title")}
        value={skills.data ? countValue(skills.data.length, t) : null}
        page="skills"
        onOpenPage={open}
        testID="bot-settings-skills-row"
      />
    </BotSettingsGroup>
  );
}

function SharingGroup({ bot, open }: { bot: Bot; open: Open }) {
  const { t } = useTranslation();
  const shared = bot.share?.shared === true;
  const updated = bot.share?.updatedAt_ms
    ? t("bots.share.updatedAt", { date: new Date(bot.share.updatedAt_ms).toLocaleDateString() })
    : null;
  return (
    <BotSettingsGroup title={t("bots.settingsView.sharing")} testID="bot-settings-sharing">
      <BotSettingsRow
        icon={Link2}
        title={
          shared ? t("bots.share.isShared", { name: bot.name }) : t("bots.settingsView.shareAction")
        }
        detail={shared ? updated : null}
        value={shared ? t("bots.settingsView.sharingOn") : null}
        page="share"
        onOpenPage={open}
        testID="bot-settings-share"
      />
    </BotSettingsGroup>
  );
}

const NOTIFICATION_TOGGLES: readonly {
  key: keyof BotNotifications;
  label: string;
  description: string;
}[] = [
  {
    key: "needsPermission",
    label: "bots.settingsBots.notifyNeedsPermission",
    description: "bots.settingsBots.notifyNeedsPermissionDescription",
  },
  {
    key: "taskComplete",
    label: "bots.settingsBots.notifyTaskComplete",
    description: "bots.settingsBots.notifyTaskCompleteDescription",
  },
  {
    key: "couldNotFinish",
    label: "bots.settingsBots.notifyCouldNotFinish",
    description: "bots.settingsBots.notifyCouldNotFinishDescription",
  },
];

type NotificationToggle = (typeof NOTIFICATION_TOGGLES)[number];

function NotificationRow({
  toggleRow,
  value,
  onToggle,
}: {
  toggleRow: NotificationToggle;
  value: boolean;
  onToggle: (key: keyof BotNotifications, value: boolean) => void;
}) {
  const { t } = useTranslation();
  const change = useCallback(
    (next: boolean) => onToggle(toggleRow.key, next),
    [onToggle, toggleRow.key],
  );
  return (
    <BotSettingsRow title={t(toggleRow.label)} detail={t(toggleRow.description)}>
      <Switch
        value={value}
        onValueChange={change}
        accessibilityLabel={t(toggleRow.label)}
        testID={`bot-settings-notify-${toggleRow.key}`}
      />
    </BotSettingsRow>
  );
}

function NotificationsGroup({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const update = useBotsMutation(serverId, "bots.update.request");
  const notifications = bot.notifications ?? {
    needsPermission: true,
    taskComplete: true,
    couldNotFinish: true,
  };
  const toggle = useCallback(
    (key: keyof BotNotifications, value: boolean) =>
      update.mutate(
        { botId: bot.id, patch: { notifications: { [key]: value } } },
        { onError: (error) => toast?.error(botErrorMessage(error)) },
      ),
    [bot.id, toast, update],
  );
  return (
    <BotSettingsGroup
      title={t("bots.settingsBots.notifications")}
      testID="bot-settings-notifications"
    >
      {NOTIFICATION_TOGGLES.map((toggleRow) => (
        <NotificationRow
          key={toggleRow.key}
          toggleRow={toggleRow}
          value={notifications[toggleRow.key]}
          onToggle={toggle}
        />
      ))}
    </BotSettingsGroup>
  );
}

export function BotSettingsRoot({
  serverId,
  bot,
  open,
  onDeleted,
}: {
  serverId: string;
  bot: Bot;
  open: Open;
  onDeleted: () => void;
}) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const deleteBot = useDeleteBot(serverId, bot);
  const remove = useCallback(async () => {
    try {
      if (await deleteBot.run()) onDeleted();
    } catch (error) {
      toast?.error(botErrorMessage(error));
    }
  }, [deleteBot, onDeleted, toast]);
  return (
    <View style={styles.root} testID="bot-settings-root">
      <BotCard serverId={serverId} bot={bot} />
      <AgentGroup serverId={serverId} bot={bot} />
      {lookAroundSupported(bot.provider) ? (
        <ScheduleGroup serverId={serverId} bot={bot} open={open} />
      ) : null}
      <ItemsGroup serverId={serverId} bot={bot} />
      <SoulAndMemoryGroup open={open} />
      <AccessGroup serverId={serverId} bot={bot} open={open} />
      <SharingGroup bot={bot} open={open} />
      <NotificationsGroup serverId={serverId} bot={bot} />
      <View style={styles.deleteRow}>
        <Button
          size="sm"
          variant="ghost"
          onPress={remove}
          loading={deleteBot.pending}
          textStyle={styles.danger}
          testID="bot-settings-delete"
        >
          {t("bots.settingsView.deleteBot")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[3] },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: theme.spacing[3],
    borderRadius: 10,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  cardName: { flex: 1, minWidth: 0, gap: 2 },
  muted: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  deleteRow: { flexDirection: "row" },
  danger: { color: theme.colors.statusDanger },
}));
