import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SkillScope } from "@jagentdesk/protocol/native-skills";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import type { SkillProjectOption } from "@/skills/native-skill-logic";
import type { Theme } from "@/styles/theme";

export interface ScopeValue {
  scope: SkillScope;
  /** Project root for `project` scope (sent as `cwd`). */
  projectPath: string | null;
}

interface ProjectSelectProps {
  label: string;
  value: string | null;
  projects: SkillProjectOption[];
  onChange: (path: string | null) => void;
  allowNone?: boolean;
  testID?: string;
}

const NONE = "";

/** Pick one of the host's project roots (from its workspaces). */
export function ProjectSelect({
  label,
  value,
  projects,
  onChange,
  allowNone = false,
  testID,
}: ProjectSelectProps) {
  const { t } = useTranslation();
  const options = useMemo<SelectFieldOption<string>[]>(() => {
    const list = projects.map((project) => ({
      id: project.path,
      value: project.path,
      label: project.label,
      description: project.path,
    }));
    return allowNone
      ? [{ id: "__none__", value: NONE, label: t("skillsHub.project.none") }, ...list]
      : list;
  }, [allowNone, projects, t]);
  const selected = useMemo(() => {
    const match = projects.find((project) => project.path === value);
    if (match) return { label: match.label, description: match.path };
    return allowNone ? { label: t("skillsHub.project.none") } : null;
  }, [allowNone, projects, t, value]);
  const handleChange = useCallback(
    (next: string) => onChange(next === NONE ? null : next),
    [onChange],
  );
  return (
    <SelectField
      label={label}
      value={value ?? NONE}
      selectedDisplay={selected}
      options={options}
      onChange={handleChange}
      placeholder={t("skillsHub.project.placeholder")}
      emptyText={t("skillsHub.project.empty")}
      searchable
      searchPlaceholder={t("skillsHub.project.searchPlaceholder")}
      title={label}
      size="sm"
      testID={testID}
    />
  );
}

interface ScopePickerProps {
  value: ScopeValue;
  onChange: (value: ScopeValue) => void;
  projects: SkillProjectOption[];
  label: string;
}

/** Global / This project (spec 22.6 install + create), with the project picker. */
export function ScopePicker({ value, onChange, projects, label }: ScopePickerProps) {
  const { t } = useTranslation();
  const options = useMemo<SegmentedControlOption<SkillScope>[]>(
    () => [
      { value: "global", label: t("skillsHub.item.scopeGlobal"), testID: "skills-scope-global" },
      { value: "project", label: t("skillsHub.item.scopeProject"), testID: "skills-scope-project" },
    ],
    [t],
  );
  const handleScope = useCallback(
    (scope: SkillScope) => onChange({ ...value, scope }),
    [onChange, value],
  );
  const handleProject = useCallback(
    (projectPath: string | null) => onChange({ ...value, projectPath }),
    [onChange, value],
  );
  const hint =
    value.scope === "global"
      ? t("skillsHub.item.scopeGlobalHint")
      : t("skillsHub.item.scopeProjectHint");
  return (
    <View style={styles.block}>
      <Text style={styles.label}>{label}</Text>
      <SegmentedControl
        options={options}
        value={value.scope}
        onValueChange={handleScope}
        size="sm"
      />
      <Text style={styles.hint}>{hint}</Text>
      {value.scope === "project" ? (
        <ProjectSelect
          label={t("skillsHub.project.label")}
          value={value.projectPath}
          projects={projects}
          onChange={handleProject}
          testID="skills-scope-project-select"
        />
      ) : null}
    </View>
  );
}

/** A project scope without a project cannot be installed/created. */
export function scopeIsComplete(value: ScopeValue): boolean {
  return value.scope === "global" || Boolean(value.projectPath);
}

export function scopeRequest(value: ScopeValue): { scope: SkillScope; cwd?: string } {
  return value.scope === "project" && value.projectPath
    ? { scope: "project", cwd: value.projectPath }
    : { scope: "global" };
}

const styles = StyleSheet.create((theme: Theme) => ({
  block: { gap: theme.spacing[2] },
  label: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
}));
