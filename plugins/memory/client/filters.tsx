import { useCallback, useMemo } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { MemoryKindWire, MemoryProject, MemoryStatusWire } from "@jagentdesk/protocol/memory";
import { MEMORY_STATUSES, type MemoryScope } from "../shared/types";
import {
  SegmentedControl,
  SelectField,
  type SegmentedControlOption,
  type Theme,
} from "../../../packages/app/src/plugins/builtin/host-api";

export type KindFilter = "all" | MemoryKindWire;
const ANY_STATUS = "any";
type StatusFilter = MemoryStatusWire | typeof ANY_STATUS;

export interface MemoryFiltersProps {
  /** Phones: two rows (scope + project, kind + status) instead of one wrapping row. */
  compact: boolean;
  scope: MemoryScope;
  onScopeChange: (scope: MemoryScope) => void;
  kind: KindFilter;
  onKindChange: (kind: KindFilter) => void;
  status: MemoryStatusWire | null;
  onStatusChange: (status: MemoryStatusWire | null) => void;
  projects: readonly MemoryProject[];
  projectId: string | null;
  onProjectChange: (projectId: string) => void;
}

/** The Memory page's tab row: Project / Global, kind, status and the project picker. */
export function MemoryFilters({
  compact,
  scope,
  onScopeChange,
  kind,
  onKindChange,
  status,
  onStatusChange,
  projects,
  projectId,
  onProjectChange,
}: MemoryFiltersProps) {
  const { t } = useTranslation();
  const scopeOptions = useMemo<SegmentedControlOption<MemoryScope>[]>(
    () => [
      { value: "project", label: t("memory.tabs.project"), testID: "memory-tab-project" },
      { value: "global", label: t("memory.tabs.global"), testID: "memory-tab-global" },
    ],
    [t],
  );
  const kindOptions = useMemo<SegmentedControlOption<KindFilter>[]>(
    () => [
      { value: "all", label: t("memory.filters.all"), testID: "memory-kind-all" },
      { value: "memory", label: t("memory.filters.memories"), testID: "memory-kind-memory" },
      { value: "lesson", label: t("memory.filters.lessons"), testID: "memory-kind-lesson" },
    ],
    [t],
  );
  const statusOptions = useMemo(
    () => [
      { id: ANY_STATUS, value: ANY_STATUS as StatusFilter, label: t("memory.filters.anyStatus") },
      ...MEMORY_STATUSES.map((value) => ({
        id: value,
        value: value as StatusFilter,
        label: t(`memory.status.${value}`),
      })),
    ],
    [t],
  );
  const changeStatus = useCallback(
    (value: StatusFilter) => onStatusChange(value === ANY_STATUS ? null : value),
    [onStatusChange],
  );
  const statusDisplay = useMemo(
    () => ({ label: status ? t(`memory.status.${status}`) : t("memory.filters.anyStatus") }),
    [status, t],
  );
  const projectOptions = useMemo(
    () =>
      projects.map((project) => ({
        id: project.projectId,
        value: project.projectId,
        label: project.name,
        description: project.rootPath,
      })),
    [projects],
  );
  const selectedProject = projects.find((project) => project.projectId === projectId) ?? null;
  const selectedDisplay = useMemo(
    () => (selectedProject ? { label: selectedProject.name } : null),
    [selectedProject],
  );

  const scopeControl = (
    <SegmentedControl
      options={scopeOptions}
      value={scope}
      onValueChange={onScopeChange}
      testID="memory-tabs"
    />
  );
  const kindControl = (
    <SegmentedControl
      options={kindOptions}
      value={kind}
      onValueChange={onKindChange}
      testID="memory-kind-filter"
    />
  );
  const statusControl = (
    <View style={compact ? styles.compactSelect : styles.statusSelect}>
      <SelectField
        label={t("memory.filters.status")}
        value={status ?? ANY_STATUS}
        selectedDisplay={statusDisplay}
        options={statusOptions}
        onChange={changeStatus}
        placeholder={t("memory.filters.anyStatus")}
        emptyText={t("memory.filters.anyStatus")}
        field={false}
        size="sm"
        testID="memory-status-filter"
      />
    </View>
  );
  const projectControl =
    scope === "project" ? (
      <View style={compact ? styles.compactSelect : styles.projectSelect}>
        <SelectField
          label={t("memory.project.label")}
          value={projectId}
          selectedDisplay={selectedDisplay}
          options={projectOptions}
          onChange={onProjectChange}
          placeholder={t("memory.project.label")}
          emptyText={t("memory.project.none")}
          field={false}
          size="sm"
          testID="memory-project-select"
        />
      </View>
    ) : null;

  if (compact) {
    return (
      <View style={styles.compactBars}>
        <View style={styles.compactBar}>
          {scopeControl}
          {projectControl}
        </View>
        <View style={styles.compactBar}>
          {kindControl}
          {statusControl}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.bar}>
      {scopeControl}
      {kindControl}
      {statusControl}
      {projectControl}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  bar: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  projectSelect: { minWidth: 220, maxWidth: 360, flexGrow: 1 },
  statusSelect: { minWidth: 160, maxWidth: 220 },
  compactBars: { gap: theme.spacing[2] },
  compactBar: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  compactSelect: { flex: 1, minWidth: 0 },
}));
