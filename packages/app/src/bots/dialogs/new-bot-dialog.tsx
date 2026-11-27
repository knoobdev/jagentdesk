// The New bot dialog (spec 37.5). Ported from Orca dfdb4fda (MIT) src/renderer/src/components/bots/
// NewBotDialog.tsx:83-433 (title, picture beside the name, Identity, Runs on, Template / Create footer,
// submit gate and "Add a name"), NewBotPurposeField.tsx:12-62 (Identity box, counter from 160,
// "Too long · {{n}}/200"), NewBotPictureButton.tsx:16-131 (the picture tile that opens the picker),
// BotCreateButton.tsx:7-23 (Create with the ⌘↩ hint, "Creating…"), NewBotTemplateParts.tsx:103-254
// (a template's parts line) and NewBotProposalFields.tsx:40-42 (Watches · Does · Reports). There is no
// Computer field (spec 37.2.2), no Slug, Mode, Default repository, Unattended or Look-around field.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { LayoutTemplate, Pencil } from "lucide-react-native";
import { PICKABLE_BOT_MASCOT_IDS } from "@jagentdesk/protocol/bots/rules";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotTemplate } from "@jagentdesk/protocol/bots/views";
import { AdaptiveModalSheet, type SheetKeyboard } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { Shortcut } from "@/components/ui/shortcut";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHosts } from "@/runtime/host-runtime";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { BotAvatarTile, botPicture } from "@/bots/avatar";
import { openBot } from "@/bots/navigation";
import { botErrorMessage, useBots, useBotsMutation, useBotsRead } from "@/bots/queries";
import { BotPicturePickerContent, type BotPictureValue } from "./picture-picker";
import { BotRunsOnPicker } from "./runs-on";
import {
  NewBotFormModel,
  botFolderPreview,
  mascotAvatar,
  templateIdentity,
  type NewBotFormState,
} from "./new-bot-model";

const ThemedPencil = withUnistyles(Pencil);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const SUBMIT_CHORD = [["mod", "Enter"]];
const SUBMIT_HINT = isNative ? null : <Shortcut chord={SUBMIT_CHORD} />;

export interface NewBotHandOver {
  workspaceId: string;
  name: string;
  goal?: string;
}

