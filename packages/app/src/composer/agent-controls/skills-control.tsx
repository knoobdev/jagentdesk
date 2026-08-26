import { useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Sparkles } from "lucide-react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Combobox, ComboboxItem, type ComboboxOption } from "@/components/ui/combobox";
import { AgentControlTrigger } from "@/composer/agent-controls/control";
import { useSkillsStore, type Skill } from "@/stores/skills-store";
import { useAgentSkillsStore, selectAttachedSkillIds } from "@/stores/agent-skills-store";

interface SkillOptionRowProps {
  skill: Skill;
  selected: boolean;
  active: boolean;
  onToggle: (skillId: string) => void;
}

function SkillOptionRow({ skill, selected, active, onToggle }: SkillOptionRowProps): ReactElement {
  const handlePress = useCallback(() => onToggle(skill.id), [onToggle, skill.id]);
  const leadingSlot = useMemo(
    () => <Text style={styles.optionIcon}>{skill.icon}</Text>,
    [skill.icon],
  );
  return (
    <ComboboxItem
      label={skill.name}
      description={skill.description || undefined}
      selected={selected}
      active={active}
      onPress={handlePress}
      leadingSlot={leadingSlot}
      testID={`composer-skill-option-${skill.id}`}
    />
  );
}

export interface SkillsControlProps {
  agentId: string;
}

/**
 * Composer multi-select skill picker (redesign B3). Mirrors the mode/model
 * pickers: an AgentControlTrigger pill that opens a Combobox. Selecting a skill
 * toggles it onto the CURRENT agent (persisted per agentId); the picker stays
 * open for multi-select. A footer row toggles auto-load (B5).
 */
export function SkillsControl({ agentId }: SkillsControlProps): ReactElement {
  const isCompact = useIsCompactFormFactor();
  const skills = useSkillsStore((state) => state.skills);
  const attachedIds = useAgentSkillsStore(selectAttachedSkillIds(agentId));
  const toggleAttached = useAgentSkillsStore((state) => state.toggleAttached);
  const autoLoad = useAgentSkillsStore((state) => state.autoLoad);
  const setAutoLoad = useAgentSkillsStore((state) => state.setAutoLoad);

  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);

  const attachedSet = useMemo(() => new Set(attachedIds), [attachedIds]);
  const options = useMemo<ComboboxOption[]>(
    () => skills.map((skill) => ({ id: skill.id, label: skill.name })),
    [skills],
  );

  const handleToggle = useCallback(
    (skillId: string) => toggleAttached(agentId, skillId),
    [agentId, toggleAttached],
  );
  const handleToggleAutoLoad = useCallback(() => setAutoLoad(!autoLoad), [autoLoad, setAutoLoad]);
  const handlePress = useCallback(() => setOpen((prev) => !prev), []);

  const renderOption = useCallback(
    (args: { option: ComboboxOption; selected: boolean; active: boolean }): ReactElement => {
      const skill = skills.find((candidate) => candidate.id === args.option.id);
      if (!skill) return <View key={args.option.id} />;
      return (
        <SkillOptionRow
          skill={skill}
          selected={attachedSet.has(skill.id)}
          active={args.active}
          onToggle={handleToggle}
        />
      );
    },
    [attachedSet, handleToggle, skills],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <ComboboxItem
          label="Auto-load skills by message"
          description="Match relevant skills to what you ask"
          selected={autoLoad}
          onPress={handleToggleAutoLoad}
          testID="composer-skill-autoload-toggle"
        />
      </View>
    ),
    [autoLoad, handleToggleAutoLoad],
  );

  const count = attachedIds.length;
  const value = count > 0 ? `Skills · ${count}` : "Skills";
  const accessibilityLabel = count > 0 ? `Skills, ${count} attached` : "Attach skills";

  return (
    <>
      <AgentControlTrigger
        ref={anchorRef}
        icon={Sparkles}
        surface="toolbar"
        label="Skills"
        value={value}
        showToolbarLabel={!isCompact}
        showCaret={false}
        open={open}
        onPress={handlePress}
        accessibilityLabel={accessibilityLabel}
        testID="composer-skills-control"
      />
      <Combobox
        options={options}
        value=""
        onSelect={handleToggle}
        keepOpenOnSelect
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        desktopPlacement="top-start"
        desktopMinWidth={280}
        title="Skills"
        emptyText="No skills yet. Create one on the Skills screen."
        renderOption={renderOption}
        footer={footer}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  optionIcon: {
    fontSize: 16,
    textAlign: "center",
  },
  footer: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[1],
  },
}));
