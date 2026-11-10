import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import { Trash2, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { CustomProvidersClient } from "./client";
import { useCustomProviderFormModel } from "./use-custom-provider-form-model";
import type {
  CustomProviderFormState,
  ModelRowDraft,
  SshServerOption,
} from "./custom-provider-form-model";
import type { ApiProviderRecord, ApiProtocol, ApiRoute } from "./types";

// Add / edit sheet for daemon-managed custom API providers (spec 34.8).
// Desktop and mobile share this component; AdaptiveModalSheet adapts the shell.

export interface CustomProviderEditorTarget {
  mode: "create" | "update";
  record: ApiProviderRecord | null;
}

interface CustomProviderFormSheetProps {
  client: CustomProvidersClient | null;
  target: CustomProviderEditorTarget;
  sshServers: readonly SshServerOption[];
  onClose: () => void;
  /** Called after a successful save or delete; the parent closes and refreshes. */
  onSaved: () => void;
  /** Reports the outcome of the latest discover/test for the list status dot. */
  onTested?: (recordId: string | null, ok: boolean) => void;
}

type FormHandle = ReturnType<typeof useCustomProviderFormModel>;

const RADIO_CHECKED = { checked: true };
const RADIO_UNCHECKED = { checked: false };
const CHIP_SELECTED = { selected: true };
const CHIP_UNCHECKED = { selected: false };

const ThemedTrash2 = withUnistyles(Trash2, (theme) => ({
  size: 14,
  color: theme.colors.foregroundMuted,
}));
const ThemedX = withUnistyles(X, (theme) => ({
  size: 12,
  color: theme.colors.foregroundMuted,
}));

function ThinkingChip({
  model,
  rowIndex,
  option,
}: {
  model: FormHandle;
  rowIndex: number;
  option: { id: string; label: string; isDefault?: boolean };
}) {
  const { t } = useTranslation();
  const setDefault = useCallback(
    () => model.setDefaultThinkingOption(rowIndex, option.id),
    [model, option.id, rowIndex],
  );
  const remove = useCallback(
    () => model.removeThinkingOption(rowIndex, option.id),
    [model, option.id, rowIndex],
  );
  const isDefault = option.isDefault === true;
  return (
    <View style={styles.thinkingChipGroup}>
      <Pressable
        style={[styles.chip, isDefault && styles.chipActive]}
        onPress={setDefault}
        accessibilityRole="button"
        accessibilityState={isDefault ? CHIP_SELECTED : CHIP_UNCHECKED}
        accessibilityLabel={t("settings.providers.customProviders.form.thinkingDefault")}
        testID={`custom-provider-thinking-${rowIndex}-${option.id}`}
      >
        <Text style={[styles.chipText, isDefault && styles.chipTextActive]}>
          {isDefault ? `• ${option.label}` : option.label}
        </Text>
      </Pressable>
      <Pressable
        style={styles.chipRemove}
        onPress={remove}
        accessibilityLabel={t("settings.providers.customProviders.form.thinking")}
        testID={`custom-provider-thinking-remove-${rowIndex}-${option.id}`}
      >
        <ThemedX />
      </Pressable>
    </View>
  );
}

function ThinkingOptionsField({
  model,
  rowIndex,
  options,
}: {
  model: FormHandle;
  rowIndex: number;
  options: ModelRowDraft["thinkingOptions"];
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const commit = useCallback(() => {
    model.addThinkingOption(rowIndex, draft);
    setDraft("");
  }, [draft, model, rowIndex]);
  return (
    <Field label={t("settings.providers.customProviders.form.thinking")}>
      <View style={styles.chipRow}>
        {options.map((option) => (
          <ThinkingChip key={option.id} model={model} rowIndex={rowIndex} option={option} />
        ))}
      </View>
      <FormTextInput
        testID={`custom-provider-thinking-add-${rowIndex}`}
        initialValue=""
        value={draft}
        onChangeText={setDraft}
        onSubmitEditing={commit}
        onBlur={commit}
        placeholder={t("settings.providers.customProviders.form.thinkingPlaceholder")}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </Field>
  );
}

function ModelRow({
  model,
  index,
  row,
  lastIndex,
}: {
  model: FormHandle;
  index: number;
  row: ModelRowDraft;
  lastIndex: boolean;
}) {
  const { t } = useTranslation();
  const setDefault = useCallback(() => model.setDefaultModel(index), [index, model]);
  const removeRow = useCallback(() => model.removeModelRow(index), [index, model]);
  const setId = useCallback(
    (value: string) => model.updateModelRow(index, { id: value }),
    [index, model],
  );
  const setLabel = useCallback(
    (value: string) => model.updateModelRow(index, { label: value }),
    [index, model],
  );
  return (
    <View style={styles.modelRow} testID={`custom-provider-model-row-${row.rowKey}`}>
      <View style={styles.modelRowHeader}>
        <Pressable
          style={styles.radio}
          onPress={setDefault}
          accessibilityRole="radio"
          accessibilityState={row.isDefault ? RADIO_CHECKED : RADIO_UNCHECKED}
          accessibilityLabel={t("settings.providers.customProviders.form.defaultModel")}
          testID={`custom-provider-model-default-${index}`}
        >
          {row.isDefault ? <View style={styles.radioDot} /> : null}
        </Pressable>
        <Text style={styles.modelRowTitle}>
          {row.id.trim() || t("settings.providers.customProviders.form.modelId")}
        </Text>
        <Pressable
          style={styles.modelRowRemove}
          onPress={removeRow}
          disabled={lastIndex}
          accessibilityLabel={t("settings.providers.customProviders.form.removeModel")}
          testID={`custom-provider-model-remove-${index}`}
        >
          <ThemedTrash2 />
        </Pressable>
      </View>
      <View style={styles.modelRowFields}>
        <View style={styles.modelRowFieldGrow}>
          <Field label={t("settings.providers.customProviders.form.modelId")}>
            <FormTextInput
              testID={`custom-provider-model-id-${index}`}
              initialValue={row.id}
              value={row.id}
              onChangeText={setId}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </View>
        <View style={styles.modelRowFieldGrow}>
          <Field label={t("settings.providers.customProviders.form.modelLabel")}>
            <FormTextInput
              testID={`custom-provider-model-label-${index}`}
              initialValue={row.label}
              value={row.label}
              onChangeText={setLabel}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        </View>
      </View>
      <ThinkingOptionsField model={model} rowIndex={index} options={row.thinkingOptions} />
    </View>
  );
}

function ModelsSection({ model, state }: { model: FormHandle; state: CustomProviderFormState }) {
  const { t } = useTranslation();
  return (
    <View style={styles.modelsSection}>
      <Text style={styles.modelsTitle}>
        {t("settings.providers.customProviders.form.modelsTitle")}
      </Text>
      {state.models.length === 0 ? (
        <Text style={styles.modelsEmpty}>
          {t("settings.providers.customProviders.form.noModels")}
        </Text>
      ) : (
        state.models.map((row, index) => (
          <ModelRow
            key={row.rowKey}
            model={model}
            index={index}
            row={row}
            lastIndex={state.models.length === 1}
          />
        ))
      )}
      <Button
        variant="ghost"
        size="sm"
        onPress={model.addModelRow}
        testID="custom-provider-add-model"
      >
        {t("settings.providers.customProviders.form.addModel")}
      </Button>
    </View>
  );
}

function ApiKeySection({ model, state }: { model: FormHandle; state: CustomProviderFormState }) {
  const { t } = useTranslation();
  return (
    <>
      {state.hasStoredKey && state.apiKeyDraft.length === 0 ? (
        <View style={styles.savedKeyRow}>
          <StatusBadge
            label={t("settings.providers.customProviders.form.keySaved")}
            variant="success"
          />
          <Button
            size="xs"
            variant="ghost"
            onPress={model.clearApiKey}
            testID="custom-provider-clear-key"
          >
            {t("settings.providers.customProviders.form.clearKey")}
          </Button>
        </View>
      ) : null}
      <Field
        label={t("settings.providers.customProviders.form.apiKey")}
        hint={
          state.hasStoredKey && !state.keyCleared
            ? t("settings.providers.customProviders.form.apiKeyHint")
            : undefined
        }
      >
        <FormTextInput
          testID="custom-provider-api-key"
          initialValue=""
          value={state.apiKeyDraft}
          onChangeText={model.setApiKeyDraft}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />
      </Field>
    </>
  );
}

function DiscoverControls({
  model,
  state,
  client,
  busy,
  onTested,
  recordId,
}: {
  model: FormHandle;
  state: CustomProviderFormState;
  client: CustomProvidersClient | null;
  busy: boolean;
  onTested?: (recordId: string | null, ok: boolean) => void;
  recordId: string | null;
}) {
  const { t } = useTranslation();
  const runDiscover = useCallback(async () => {
    if (!client) return;
    model.beginDiscover();
    try {
      const result = await client.customProvidersTest(model.buildTestInput());
      onTested?.(recordId, result.ok);
      model.applyDiscoverResult({
        ok: result.ok,
        modelIds: result.models.map((entry) => entry.id),
        errorMessage: result.error?.message ?? null,
      });
    } catch (error) {
      model.applyDiscoverResult({
        ok: false,
        modelIds: [],
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }, [client, model, onTested, recordId]);
  const handleDiscover = useCallback(() => void runDiscover(), [runDiscover]);
  return (
    <>
      <View style={styles.discoverRow}>
        <Button
          variant="secondary"
          size="sm"
          onPress={handleDiscover}
          disabled={state.discoverStatus === "pending" || busy || !client}
          testID="custom-provider-discover"
        >
          {state.discoverStatus === "pending"
            ? t("settings.providers.customProviders.form.discovering")
            : t("settings.providers.customProviders.form.discover")}
        </Button>
      </View>
      {state.discoverStatus === "error" ? (
        <Alert
          variant="error"
          title={state.discoverError || t("settings.providers.customProviders.form.discoverFailed")}
        />
      ) : null}
    </>
  );
}

function SheetFooterButtons({
  mode,
  saving,
  deleting,
  canSubmit,
  client,
  onSave,
  onDelete,
}: {
  mode: "create" | "update";
  saving: boolean;
  deleting: boolean;
  canSubmit: boolean;
  client: CustomProvidersClient | null;
  onSave: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const busy = saving || deleting;
  return (
    <View style={styles.footerRow}>
      {mode === "update" ? (
        <Button
          variant="ghost"
          size="sm"
          onPress={onDelete}
          disabled={busy || !client}
          testID="custom-provider-delete"
        >
          {deleting
            ? t("settings.providers.customProviders.form.deleting")
            : t("settings.providers.customProviders.form.delete")}
        </Button>
      ) : null}
      <Button
        variant="default"
        size="sm"
        onPress={onSave}
        disabled={!canSubmit || busy || !client}
        testID="custom-provider-save"
      >
        {saving
          ? t("settings.providers.customProviders.form.saving")
          : t("settings.providers.customProviders.form.save")}
      </Button>
    </View>
  );
}

export function CustomProviderFormSheet({
  client,
  target,
  sshServers,
  onClose,
  onSaved,
  onTested,
}: CustomProviderFormSheetProps) {
  const { t } = useTranslation();
  const [snapshot] = useState<CustomProviderEditorTarget>(() => target);
  const model = useCustomProviderFormModel({
    mode: snapshot.mode,
    record: snapshot.record,
    sshServers,
  });
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const errorText = useCallback(
    (error: "required" | "invalid" | null, requiredKey: string, invalidKey: string) => {
      if (error === "required") return t(requiredKey);
      if (error === "invalid") return t(invalidKey);
      return null;
    },
    [t],
  );

  const protocolOptions = useMemo<Array<{ value: ApiProtocol; label: string; testID: string }>>(
    () => [
      {
        value: "openai",
        label: t("settings.providers.customProviders.protocol.openai"),
        testID: "custom-provider-protocol-openai",
      },
      {
        value: "anthropic",
        label: t("settings.providers.customProviders.protocol.anthropic"),
        testID: "custom-provider-protocol-anthropic",
      },
    ],
    [t],
  );

  const routeOptions = useMemo<Array<SelectFieldOption<ApiRoute>>>(
    () => [
      {
        id: "direct",
        value: "direct",
        label: t("settings.providers.customProviders.route.direct"),
      },
      {
        id: "tailnet",
        value: "tailnet",
        label: t("settings.providers.customProviders.route.tailnet"),
      },
      {
        id: "ssh",
        value: "ssh",
        label: t("settings.providers.customProviders.route.ssh"),
      },
    ],
    [t],
  );

  const routeDisplay = useMemo(() => {
    const option = routeOptions.find((candidate) => candidate.value === state.via);
    return { label: option?.label ?? t("settings.providers.customProviders.route.direct") };
  }, [routeOptions, state.via, t]);

  const sshServerOptions = useMemo<Array<SelectFieldOption<string>>>(
    () =>
      state.sshServers.map((server) => ({
        id: server.id,
        value: server.id,
        label: server.label,
      })),
    [state.sshServers],
  );
  const sshServerDisplay = useMemo(() => {
    const selected = sshServerOptions.find((option) => option.value === state.sshServerId);
    return { label: selected?.label ?? "" };
  }, [sshServerOptions, state.sshServerId]);

  const baseUrlPlaceholder = useMemo(
    () =>
      state.via === "ssh"
        ? t("settings.providers.customProviders.form.baseUrlSshPlaceholder")
        : t("settings.providers.customProviders.form.baseUrlPlaceholder"),
    [state.via, t],
  );

  const save = useCallback(async () => {
    if (!client) return;
    setSaving(true);
    setSubmitError(null);
    try {
      await client.customProvidersSave(model.buildSavePayload());
      onSaved();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }, [client, model, onSaved]);

  const handleSave = useCallback(() => void save(), [save]);

  const remove = useCallback(async () => {
    if (!client || !snapshot.record) return;
    setDeleting(true);
    setSubmitError(null);
    try {
      const confirmed = await confirmDialog({
        title: t("settings.providers.customProviders.form.deleteConfirmTitle", {
          name: snapshot.record.label,
        }),
        message: t("settings.providers.customProviders.form.deleteConfirmMessage"),
        confirmLabel: t("settings.providers.customProviders.form.deleteConfirm"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }
      await client.customProvidersDelete({ id: snapshot.record.id });
      onSaved();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setDeleting(false);
    }
  }, [client, onSaved, snapshot.record, t]);

  const handleDelete = useCallback(() => void remove(), [remove]);

  const header = useMemo(
    () => ({
      title: t(
        snapshot.mode === "create"
          ? "settings.providers.customProviders.form.addTitle"
          : "settings.providers.customProviders.form.editTitle",
      ),
    }),
    [snapshot.mode, t],
  );

  const nameError = errorText(
    state.errors.name,
    "settings.providers.customProviders.form.nameRequired",
    "settings.providers.customProviders.form.nameRequired",
  );
  const idError = errorText(
    state.errors.id,
    "settings.providers.customProviders.form.idRequired",
    "settings.providers.customProviders.form.idInvalid",
  );
  const baseUrlError = errorText(
    state.errors.baseUrl,
    "settings.providers.customProviders.form.baseUrlInvalid",
    "settings.providers.customProviders.form.baseUrlInvalid",
  );
  const sshServerError = errorText(
    state.errors.sshServerId,
    "settings.providers.customProviders.form.sshServerRequired",
    "settings.providers.customProviders.form.sshServerRequired",
  );
  const discoverRecordId = snapshot.mode === "update" ? (snapshot.record?.id ?? null) : null;
  const footer = useMemo(
    () => (
      <SheetFooterButtons
        mode={snapshot.mode}
        saving={saving}
        deleting={deleting}
        canSubmit={state.canSubmit}
        client={client}
        onSave={handleSave}
        onDelete={handleDelete}
      />
    ),
    [client, deleting, handleDelete, handleSave, saving, snapshot.mode, state.canSubmit],
  );

  return (
    <AdaptiveModalSheet
      visible
      onClose={onClose}
      onDismiss={onClose}
      header={header}
      testID="custom-provider-sheet"
      footer={footer}
    >
      <View style={styles.formBody}>
        {submitError ? <Alert variant="error" title={submitError} /> : null}
        <Field label={t("settings.providers.customProviders.form.name")} error={nameError}>
          <FormTextInput
            testID="custom-provider-name"
            initialValue={state.name}
            value={state.name}
            onChangeText={model.setName}
            placeholder={t("settings.providers.customProviders.form.namePlaceholder")}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </Field>
        {snapshot.mode === "create" ? (
          <Field
            label={t("settings.providers.customProviders.form.id")}
            hint={t("settings.providers.customProviders.form.idHint")}
            error={idError}
          >
            <FormTextInput
              testID="custom-provider-id"
              initialValue={state.id}
              value={state.id}
              onChangeText={model.setId}
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Field>
        ) : null}
        <Field label={t("settings.providers.customProviders.form.protocol")}>
          <SegmentedControl<ApiProtocol>
            options={protocolOptions}
            value={state.protocol}
            onValueChange={model.setProtocol}
            testID="custom-provider-protocol"
          />
        </Field>
        <Field label={t("settings.providers.customProviders.form.baseUrl")} error={baseUrlError}>
          <FormTextInput
            testID="custom-provider-base-url"
            initialValue={state.baseUrl}
            value={state.baseUrl}
            onChangeText={model.setBaseUrl}
            placeholder={baseUrlPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </Field>
        <SelectField<ApiRoute>
          label={t("settings.providers.customProviders.form.route")}
          value={state.via}
          selectedDisplay={routeDisplay}
          options={routeOptions}
          onChange={model.setVia}
          placeholder={t("settings.providers.customProviders.route.direct")}
          emptyText={t("settings.providers.customProviders.route.direct")}
          testID="custom-provider-route"
        />
        {state.via === "ssh" ? (
          <SelectField<string>
            label={t("settings.providers.customProviders.form.sshServer")}
            value={state.sshServerId}
            selectedDisplay={sshServerDisplay}
            options={sshServerOptions}
            onChange={model.setSshServerId}
            placeholder={t("settings.providers.customProviders.form.sshServer")}
            emptyText={t("settings.providers.customProviders.form.sshServerEmpty")}
            error={sshServerError}
            testID="custom-provider-ssh-server"
          />
        ) : null}
        <ApiKeySection model={model} state={state} />
        <DiscoverControls
          model={model}
          state={state}
          client={client}
          busy={saving || deleting}
          onTested={onTested}
          recordId={discoverRecordId}
        />
        <ModelsSection model={model} state={state} />
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  formBody: {
    gap: theme.spacing[3],
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  savedKeyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  discoverRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  modelsSection: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modelsTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  modelsEmpty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  modelRow: {
    gap: theme.spacing[2],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modelRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  modelRowTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  modelRowRemove: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  modelRowFields: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  modelRowFieldGrow: {
    flex: 1,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  radioDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: theme.colors.accent,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
    marginBottom: theme.spacing[1.5],
  },
  thinkingChipGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  chip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipActive: {
    borderColor: theme.colors.accent,
  },
  chipText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  chipTextActive: {
    color: theme.colors.foreground,
  },
  chipRemove: {
    width: 18,
    height: 18,
    alignItems: "center",
    justifyContent: "center",
  },
}));