export function NewBotDialog({
  serverId,
  templateId,
  handOver,
  onClose,
  onOpenTemplates,
}: {
  serverId: string;
  templateId?: string;
  handOver?: NewBotHandOver;
  onClose: () => void;
  /** "Template": closes this dialog for Bot templates. */
  onOpenTemplates: () => void;
}) {
  const { t } = useTranslation();
  // Construct once per mount (docs/forms.md rule 2); late data comes in as explicit inputs below.
  const [model] = useState(
    () =>
      new NewBotFormModel({
        mascotIndex: Math.floor(Math.random() * PICKABLE_BOT_MASCOT_IDS.length),
      }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providers = useProvidersSnapshot(serverId);
  const providerEntries = providers.entries;
  const providersLoaded = !providers.isLoading && providerEntries !== undefined;
  useEffect(() => {
    model.applyProviders(providerEntries ?? [], providersLoaded);
  }, [model, providerEntries, providersLoaded]);
  const templates = useBotsRead(
    serverId,
    "bots.templates.list.request",
    {},
    { enabled: Boolean(templateId), select: (payload) => payload.templates },
  );
  const template = templates.data?.find((entry) => entry.id === templateId) ?? null;
  const say = useMemo(
    () => ({
      watches: (what: string) => t("bots.new.identityWatches", { what }),
      reports: (what: string) => t("bots.new.identityReports", { what }),
    }),
    [t],
  );
  useEffect(() => {
    if (template) model.applyTemplate(template, templateIdentity(template, say));
  }, [model, template, say]);

  const bots = useBots(serverId);
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const folder = botFolderPreview(state.name || t("bots.new.name"), bots.data ?? []);

  const create = useBotsMutation(serverId, "bots.create.request");
  const createFromTemplate = useBotsMutation(serverId, "bots.create_from_template.request");
  const handOverToNew = useBotsMutation(serverId, "bots.hand_over.request");

  const finish = useCallback(
    (bot: Bot) => {
      onClose();
      openBot(serverId, bot.id, { tab: "home" });
    },
    [onClose, serverId],
  );
  const submit = useCallback(async () => {
    if (!model.submit()) return;
    const current = model.getState();
    if (!current.provider) return;
    model.startCreating();
    const picture = model.picture();
    const identity = model.identityToSend();
    const name = current.name.trim();
    try {
      let bot: Bot;
      if (handOver) {
        bot = (
          await handOverToNew.mutateAsync({
            workspaceId: handOver.workspaceId,
            botId: "new",
            newBot: {
              name,
              identity,
              provider: current.provider,
              model: current.model,
              ...picture,
            },
            ...(handOver.goal ? { goal: handOver.goal } : {}),
          })
        ).bot;
      } else if (current.templateId) {
        bot = (
          await createFromTemplate.mutateAsync({
            templateId: current.templateId,
            name,
            identity,
            provider: current.provider,
            model: current.model,
            ...picture,
          })
        ).bot;
      } else {
        bot = (
          await create.mutateAsync({
            bot: { name, identity, provider: current.provider, model: current.model, ...picture },
          })
        ).bot;
      }
      finish(bot);
    } catch (error) {
      model.failCreating(botErrorMessage(error));
    }
  }, [create, createFromTemplate, finish, handOver, handOverToNew, model]);
  const press = useCallback(() => void submit(), [submit]);
  const keyboard = useMemo<SheetKeyboard>(
    () => ({
      keys: ["Enter"],
      onKeyDown: (event) => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return false;
        void submit();
        return true;
      },
    }),
    [submit],
  );

  const header = useMemo(
    () => ({
      title: t("bots.new.title"),
      subtitle: handOver ? t("bots.handToBot.newBotOrigin", { name: handOver.name }) : undefined,
    }),
    [handOver, t],
  );
  // "Template" closes this dialog, so it shows only before anything is typed (`NewBotDialog.tsx:242`).
  const showTemplate = !handOver && !state.templateId && !state.name && !state.identity;
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {showTemplate ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={LayoutTemplate}
            onPress={onOpenTemplates}
            testID="new-bot-template"
          >
            {t("bots.new.fromTemplate")}
          </Button>
        ) : null}
        <View style={styles.grow} />
        <Button
          variant="default"
          size="sm"
          onPress={press}
          disabled={state.creating}
          loading={state.creating}
          trailing={SUBMIT_HINT}
          testID="new-bot-create"
        >
          {state.creating ? t("bots.new.creating") : t("bots.new.create")}
        </Button>
      </View>
    ),
    [onOpenTemplates, press, showTemplate, state.creating, t],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      footer={footer}
      desktopMaxWidth={520}
      keyboard={keyboard}
      testID="new-bot-dialog"
    >
      <View style={styles.body}>
        <NameRow model={model} state={state} />
        {state.pictureOpen ? <PictureSection model={model} state={state} /> : null}
        <IdentityField model={model} state={state} />
        <BotRunsOnPicker model={model} state={state} hostLabel={hostLabel} />
        <Text style={styles.folder} numberOfLines={1} testID="new-bot-folder">
          {t("bots.new.folder", { path: folder })}
        </Text>
        {template ? <TemplateFields template={template} /> : null}
        {state.error ? (
          <Text style={styles.error} accessibilityRole="alert" testID="new-bot-error">
            {state.error}
          </Text>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );
}

