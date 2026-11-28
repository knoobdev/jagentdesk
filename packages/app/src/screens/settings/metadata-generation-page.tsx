import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { AgentProvider } from "@jagentdesk/protocol/agent-types";
import type { MutableDaemonConfigPatch } from "@jagentdesk/protocol/messages";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { CombinedModelSelector } from "@/components/combined-model-selector";
import { SettingsRow } from "@/components/settings";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useHostFeature } from "@/runtime/host-features";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { settingsStyles } from "@/styles/settings";

type SelectionMode = "automatic" | "preferred";

function MetadataInstructionsSheet({
  initialInstructions,
  patchConfig,
  onClose,
}: {
  initialInstructions: string;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initialInstructions);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const header = useMemo<SheetHeader>(
    () => ({
      title: t("settings.metadataGeneration.instructions"),
      subtitle: (
        <Text style={styles.sheetSubtitle}>
          {t("settings.metadataGeneration.instructionsHint")}
        </Text>
      ),
    }),
    [t],
  );

  const normalizedDraft = draft.trim();
  const canSave = normalizedDraft !== initialInstructions && !isSaving;

  const handleChangeText = useCallback((nextText: string) => {
    setDraft(nextText);
    setError(null);
  }, []);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    onClose();
  }, [isSaving, onClose]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const updated = await patchConfig({
        metadataGeneration: { instructions: normalizedDraft },
      });
      if (!updated) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSaving(false);
    }
  }, [normalizedDraft, onClose, patchConfig, t]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={handleClose}
      testID="metadata-generation-instructions-sheet"
      desktopMaxWidth={560}
    >
      <FormTextInput
        value={draft}
        onChangeText={handleChangeText}
        placeholder={t("settings.metadataGeneration.instructionsPlaceholder")}
        accessibilityLabel={t("settings.metadataGeneration.instructions")}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
        autoFocus
        editable={!isSaving}
        invalid={error !== null}
        style={styles.instructionsInput}
        testID="metadata-generation-instructions-input"
      />
      {error ? (
        <Text
          accessibilityRole="alert"
          style={settingsStyles.rowError}
          testID="metadata-generation-instructions-error"
        >
          {error}
        </Text>
      ) : null}
      <View style={styles.sheetActions}>
        <Button variant="ghost" onPress={handleClose} disabled={isSaving}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={handleSave}
          disabled={!canSave}
          loading={isSaving}
          testID="metadata-generation-instructions-save"
        >
          {t("settings.metadataGeneration.saveInstructions")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}

