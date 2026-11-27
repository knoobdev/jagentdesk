// Settings › Agent (spec 37.4.8 item 2): provider and model (searchable), Permissions ("Same as
// chats" or one of the provider's modes; a bypass mode shows the warning), Computer (read-only host,
// folder and Copy path) and Active. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/settings-view/BotSettingsRoot.tsx:270-330,
// src/renderer/src/components/settings/bots/BotGeneralSettings.tsx:1-165,
// src/renderer/src/components/bots/settings-view/BotComputerPage.tsx:1-109,
// src/renderer/src/components/bots/bot-home-chat-confirm.tsx:48-80 (the switch confirmation).
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Activity, Bot as BotIcon, Folder, Laptop, Shield } from "lucide-react-native";
import type { AgentProvider, ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useOptionalToast } from "@/contexts/toast-api-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHosts } from "@/runtime/host-runtime";
import { confirmDialog } from "@/utils/confirm-dialog";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { botErrorMessage, useBotsMutation } from "@/bots/queries";
import type { Theme } from "@/styles/theme";
import { BotSettingsGroup, BotSettingsRow } from "./rows";
import { isBypassMode } from "./row-states";

export const SAME_AS_CHATS = "same-as-chats";

const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedShield = withUnistyles(Shield);
const ThemedBotIcon = withUnistyles(BotIcon);

/** The provider's name as the host lists it ("Claude Code"), for "your {{agent}} plan". */
export function useProviderLabel(serverId: string, provider: string): string {
  const providers = useProvidersSnapshot(serverId);
  return providers.entries?.find((entry) => entry.provider === provider)?.label ?? provider;
}

function readyEntries(entries: ProviderSnapshotEntry[] | undefined): ProviderSnapshotEntry[] {
  return entries?.filter((entry) => entry.enabled !== false && entry.status === "ready") ?? [];
}