function NameRow({ model, state }: { model: NewBotFormModel; state: NewBotFormState }) {
  const { t } = useTranslation();
  const picture = useMemo(
    () =>
      botPicture({
        name: state.name,
        avatar: mascotAvatar(state.mascotIndex),
        avatarColor: state.avatarColor,
        avatarOutfit: state.avatarOutfit,
      }),
    [state.name, state.mascotIndex, state.avatarColor, state.avatarOutfit],
  );
  const togglePicture = useCallback(() => model.togglePicture(), [model]);
  const setName = useCallback((name: string) => model.setName(name), [model]);
  const nameInvalid = state.submitted && state.nameMissing;
  return (
    <View style={styles.nameRow}>
      <Pressable
        onPress={togglePicture}
        accessibilityRole="button"
        accessibilityLabel={t("bots.new.changePicture")}
        style={styles.pictureButton}
        testID="new-bot-picture"
      >
        <BotAvatarTile picture={picture} size={64} radius={18} />
        <View style={styles.pencil}>
          <ThemedPencil size={12} uniProps={muted} />
        </View>
      </Pressable>
      <View style={styles.nameColumn}>
        <FormTextInput
          value={state.name}
          initialValue={state.name}
          resetKey={state.templateId ?? ""}
          webControlled
          onChangeText={setName}
          placeholder={t("bots.new.name")}
          accessibilityLabel={t("bots.new.name")}
          maxLength={64}
          invalid={nameInvalid}
          autoFocus={!state.templateId}
          autoCapitalize="words"
          size="sm"
          testID="new-bot-name"
        />
        {nameInvalid ? (
          <Text style={styles.error} accessibilityRole="alert" testID="new-bot-name-error">
            {t("bots.new.validation.addName")}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function PictureSection({ model, state }: { model: NewBotFormModel; state: NewBotFormState }) {
  const value = useMemo<BotPictureValue>(
    () => ({
      avatar: mascotAvatar(state.mascotIndex),
      avatarColor: state.avatarColor,
      avatarOutfit: state.avatarOutfit,
    }),
    [state.mascotIndex, state.avatarColor, state.avatarOutfit],
  );
  const change = useCallback((next: BotPictureValue) => model.setPicture(next), [model]);
  return (
    <View style={styles.pictureSection}>
      <BotPicturePickerContent value={value} onChange={change} />
    </View>
  );
}

function IdentityField({ model, state }: { model: NewBotFormModel; state: NewBotFormState }) {
  const { t } = useTranslation();
  const setIdentity = useCallback((identity: string) => model.setIdentity(identity), [model]);
  const tooLong = state.identityTooLong;
  return (
    <View style={styles.identity}>
      <FormTextInput
        value={state.identity}
        initialValue={state.identity}
        resetKey={state.templateId ?? ""}
        webControlled
        onChangeText={setIdentity}
        multiline
        numberOfLines={5}
        placeholder={t("bots.new.purposePlaceholder")}
        accessibilityLabel={t("bots.new.purposeLabel")}
        invalid={tooLong}
        size="sm"
        style={styles.identityInput}
        testID="new-bot-identity"
      />
      {state.showIdentityCounter ? (
        <Text
          style={tooLong ? styles.counterError : styles.counter}
          accessibilityRole={tooLong ? "alert" : undefined}
          testID="new-bot-identity-counter"
        >
          {tooLong ? `${t("bots.new.validation.identityTooLong")} · ` : ""}
          {state.identityCount}/200
        </Text>
      ) : null}
    </View>
  );
}

/** What a template's bot comes with: Watches · Does · Reports, then one chip per kind of part. */
function TemplateFields({ template }: { template: BotTemplate }) {
  const { t } = useTranslation();
  const parts = [
    template.skills.length ? t("bots.new.parts.skills", { count: template.skills.length }) : null,
    template.events.length
      ? t("bots.new.parts.automations", { count: template.events.length })
      : null,
    template.schedules.length
      ? t("bots.new.parts.schedules", { count: template.schedules.length })
      : null,
    needsAppsPart(template.connectors, t),
    template.connectors.length || template.events.length
      ? t("bots.new.parts.setUpInFirstChat")
      : null,
  ].filter((part): part is string => part !== null);
  return (
    <View style={styles.template} testID="new-bot-template-fields">
      {(
        [
          ["watches", t("bots.new.watches"), template.watches],
          ["does", t("bots.new.does"), template.does],
          ["reports", t("bots.new.reports"), template.reports],
        ] as const
      ).map(([key, label, text]) =>
        text ? (
          <View key={key} style={styles.templateRow}>
            <Text style={styles.templateLabel}>{label}</Text>
            <Text style={styles.templateText}>{text}</Text>
          </View>
        ) : null,
      )}
      {parts.length ? (
        <View style={styles.chips}>
          {parts.map((part) => (
            <View key={part} style={styles.chip}>
              <Text style={styles.chipText}>{part}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function needsAppsPart(
  connectors: readonly string[],
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (connectors.length === 0) return null;
  if (connectors.length === 1)
    return t("bots.new.parts.needsApp", { app: connectorName(connectors[0]) });
  return t("bots.new.parts.needsApps", { count: connectors.length });
}

/** `BOT_CONNECTOR_NAMES` for the connectors JAgentDesk has. */
function connectorName(kind: string): string {
  switch (kind) {
    case "github":
      return "GitHub";
    case "gitlab":
      return "GitLab";
    case "slack":
      return "Slack";
    case "telegram":
      return "Telegram";
    default:
      return kind;
  }
}

const styles = StyleSheet.create((theme: Theme) => ({
  body: { gap: 16, paddingBottom: 4 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  pictureButton: { width: 64, height: 64 },
  pencil: {
    position: "absolute",
    right: -6,
    bottom: -6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  nameColumn: { flex: 1, minWidth: 0, gap: 4 },
  pictureSection: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
    padding: 12,
  },
  identity: { gap: 4 },
  identityInput: { minHeight: 100, textAlignVertical: "top" },
  counter: {
    alignSelf: "flex-end",
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  counterError: { fontSize: 12, color: theme.colors.statusDanger, fontVariant: ["tabular-nums"] },
  folder: { fontSize: 12, color: theme.colors.foregroundMuted },
  error: { fontSize: 12, color: theme.colors.statusDanger },
  footer: { flexDirection: "row", alignItems: "center", gap: 8 },
  grow: { flex: 1 },
  template: {
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: 16,
  },
  templateRow: { gap: 2 },
  templateLabel: { fontSize: 12, fontWeight: "500", color: theme.colors.foregroundMuted },
  templateText: { fontSize: 14, color: theme.colors.foreground },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  chip: {
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 10,
    justifyContent: "center",
  },
  chipText: { fontSize: 12, fontWeight: "500", color: theme.colors.foreground },
}));
