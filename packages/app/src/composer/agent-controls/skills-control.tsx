import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Sparkles } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useSkillCatalog } from "@/stores/skills-store";
import { useAgentSkillsStore, selectAttachedSkillIds } from "@/stores/agent-skills-store";
import { resolveSkillProvider, skillProviderLabel } from "@/skills/native-skill-logic";
import { buildSkillPickerModel, INSTALL_OPTION_PREFIX } from "@/skills/skill-picker-model";
import { useSkillActions } from "@/skills/ui/use-skill-actions";

interface SkillOptionRowProps {
  option: ComboboxOption;
  selected: boolean;
  active: boolean;
  installLabel: string | null;
  onPress: (optionId: string) => void;
}

function SkillOptionRow({
  option,
  selected,
  active,
  installLabel,
  onPress,
}: SkillOptionRowProps): ReactElement {
  const handlePress = useCallback(() => onPress(option.id), [onPress, option.id]);
  const trailingSlot = useMemo(
    () => (installLabel ? <Text style={styles.installLabel}>{installLabel}</Text> : null),
    [installLabel],
  );
  return (
    <ComboboxItem
      label={option.label}
      description={option.description}
      selected={selected}
      active={active}
      onPress={handlePress}
      trailingSlot={trailingSlot}
      testID={`composer-skill-option-${option.id}`}
    />
  );
}

function useAgentSkillContext(serverId: string, agentId: string) {
  const agentProvider = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.provider ?? null,
  );
  const agentCwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? null,
  );
  const { config } = useDaemonConfig(serverId);
  const provider = resolveSkillProvider(
    agentProvider,
    config?.providers as Record<string, unknown> | undefined,
  );
  return { provider, agentCwd };
}

export interface SkillsControlProps {
  agentId: string;
  serverId: string;
}

/**
 * Composer multi-select Skills picker (spec 22.7). Selecting a skill toggles it
 * onto the CURRENT agent (persisted per agentId); the picker stays open for
 * multi-select. On send the ids go with the message and the daemon adds the
 * provider's native invocation. A footer row toggles keyword auto-load.
 */
export function SkillsControl({ agentId, serverId }: SkillsControlProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const client = useHostRuntimeClient(serverId);
  const actions = useSkillActions(client);
  const { provider, agentCwd } = useAgentSkillContext(serverId, agentId);
  const catalog = useSkillCatalog(agentCwd);
  const rawAttachedIds = useAgentSkillsStore(selectAttachedSkillIds(agentId));
  const toggleAttached = useAgentSkillsStore((state) => state.toggleAttached);
  const replaceAttached = useAgentSkillsStore((state) => state.replaceAttached);
  const autoLoad = useAgentSkillsStore((state) => state.autoLoad);
  const setAutoLoad = useAgentSkillsStore((state) => state.setAutoLoad);

  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);

  const model = useMemo(
    () =>
      buildSkillPickerModel({
        skills: catalog.skills,
        provider,
        rawAttachedIds,
        catalogReady: catalog.status === "ready",
      }),
    [catalog.skills, catalog.status, provider, rawAttachedIds],
  );
  const attachedSet = useMemo(() => new Set(model.attachedIds), [model.attachedIds]);

  const handleSelect = useCallback(
    (optionId: string) => {
      if (!optionId.startsWith(INSTALL_OPTION_PREFIX)) {
        toggleAttached(agentId, optionId);
        return;
      }
      const entry = model.entriesById.get(optionId.slice(INSTALL_OPTION_PREFIX.length));
      if (!entry || !model.provider) return;
      void actions.installFor(entry, model.provider).then((installed) => {
        if (installed) replaceAttached(agentId, entry.skillId, installed.skillId);
        return undefined;
      });
    },
    [actions, agentId, model.entriesById, model.provider, replaceAttached, toggleAttached],
  );
  const handleToggleAutoLoad = useCallback(() => setAutoLoad(!autoLoad), [autoLoad, setAutoLoad]);
  const handlePress = useCallback(() => setOpen((prev) => !prev), []);

  const installLabel = model.provider
    ? t("skillsHub.picker.installFor", { provider: skillProviderLabel(model.provider) })
    : null;
  const renderOption = useCallback(
    (args: { option: ComboboxOption; selected: boolean; active: boolean }): ReactElement => {
      const isInstall = args.option.id.startsWith(INSTALL_OPTION_PREFIX);
      return (
        <SkillOptionRow
          key={args.option.id}
          option={args.option}
          selected={!isInstall && attachedSet.has(args.option.id)}
          active={args.active}
          installLabel={isInstall ? installLabel : null}
          onPress={handleSelect}
        />
      );
    },
    [attachedSet, handleSelect, installLabel],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <ComboboxItem
          label={t("skillsHub.picker.autoLoad")}
          description={t("skillsHub.picker.autoLoadHint")}
          selected={autoLoad}
          onPress={handleToggleAutoLoad}
          testID="composer-skill-autoload-toggle"
        />
      </View>
    ),
    [autoLoad, handleToggleAutoLoad, t],
  );

  const count = model.attachedCount;
  const label = t("skillsHub.picker.label");
  const value = count > 0 ? t("skillsHub.picker.value", { count }) : label;
  const accessibilityLabel =
    count > 0 ? t("skillsHub.picker.attachedA11y", { count }) : t("skillsHub.picker.attachA11y");
  let emptyText = t("skillsHub.picker.empty");
  if (catalog.status === "loading" || catalog.status === "idle") {
    emptyText = t("skillsHub.picker.loading");
  } else if (catalog.status === "error") {
    emptyText = catalog.error ?? t("skillsHub.states.errorTitle");
  }

  return (
    <>
      <AgentControlTrigger
        ref={anchorRef}
        icon={Sparkles}
        surface="toolbar"
        label={label}
        value={value}
        showToolbarLabel={!isCompact}
        badgeCount={count}
        showCaret={false}
        open={open}
        onPress={handlePress}
        accessibilityLabel={accessibilityLabel}
        testID="composer-skills-control"
      />
      <Combobox
        options={model.options}
        value=""
        onSelect={handleSelect}
        keepOpenOnSelect
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={300}
        title={label}
        searchable
        searchPlaceholder={t("skillsHub.picker.search")}
        emptyText={emptyText}
        renderOption={renderOption}
        footer={footer}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  installLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accent,
  },
  footer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[1],
  },
}));
