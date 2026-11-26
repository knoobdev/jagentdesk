import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ProviderModelRef } from "@jagentdesk/protocol/messages";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { getProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import { ComboboxItem } from "@/components/ui/combobox";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
  type SelectFieldRenderOptionInput,
} from "@/components/ui/select-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  addableModels,
  addableProviders,
  DEFAULT_MODEL_CHOICE,
  toProviderModelRef,
} from "./provider-model-choices";

export function ProviderGlyph({ provider }: { provider: string }): ReactElement {
  const Icon = getProviderIcon(provider);
  return <Icon size={16} color={styles.providerIcon.color} />;
}

function ProviderOption({
  option,
  selected,
  active,
  onPress,
}: SelectFieldRenderOptionInput<string>): ReactElement {
  const glyph = useMemo(() => <ProviderGlyph provider={option.value} />, [option.value]);
  return (
    <ComboboxItem
      testID={option.testID}
      label={option.label}
      selected={selected}
      active={active}
      onPress={onPress}
      leadingSlot={glyph}
    />
  );
}

function renderProviderOption(input: SelectFieldRenderOptionInput<string>): ReactElement {
  return <ProviderOption {...input} />;
}

/**
 * "Add provider" for the failover order and the child-provider list (spec 40 §6): pick an enabled
 * provider, then one of its models ("Default model" preselected). Entries already in the list are
 * not offered again.
 */
export function AddProviderModelSheet({
  serverId,
  listed,
  onAdd,
  onClose,
  testIDPrefix,
}: {
  serverId: string;
  listed: readonly ProviderModelRef[];
  onAdd: (ref: ProviderModelRef) => void;
  onClose: () => void;
  testIDPrefix: string;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const snapshot = useProvidersSnapshot(serverId);
  const defaultLabel = t("continuity.settings.defaultModel");
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string>(DEFAULT_MODEL_CHOICE);

  const providers = useMemo(
    () => addableProviders(snapshot.entries, listed),
    [listed, snapshot.entries],
  );
  const providerOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      providers.map((choice) => ({
        id: choice.provider,
        value: choice.provider,
        label: choice.label,
        testID: `${testIDPrefix}-provider-option-${choice.provider}`,
      })),
    [providers, testIDPrefix],
  );
  const selectedEntry = useMemo(
    () => snapshot.entries?.find((entry) => entry.provider === provider),
    [provider, snapshot.entries],
  );
  const models = useMemo(
    () => addableModels(selectedEntry, listed, defaultLabel),
    [defaultLabel, listed, selectedEntry],
  );
  const modelOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      models.map((choice) => ({
        id: choice.id === DEFAULT_MODEL_CHOICE ? "default" : choice.id,
        value: choice.id,
        label: choice.label,
        testID: `${testIDPrefix}-model-option-${choice.id === DEFAULT_MODEL_CHOICE ? "default" : choice.id}`,
      })),
    [models, testIDPrefix],
  );

  const providerDisplay = useMemo<SelectFieldDisplay | null>(() => {
    const choice = providers.find((candidate) => candidate.provider === provider);
    return choice ? { label: choice.label } : null;
  }, [provider, providers]);
  const modelDisplay = useMemo<SelectFieldDisplay | null>(() => {
    const choice = models.find((candidate) => candidate.id === model);
    return choice ? { label: choice.label } : null;
  }, [model, models]);

  const selectProvider = useCallback(
    (value: string) => {
      setProvider(value);
      // Every provider still offered has its default model free, so it is the starting choice.
      setModel(DEFAULT_MODEL_CHOICE);
    },
    [setProvider],
  );
  const selectModel = useCallback((value: string) => setModel(value), []);
  const modelAvailable = models.some((choice) => choice.id === model);
  const canAdd = provider !== null && modelAvailable;
  const handleAdd = useCallback(() => {
    if (!provider || !modelAvailable) return;
    onAdd(toProviderModelRef(provider, model));
  }, [model, modelAvailable, onAdd, provider]);

  const header = useMemo(() => ({ title: t("continuity.settings.addProvider") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button style={styles.footerButton} variant="secondary" onPress={onClose}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          style={styles.footerButton}
          onPress={handleAdd}
          disabled={!canAdd}
          testID={`${testIDPrefix}-add-confirm`}
        >
          {t("continuity.settings.add")}
        </Button>
      </View>
    ),
    [canAdd, handleAdd, onClose, t, testIDPrefix],
  );
  const providerLeading = useMemo(
    () => (provider ? <ProviderGlyph provider={provider} /> : null),
    [provider],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      onDismiss={onClose}
      footer={footer}
      desktopMaxWidth={480}
      testID={`${testIDPrefix}-add-sheet`}
    >
      <View style={styles.form}>
        <SelectField
          label={t("continuity.settings.provider")}
          value={provider}
          selectedDisplay={providerDisplay}
          options={providerOptions}
          onChange={selectProvider}
          placeholder={t("continuity.settings.chooseProvider")}
          emptyText={t("continuity.settings.noProviders")}
          loading={snapshot.isLoading}
          size={size}
          searchable
          searchPlaceholder={t("continuity.settings.searchProviders")}
          renderOption={renderProviderOption}
          triggerLeading={providerLeading}
          triggerTestID={`${testIDPrefix}-provider`}
        />
        <SelectField
          label={t("continuity.settings.model")}
          value={provider ? model : null}
          selectedDisplay={provider ? modelDisplay : null}
          options={modelOptions}
          onChange={selectModel}
          placeholder={t("continuity.settings.chooseProviderFirst")}
          emptyText={t("continuity.settings.noModels")}
          disabled={!provider}
          size={size}
          searchable
          searchPlaceholder={t("continuity.settings.searchModels")}
          triggerTestID={`${testIDPrefix}-model`}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: {
    gap: theme.spacing[4],
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  footerButton: {
    flex: 1,
  },
  providerIcon: {
    color: theme.colors.foregroundMuted,
  },
}));
