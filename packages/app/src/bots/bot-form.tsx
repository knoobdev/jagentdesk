import { useCallback, useMemo } from "react";
import { useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import type { Bot, BotInput } from "@jagentdesk/protocol/bots/types";
import type { AgentProvider } from "@jagentdesk/protocol/agent-types";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form-field";
import { SelectField, type SelectFieldDisplay } from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { Alert } from "@/components/ui/alert";
import { useHostFeature } from "@/runtime/host-features";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useIsCompactFormFactor } from "@/constants/layout";
import { confirmDialog } from "@/utils/confirm-dialog";
import { BotFormModel, validateBotDraft } from "./form-model";
import { useBotsMutation } from "./queries";
import { Input, ErrorNotice } from "./ui";
import { Hint } from "./help";
import { styles } from "./styles";
function ProviderFields({ serverId, model }: { serverId: string; model: BotFormModel }) {
  const { t } = useTranslation();
  const draft = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providers = useProvidersSnapshot(serverId);
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const entries = useMemo(
    () => providers.entries?.filter((entry) => entry.enabled && entry.status === "ready") ?? [],
    [providers.entries],
  );
  const selected = useMemo(
    () => entries.find((entry) => entry.provider === draft.provider),
    [entries, draft.provider],
  );
  const providerOptions = useMemo(
    () =>
      entries.map((entry) => ({
        id: entry.provider,
        value: entry.provider,
        label: entry.label ?? entry.provider,
      })),
    [entries],
  );
  const modelOptions = useMemo(
    () =>
      selected?.models?.map((entry) => ({ id: entry.id, value: entry.id, label: entry.label })) ??
      [],
    [selected],
  );
  const modeOptions = useMemo(
    () =>
      selected?.modes?.map((entry) => ({ id: entry.id, value: entry.id, label: entry.label })) ??
      [],
    [selected],
  );
  const providerDisplay = useMemo(
    () => (draft.provider ? { label: draft.providerLabel } : null),
    [draft.provider, draft.providerLabel],
  );
  const modelDisplay = useMemo(
    () => (draft.model ? { label: draft.modelLabel } : null),
    [draft.model, draft.modelLabel],
  );
  const modeDisplay = useMemo(
    () => (draft.modeId ? { label: draft.modeLabel } : null),
    [draft.modeId, draft.modeLabel],
  );
  const refresh = useCallback(
    function refresh() {
      void providers.refresh();
    },
    [providers],
  );
  const selectProvider = useCallback(
    function selectProvider(value: AgentProvider) {
      const entry = entries.find((candidate) => candidate.provider === value);
      if (entry) model.selectProvider(entry);
    },
    [entries, model],
  );
  const selectModel = useCallback(
    function selectModel(value: string, display: SelectFieldDisplay) {
      model.selectModel(value, display.label);
    },
    [model],
  );
  const selectMode = useCallback(
    function selectMode(value: string, display: SelectFieldDisplay) {
      model.selectMode(value, display.label);
    },
    [model],
  );
  return (
    <>
      {providers.error ? (
        <Alert variant="error" title={providers.error}>
          <Button onPress={refresh}>{t("bots.retry")}</Button>
        </Alert>
      ) : null}
      <SelectField
        label={t("bots.provider")}
        value={draft.provider}
        selectedDisplay={providerDisplay}
        options={providerOptions}
        onChange={selectProvider}
        placeholder={t("bots.choose")}
        emptyText={t("bots.noOptions")}
        loading={providers.isLoading}
        size={size}
        searchable
        searchPlaceholder={t("bots.searchProviders")}
        triggerTestID="bot-provider"
      />
      <SelectField
        label={t("bots.model")}
        value={draft.model || null}
        selectedDisplay={modelDisplay}
        options={modelOptions}
        onChange={selectModel}
        placeholder={t("bots.choose")}
        emptyText={t("bots.noOptions")}
        size={size}
        searchable
        searchPlaceholder={t("bots.searchModels")}
        triggerTestID="bot-model"
      />
      <SelectField
        label={t("bots.mode")}
        value={draft.modeId || null}
        selectedDisplay={modeDisplay}
        options={modeOptions}
        onChange={selectMode}
        placeholder={t("bots.choose")}
        emptyText={t("bots.noOptions")}
        size={size}
        triggerTestID="bot-mode"
      />
      <Hint testID="bot-agent-hint">{t("bots.help.agent")}</Hint>
    </>
  );
}
function AdvancedSettings({ serverId, model }: { serverId: string; model: BotFormModel }) {
  const { t } = useTranslation();
  const draft = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const providers = useProvidersSnapshot(serverId);
  const agent =
    providers.entries?.find((entry) => entry.provider === draft.provider)?.label ??
    (draft.providerLabel || draft.provider);
  const validation = useMemo(() => validateBotDraft(draft), [draft]);
  const setLookAround = useCallback(
    function setLookAround(value: boolean) {
      model.set("lookAround", value);
    },
    [model],
  );
  const setInterval = useCallback(
    function setInterval(value: string) {
      model.set("interval", value);
    },
    [model],
  );
  const setUnattended = useCallback(
    async function setUnattended(value: boolean) {
      if (
        value &&
        !(await confirmDialog({
          title: t("bots.unattendedConfirm"),
          message: t("bots.unattendedWarning"),
          confirmLabel: t("bots.unattendedConfirm"),
        }))
      )
        return;
      model.set("unattended", value);
    },
    [t, model],
  );
  return (
    <>
      <Field label={t("bots.lookAround")}>
        <Switch
          value={draft.lookAround}
          onValueChange={setLookAround}
          accessibilityLabel={t("bots.lookAround")}
        />
        <Hint testID="bot-look-around-hint">{t("bots.help.lookAround")}</Hint>
      </Field>
      <Input
        label={t("bots.interval")}
        value={draft.interval}
        onChange={setInterval}
        hint={t("bots.help.interval", { agent })}
        error={
          draft.lookAround && validation.errors.interval ? t(validation.errors.interval) : null
        }
        testID="bot-interval"
      />
      <Field label={t("bots.unattended")}>
        <Switch
          value={draft.unattended}
          onValueChange={setUnattended}
          accessibilityLabel={t("bots.unattended")}
          testID="bot-unattended"
        />
        <Hint testID="bot-unattended-hint">{t("bots.help.unattended")}</Hint>
      </Field>
      {draft.unattended ? <Text style={styles.warning}>{t("bots.unattendedWarning")}</Text> : null}
    </>
  );
}
interface FormProps {
  serverId: string;
  bot: Bot | null;
  save: (input: BotInput) => Promise<unknown>;
  pending: boolean;
  error: Error | null;
  onSaved?: () => void;
  /** A new bot's starting name (a bot from a share link keeps its sharer's name). */
  initialName?: string;
}
export function BotForm({ serverId, bot, save, pending, error, onSaved, initialName }: FormProps) {
  const { t } = useTranslation();
  const [model] = useState(() => {
    const created = new BotFormModel(bot);
    if (!bot && initialName) created.setName(initialName);
    return created;
  });
  const draft = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const optionalIdentity = useHostFeature(serverId, "botsOptionalIdentity");
  const validation = useMemo(() => validateBotDraft(draft), [draft]);
  const blocked = validation.missing !== null || Object.keys(validation.errors).length > 0;
  const [saved, setSaved] = useState(false);
  const submit = useCallback(
    async function submit() {
      setSaved(false);
      const input = model.input({ optionalIdentity });
      if (!input) return;
      try {
        await save(input);
        setSaved(true);
        onSaved?.();
      } catch {
        /* The mutation renders the error beside Save. */
      }
    },
    [setSaved, model, optionalIdentity, save, onSaved],
  );
  const setName = useCallback(
    function setName(value: string) {
      model.setName(value);
    },
    [model],
  );
  const setSlug = useCallback(
    function setSlug(value: string) {
      model.setSlug(value);
    },
    [model],
  );
  const setIdentity = useCallback(
    function setIdentity(value: string) {
      model.set("identity", value);
    },
    [model],
  );
  const setRepo = useCallback(
    function setRepo(value: string) {
      model.set("defaultRepo", value);
    },
    [model],
  );
  const { errors } = validation;
  return (
    <View style={styles.body}>
      <Input
        label={t("bots.name")}
        value={draft.name}
        onChange={setName}
        hint={t("bots.help.name")}
        error={errors.name ? t(errors.name) : null}
        testID="bot-name"
      />
      <Input
        label={t("bots.slug")}
        value={draft.slug}
        onChange={setSlug}
        editable={!bot}
        hint={t("bots.help.slug")}
        error={errors.slug ? t(errors.slug) : null}
        testID="bot-slug"
      />
      <Input
        label={t("bots.identity")}
        value={draft.identity}
        onChange={setIdentity}
        multiline
        hint={t("bots.help.identity")}
        error={
          errors.identity ? t(errors.identity, { length: draft.identity.trim().length }) : null
        }
        testID="bot-identity"
      />
      <ProviderFields serverId={serverId} model={model} />
      <Input
        label={t("bots.repo")}
        value={draft.defaultRepo}
        onChange={setRepo}
        hint={t("bots.help.repo")}
        testID="bot-repo"
      />
      {bot ? <AdvancedSettings serverId={serverId} model={model} /> : null}
      <ErrorNotice error={error} />
      {saved ? <Text style={styles.muted}>{t("bots.saved")}</Text> : null}
      <Button onPress={submit} loading={pending} disabled={pending || blocked} testID="bot-save">
        {t(bot ? "bots.save" : "bots.create")}
      </Button>
      {validation.missing ? (
        <Text style={styles.muted} testID="bot-save-reason">
          {t(validation.missing)}
        </Text>
      ) : null}
    </View>
  );
}
export function CreateBotSheet({
  serverId,
  onClose,
  onCreated,
}: {
  serverId: string;
  onClose: () => void;
  onCreated: (bot: Bot) => void;
}) {
  const { t } = useTranslation();
  const mutation = useBotsMutation(serverId, "bots.create.request");
  const header = useMemo(() => ({ title: t("bots.newBot") }), [t]);
  const save = useCallback(
    async function save(bot: BotInput) {
      const result = await mutation.mutateAsync({ bot });
      onCreated(result.bot);
    },
    [mutation, onCreated],
  );
  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      testID="bot-create-sheet"
    >
      <ScrollView>
        <BotForm
          serverId={serverId}
          bot={null}
          save={save}
          pending={mutation.isPending}
          error={mutation.error}
        />
      </ScrollView>
    </AdaptiveModalSheet>
  );
}