export function AgentGroup({ serverId, bot }: { serverId: string; bot: Bot }) {
  const { t } = useTranslation();
  const toast = useOptionalToast();
  const providers = useProvidersSnapshot(serverId);
  const update = useBotsMutation(serverId, "bots.update.request");
  const pause = useBotsMutation(serverId, "bots.pause.request");
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const entries = useMemo(() => readyEntries(providers.entries), [providers.entries]);
  const entry = entries.find((candidate) => candidate.provider === bot.provider);
  const report = useCallback((error: unknown) => toast?.error(botErrorMessage(error)), [toast]);
  const providerOptions = useMemo(
    () =>
      entries.map((candidate) => ({
        id: candidate.provider,
        value: candidate.provider,
        label: candidate.label ?? candidate.provider,
      })),
    [entries],
  );
  const modelOptions = useMemo(
    () =>
      (entry?.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({ id: model.id, value: model.id, label: model.label })),
    [entry],
  );
  const modeOptions = useMemo(
    () => [
      {
        id: SAME_AS_CHATS,
        value: SAME_AS_CHATS,
        label: t("bots.settingsBots.permissionSameAsChats"),
        description: t("bots.settingsBots.permissionSameAsChatsDescription"),
      },
      ...(entry?.modes ?? []).map((mode) => ({
        id: mode.id,
        value: mode.id,
        label: mode.label,
        description: mode.description,
      })),
    ],
    [entry, t],
  );
  const providerLabel = entry?.label ?? bot.provider;
  const modelLabel = entry?.models?.find((model) => model.id === bot.model)?.label ?? bot.model;
  const permissionMode = bot.permissionMode ?? SAME_AS_CHATS;
  const mode = entry?.modes?.find((candidate) => candidate.id === permissionMode);
  const modeLabel =
    permissionMode === SAME_AS_CHATS
      ? t("bots.settingsBots.permissionSameAsChats")
      : (mode?.label ?? permissionMode);
  const providerDisplay = useMemo(() => ({ label: providerLabel }), [providerLabel]);
  const modelDisplay = useMemo(() => ({ label: modelLabel }), [modelLabel]);
  const modeDisplay = useMemo(() => ({ label: modeLabel }), [modeLabel]);

  const selectProvider = useCallback(
    async function selectProvider(value: AgentProvider) {
      if (value === bot.provider) return;
      const next = entries.find((candidate) => candidate.provider === value);
      if (!next) return;
      const agent = next.label ?? next.provider;
      // Another agent can't carry the conversation, so a switch starts the Home Chat fresh (37.3.5).
      const confirmed = await confirmDialog({
        title: t("bots.agentSwitch.title", { name: bot.name, agent }),
        message: [
          t("bots.agentSwitch.description", { name: bot.name, agent }),
          t("bots.agentSwitch.kept"),
          t("bots.agentSwitch.notKept"),
        ].join("\n"),
        confirmLabel: t("bots.agentSwitch.action", { agent }),
      });
      if (!confirmed) return;
      const models = next.models ?? [];
      const model = models.find((candidate) => candidate.isDefault) ?? models[0];
      if (!model) return;
      update.mutate(
        {
          botId: bot.id,
          patch: { provider: next.provider, model: model.id, permissionMode: SAME_AS_CHATS },
        },
        { onError: report },
      );
    },
    [bot.id, bot.name, bot.provider, entries, report, t, update],
  );
  const selectModel = useCallback(
    (value: string, _display: SelectFieldDisplay) => {
      if (value === bot.model) return;
      update.mutate({ botId: bot.id, patch: { model: value } }, { onError: report });
    },
    [bot.id, bot.model, report, update],
  );
  const selectMode = useCallback(
    (value: string, _display: SelectFieldDisplay) => {
      if (value === permissionMode) return;
      update.mutate({ botId: bot.id, patch: { permissionMode: value } }, { onError: report });
    },
    [bot.id, permissionMode, report, update],
  );
  const toggleActive = useCallback(
    (active: boolean) => {
      pause.mutate({ botId: bot.id, paused: !active }, { onError: report });
    },
    [bot.id, pause, report],
  );
  const copyPath = useCallback(async () => {
    if (!bot.home) return;
    await copyToClipboard(bot.home);
    toast?.show(t("bots.settingsView.pathCopied"));
  }, [bot.home, t, toast]);

  return (
    <BotSettingsGroup title={t("bots.settingsBots.agent")} testID="bot-settings-agent">
      <View style={styles.block}>
        <View style={styles.blockHead}>
          <BotIconRowTitle title={t("bots.settingsBots.agent")} />
          <Text style={styles.description}>{t("bots.settingsBots.agentModelDescription")}</Text>
        </View>
        <SelectField
          label={t("bots.jad.searchProviders")}
          field={false}
          value={bot.provider}
          selectedDisplay={providerDisplay}
          options={providerOptions}
          onChange={selectProvider}
          placeholder={providerLabel}
          emptyText={t("bots.jad.noOptions")}
          loading={providers.isLoading}
          size="sm"
          searchable
          searchPlaceholder={t("bots.jad.searchProviders")}
          triggerTestID="bot-settings-provider"
        />
        <SelectField
          label={t("bots.jad.searchModels")}
          field={false}
          value={bot.model}
          selectedDisplay={modelDisplay}
          options={modelOptions}
          onChange={selectModel}
          placeholder={modelLabel}
          emptyText={t("bots.jad.noOptions")}
          size="sm"
          searchable
          searchPlaceholder={t("bots.jad.searchModels")}
          triggerTestID="bot-settings-model"
        />
      </View>
      <View style={styles.block}>
        <View style={styles.blockHead}>
          <View style={styles.titleRow}>
            <ThemedShield size={16} uniProps={mutedIcon} />
            <Text style={styles.title}>{t("bots.settingsBots.permissions")}</Text>
          </View>
          <Text style={styles.description}>{t("bots.settingsBots.permissionsDescription")}</Text>
        </View>
        <SelectField
          label={t("bots.settingsBots.permissions")}
          field={false}
          value={permissionMode}
          selectedDisplay={modeDisplay}
          options={modeOptions}
          onChange={selectMode}
          placeholder={modeLabel}
          emptyText={t("bots.jad.noOptions")}
          size="sm"
          triggerTestID="bot-settings-permissions"
        />
        {isBypassMode(mode) ? (
          <Text style={styles.warning} testID="bot-settings-bypass-warning">
            {t("bots.jad.settings.bypassWarning")}
          </Text>
        ) : null}
      </View>
      <BotSettingsRow icon={Laptop} title={t("bots.settingsView.computer")} value={hostLabel} />
      <BotSettingsRow
        icon={Folder}
        title={t("bots.settingsView.folder")}
        detail={bot.home ?? bot.folder ?? null}
      >
        {bot.home ? (
          <Button size="xs" variant="outline" onPress={copyPath} testID="bot-settings-copy-path">
            {t("bots.settingsView.copyPath")}
          </Button>
        ) : undefined}
      </BotSettingsRow>
      <BotSettingsRow icon={Activity} title={t("bots.settingsBots.active")}>
        <Switch
          value={!bot.paused}
          onValueChange={toggleActive}
          disabled={pause.isPending}
          accessibilityLabel={t("bots.settingsBots.active")}
          testID="bot-settings-active"
        />
      </BotSettingsRow>
    </BotSettingsGroup>
  );
}

function BotIconRowTitle({ title }: { title: string }) {
  return (
    <View style={styles.titleRow}>
      <ThemedBotIcon size={16} uniProps={mutedIcon} />
      <Text style={styles.title}>{title}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  block: {
    gap: theme.spacing[2],
    paddingVertical: 10,
    paddingHorizontal: theme.spacing[3],
  },
  blockHead: { gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: {
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    fontWeight: "500",
    color: theme.colors.foreground,
  },
  description: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  warning: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    color: theme.colors.statusWarning,
  },
}));
