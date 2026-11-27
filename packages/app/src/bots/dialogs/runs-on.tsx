// "Runs on <host/> with <agent/>" + "Change", ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/BotRunsOnPicker.tsx:72-260 (the `row` variant: a boxed summary that
// opens to the fields). JAgentDesk has no Computer picker (spec 37.2.2): the host is the one in use;
// "Change" opens Provider and Model, both searchable by name and id (spec 37.5 part 5).
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Trans, useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react-native";
import { Combobox } from "@/components/ui/combobox";
import { Field } from "@/components/ui/form-field";
import { SelectFieldTrigger, type SelectFieldDisplay } from "@/components/ui/select-field";
import type { Theme } from "@/styles/theme";
import { filterPickerOptions, type NewBotFormModel, type NewBotFormState } from "./new-bot-model";

const ThemedChevronDown = withUnistyles(ChevronDown);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

interface SearchPickerOption {
  id: string;
  label: string;
  description?: string;
}

/** A field whose list is searched by plain substring of name or id (A37.5.3b). */
function SearchPicker({
  label,
  value,
  display,
  options,
  onSelect,
  searchPlaceholder,
  emptyText,
  placeholder,
  testID,
}: {
  label: string;
  value: string | null;
  display: SelectFieldDisplay | null;
  options: readonly SearchPickerOption[];
  onSelect: (id: string, label: string) => void;
  searchPlaceholder: string;
  emptyText: string;
  placeholder: string;
  testID: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const anchorRef = useRef<View | null>(null);
  const shown = useMemo(() => filterPickerOptions(options, query), [options, query]);
  const openPicker = useCallback(() => {
    setQuery("");
    setOpen(true);
  }, []);
  const select = useCallback(
    (id: string) => {
      const option = options.find((entry) => entry.id === id);
      if (option) onSelect(option.id, option.label);
      setOpen(false);
    },
    [onSelect, options],
  );
  const renderTrigger = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => (
      <SelectFieldTrigger
        display={display}
        placeholder={placeholder}
        hovered={Boolean(hovered)}
        active={pressed || open}
        size="sm"
      />
    ),
    [display, open, placeholder],
  );
  return (
    <Field label={label} testID={testID}>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          onPress={openPicker}
          accessibilityRole="button"
          accessibilityLabel={`${label} (${display?.label ?? placeholder})`}
          testID={`${testID}-trigger`}
        >
          {renderTrigger}
        </Pressable>
      </View>
      <Combobox
        options={shown}
        value={value ?? ""}
        onSelect={select}
        searchable
        remoteSearch
        onSearchQueryChange={setQuery}
        searchPlaceholder={searchPlaceholder}
        emptyText={emptyText}
        title={label}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
      />
    </Field>
  );
}

export function BotRunsOnPicker({
  model,
  state,
  hostLabel,
}: {
  model: NewBotFormModel;
  state: NewBotFormState;
  hostLabel: string;
}) {
  const { t } = useTranslation();
  const toggle = useCallback(() => model.toggleRunsOn(), [model]);
  const providerOptions = useMemo(
    () =>
      state.providers.map((entry) => ({
        id: entry.provider,
        label: entry.label ?? entry.provider,
      })),
    [state.providers],
  );
  const modelOptions = useMemo(() => {
    const entry = state.providers.find((candidate) => candidate.provider === state.provider);
    return (entry?.models ?? [])
      .filter((candidate) => candidate.isSelectable !== false)
      .map((candidate) => ({ id: candidate.id, label: candidate.label }));
  }, [state.providers, state.provider]);
  const selectProvider = useCallback((id: string) => model.selectProvider(id), [model]);
  const selectModel = useCallback(
    (id: string, label: string) => model.selectModel(id, label),
    [model],
  );
  const providerDisplay = useMemo(
    () => (state.provider ? { label: state.providerLabel } : null),
    [state.provider, state.providerLabel],
  );
  const modelDisplay = useMemo(
    () => (state.model ? { label: state.modelLabel || state.model } : null),
    [state.model, state.modelLabel],
  );
  const agentLabel = state.noAgents
    ? t("bots.new.agent")
    : [state.providerLabel, state.modelLabel || state.model].filter(Boolean).join(" · ");
  const runsOnParts = useMemo(
    () => ({
      host: <Text style={styles.strong}>{hostLabel}</Text>,
      agent: (
        <Text style={styles.strong} testID="new-bot-runs-on-agent">
          {agentLabel}
        </Text>
      ),
    }),
    [agentLabel, hostLabel],
  );
  return (
    <View style={styles.box}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        aria-expanded={state.runsOnOpen}
        style={styles.summary}
        testID="new-bot-runs-on"
      >
        <Text style={styles.line} numberOfLines={2}>
          <Trans i18nKey="bots.new.runsOn" components={runsOnParts} />
        </Text>
        <View style={styles.change}>
          <Text style={styles.changeLabel}>{t("bots.new.change")}</Text>
          <ThemedChevronDown size={16} uniProps={muted} />
        </View>
      </Pressable>
      {state.runsOnOpen ? (
        <View style={styles.fields}>
          <SearchPicker
            label={t("bots.jad.dialogs.provider")}
            value={state.provider}
            display={providerDisplay}
            options={providerOptions}
            onSelect={selectProvider}
            searchPlaceholder={t("bots.jad.dialogs.searchProviders")}
            emptyText={t("bots.jad.dialogs.noMatches")}
            placeholder={t("bots.jad.dialogs.choose")}
            testID="new-bot-provider"
          />
          <SearchPicker
            label={t("bots.jad.dialogs.model")}
            value={state.model || null}
            display={modelDisplay}
            options={modelOptions}
            onSelect={selectModel}
            searchPlaceholder={t("bots.jad.dialogs.searchModels")}
            emptyText={t("bots.jad.dialogs.noMatches")}
            placeholder={t("bots.jad.dialogs.choose")}
            testID="new-bot-model"
          />
        </View>
      ) : null}
      {state.submitted && state.noAgents ? (
        <Text style={styles.error} accessibilityRole="alert" testID="new-bot-no-agents">
          {t("bots.new.validation.noAgentsAvailable")}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  box: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
  },
  summary: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  line: { flex: 1, fontSize: 13, color: theme.colors.foregroundMuted },
  strong: { fontWeight: "500", color: theme.colors.foreground },
  change: { flexDirection: "row", alignItems: "center", gap: 4 },
  changeLabel: { fontSize: 13, color: theme.colors.foregroundMuted },
  fields: { gap: 12, paddingHorizontal: 12, paddingBottom: 12 },
  error: {
    fontSize: 12,
    color: theme.colors.statusDanger,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
}));