function MetadataInstructionsRow({
  savedInstructions,
  patchConfig,
}: {
  savedInstructions: string;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const summary = savedInstructions ? savedInstructions.replace(/\s+/g, " ") : null;

  const handleOpen = useCallback(() => setIsEditing(true), []);
  const handleClose = useCallback(() => setIsEditing(false), []);
  const hint = useMemo(
    () =>
      summary ? (
        <Text
          style={settingsStyles.rowHint}
          numberOfLines={2}
          testID="metadata-generation-instructions-summary"
        >
          {summary}
        </Text>
      ) : (
        t("settings.metadataGeneration.instructionsHint")
      ),
    [summary, t],
  );

  return (
    <View style={settingsStyles.rowBorder}>
      <SettingsRow
        label={t("settings.metadataGeneration.instructions")}
        hint={hint}
        testID="metadata-generation-instructions-row"
      >
        <Button
          variant="outline"
          size="sm"
          onPress={handleOpen}
          testID="metadata-generation-instructions-edit"
        >
          {t("settings.metadataGeneration.editInstructions")}
        </Button>
      </SettingsRow>
      {isEditing ? (
        <MetadataInstructionsSheet
          initialInstructions={savedInstructions}
          patchConfig={patchConfig}
          onClose={handleClose}
        />
      ) : null}
    </View>
  );
}

function MetadataModelSelectionRows({
  serverId,
  configuredProviders,
  patchConfig,
}: {
  serverId: string;
  configuredProviders: Array<{ provider: string; model?: string; thinkingOptionId?: string }>;
  patchConfig: (patch: MutableDaemonConfigPatch) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const snapshot = useProvidersSnapshot(serverId);
  const configuredProvider = configuredProviders[0] ?? null;
  const providers = useMemo(
    () =>
      buildSelectableProviderSelectorProviders(snapshot.entries, {
        selectedProvider: configuredProvider?.provider ?? null,
      }),
    [configuredProvider?.provider, snapshot.entries],
  );
  const savedMode: SelectionMode = configuredProvider ? "preferred" : "automatic";
  const [draftMode, setDraftMode] = useState<SelectionMode | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const mode = draftMode ?? savedMode;

  useEffect(() => {
    setDraftMode(null);
  }, [configuredProvider?.model, configuredProvider?.provider]);

  const modeOptions = useMemo(
    () => [
      { value: "automatic" as const, label: t("settings.metadataGeneration.automatic") },
      { value: "preferred" as const, label: t("settings.metadataGeneration.preferred") },
    ],
    [t],
  );

  const saveProviders = useCallback(
    async (providersPatch: { provider: string; model?: string }[]) => {
      setIsSaving(true);
      try {
        await patchConfig({ metadataGeneration: { providers: providersPatch } });
      } catch (error) {
        setDraftMode(null);
        Alert.alert(
          t("settings.metadataGeneration.saveError"),
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [patchConfig, t],
  );

  const handleModeChange = useCallback(
    (next: SelectionMode) => {
      setDraftMode(next);
      if (next === "automatic") {
        void saveProviders([]);
      }
    },
    [saveProviders],
  );

  const handleModelSelect = useCallback(
    (provider: AgentProvider, model: string) => {
      setDraftMode("preferred");
      void saveProviders([
        { provider, ...(model ? { model } : {}) },
        ...configuredProviders.slice(1),
      ]);
    },
    [configuredProviders, saveProviders],
  );

  const handleSelectorOpen = useCallback(() => {
    snapshot.refetchIfStale(configuredProvider?.provider);
  }, [configuredProvider?.provider, snapshot]);
  const handleRetryProvider = useCallback(
    (provider: AgentProvider) => snapshot.refresh([provider]),
    [snapshot],
  );

  return (
    <>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>{t("settings.metadataGeneration.selection")}</Text>
          <Text style={settingsStyles.rowHint}>
            {mode === "automatic"
              ? t("settings.metadataGeneration.automaticHint")
              : t("settings.metadataGeneration.preferredHint")}
          </Text>
        </View>
        <SegmentedControl
          options={modeOptions}
          value={mode}
          onValueChange={handleModeChange}
          testID="metadata-generation-mode"
        />
      </View>
      {mode === "preferred" ? (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>{t("settings.metadataGeneration.model")}</Text>
            <Text style={settingsStyles.rowHint}>{t("settings.metadataGeneration.modelHint")}</Text>
          </View>
          <CombinedModelSelector
            providers={providers}
            selectedProvider={configuredProvider?.provider ?? ""}
            selectedModel={configuredProvider?.model ?? ""}
            onSelect={handleModelSelect}
            isLoading={snapshot.isLoading || snapshot.isFetching}
            onOpen={handleSelectorOpen}
            onRetryProvider={handleRetryProvider}
            isRetryingProvider={snapshot.isRefreshing}
            disabled={isSaving}
            serverId={serverId}
            desktopPlacement="bottom-start"
            desktopMinWidth={360}
          />
        </View>
      ) : null}
    </>
  );
}

export function MetadataGenerationPage({ serverId }: { serverId: string }) {
  const { t } = useTranslation();
  const { config, isLoading: isConfigLoading, patchConfig } = useDaemonConfig(serverId);
  // COMPAT(metadataGenerationInstructions): added in v0.12.3, remove gate after 2027-06-01.
  const supportsInstructions = useHostFeature(serverId, "metadataGenerationInstructions");

  if (isConfigLoading || !config) {
    return (
      <View style={styles.loading}>
        <LoadingSpinner size="large" color={styles.spinnerColor.color} />
      </View>
    );
  }

  return (
    <SettingsSection
      title={t("settings.metadataGeneration.title")}
      info={t("settings.metadataGeneration.description")}
      testID="metadata-generation-settings"
    >
      <View style={settingsStyles.card}>
        <MetadataModelSelectionRows
          serverId={serverId}
          configuredProviders={config.metadataGeneration.providers}
          patchConfig={patchConfig}
        />
        {supportsInstructions ? (
          <MetadataInstructionsRow
            key={serverId}
            savedInstructions={config.metadataGeneration.instructions ?? ""}
            patchConfig={patchConfig}
          />
        ) : null}
      </View>
    </SettingsSection>
  );
}

const styles = StyleSheet.create((theme) => ({
  loading: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 180,
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  sheetSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  instructionsInput: {
    minHeight: 112,
  },
  sheetActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
