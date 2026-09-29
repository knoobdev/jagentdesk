import { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View, type ListRenderItemInfo } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { SkillEntry, SkillWrittenPaths } from "@jagentdesk/protocol/native-skills";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loadSkillCatalog, useSkillCatalog } from "@/stores/skills-store";
import {
  DEFAULT_INSTALLED_FILTERS,
  filterInstalledSkills,
  presentProviders,
  presentSourceKinds,
  skillProviderLabel,
  type InstalledSkillFilters,
  type SkillOwnershipFilter,
  type SkillScopeFilter,
} from "@/skills/native-skill-logic";
import { ChipGroup, SectionTitle, type ChipOption } from "@/skills/ui/skill-chrome";
import { SkillRow, type SkillRowHandlers } from "@/skills/ui/skill-row";
import type { Theme } from "@/styles/theme";

type Translate = ReturnType<typeof useTranslation>["t"];

/** i18n key suffix of a source kind (`provider-runtime` → `providerRuntime`). */
export function sourceKindKey(kind: string): string {
  return kind.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function useFilterOptions(skills: SkillEntry[], t: Translate) {
  return useMemo(() => {
    const all = t("skillsHub.filters.all");
    const provider: ChipOption<string>[] = [
      { value: "all", label: all },
      ...presentProviders(skills).map((id) => ({ value: id, label: skillProviderLabel(id) })),
    ];
    const scope: ChipOption<SkillScopeFilter>[] = [
      { value: "all", label: all },
      { value: "global", label: t("skillsHub.scope.global") },
      { value: "project", label: t("skillsHub.scope.project") },
    ];
    const source: ChipOption<string>[] = [
      { value: "all", label: all },
      ...presentSourceKinds(skills).map((kind) => ({
        value: kind,
        label: t(`skillsHub.sourceKind.${sourceKindKey(kind)}`),
      })),
    ];
    const ownership: ChipOption<SkillOwnershipFilter>[] = [
      { value: "all", label: all },
      { value: "owned", label: t("skillsHub.filters.owned") },
      { value: "external", label: t("skillsHub.filters.external") },
    ];
    return { provider, scope, source, ownership };
  }, [skills, t]);
}

interface InstalledFiltersProps {
  skills: SkillEntry[];
  filters: InstalledSkillFilters;
  onChange: (patch: Partial<InstalledSkillFilters>) => void;
  resultCount: number;
}

function InstalledFilters({ skills, filters, onChange, resultCount }: InstalledFiltersProps) {
  const { t } = useTranslation();
  const options = useFilterOptions(skills, t);
  const setQuery = useCallback((query: string) => onChange({ query }), [onChange]);
  const setProvider = useCallback((provider: string) => onChange({ provider }), [onChange]);
  const setScope = useCallback((scope: SkillScopeFilter) => onChange({ scope }), [onChange]);
  const setSource = useCallback((source: string) => onChange({ source }), [onChange]);
  const setOwnership = useCallback(
    (ownership: SkillOwnershipFilter) => onChange({ ownership }),
    [onChange],
  );
  return (
    <View style={styles.filters}>
      <AdaptiveTextInput
        style={styles.search}
        initialValue={filters.query}
        onChangeText={setQuery}
        placeholder={t("skillsHub.filters.search")}
        autoCapitalize="none"
        autoCorrect={false}
        testID="skills-installed-search"
      />
      <ChipGroup
        label={t("skillsHub.filters.provider")}
        options={options.provider}
        value={filters.provider}
        onChange={setProvider}
        testIDPrefix="skills-filter-provider"
      />
      <ChipGroup
        label={t("skillsHub.filters.scope")}
        options={options.scope}
        value={filters.scope}
        onChange={setScope}
        testIDPrefix="skills-filter-scope"
      />
      <ChipGroup
        label={t("skillsHub.filters.source")}
        options={options.source}
        value={filters.source}
        onChange={setSource}
        testIDPrefix="skills-filter-source"
      />
      <ChipGroup
        label={t("skillsHub.filters.ownership")}
        options={options.ownership}
        value={filters.ownership}
        onChange={setOwnership}
        testIDPrefix="skills-filter-owner"
      />
      <Text style={styles.count}>{t("skillsHub.filters.resultCount", { count: resultCount })}</Text>
    </View>
  );
}

function WrittenPathRow({ path, onCopy }: { path: string; onCopy: (path: string) => void }) {
  const handlePress = useCallback(() => onCopy(path), [onCopy, path]);
  return (
    <Pressable onPress={handlePress} accessibilityRole="button" style={styles.pathRow}>
      <Text style={styles.pathText} selectable>
        {path}
      </Text>
    </Pressable>
  );
}

/** ADR-0022 decision 3: every absolute path JAgentDesk wrote, plus its lock file. */
function WrittenPathsSection({
  written,
  onCopy,
}: {
  written: SkillWrittenPaths | null;
  onCopy: (path: string) => void;
}) {
  const { t } = useTranslation();
  if (!written) return null;
  return (
    <View style={styles.written} testID="skills-written-paths">
      <SectionTitle title={t("skillsHub.written.title")} />
      <Text style={styles.hint}>{t("skillsHub.written.hint")}</Text>
      <Text style={styles.label}>{t("skillsHub.written.lockFile")}</Text>
      <WrittenPathRow path={written.lockPath} onCopy={onCopy} />
      {written.paths.length === 0 ? (
        <Text style={styles.hint}>{t("skillsHub.written.empty")}</Text>
      ) : (
        written.paths.map((path) => <WrittenPathRow key={path} path={path} onCopy={onCopy} />)
      )}
    </View>
  );
}

function InstalledEmpty({
  status,
  error,
  filtered,
  cwd,
}: {
  status: string;
  error: string | null;
  filtered: boolean;
  cwd: string | null;
}) {
  const { t } = useTranslation();
  const handleRetry = useCallback(() => loadSkillCatalog(cwd, { force: true }), [cwd]);
  if (status === "loading" || status === "idle") {
    return <Text style={styles.empty}>{t("skillsHub.states.loading")}</Text>;
  }
  if (status === "error") {
    return (
      <Alert variant="error" title={t("skillsHub.states.errorTitle")} description={error ?? ""}>
        <Button variant="outline" size="sm" onPress={handleRetry}>
          {t("skillsHub.states.retry")}
        </Button>
      </Alert>
    );
  }
  return (
    <Text style={styles.empty}>
      {filtered ? t("skillsHub.states.noMatches") : t("skillsHub.states.empty")}
    </Text>
  );
}

export interface InstalledTabProps {
  /** Project root whose project-scope skills are listed too; null = global only. */
  cwd: string | null;
  busyIds: ReadonlySet<string>;
  handlers: SkillRowHandlers;
  onCopyWrittenPath: (path: string) => void;
}

export function InstalledTab({ cwd, busyIds, handlers, onCopyWrittenPath }: InstalledTabProps) {
  const insets = useSafeAreaInsets();
  const catalog = useSkillCatalog(cwd);
  const [filters, setFilters] = useState<InstalledSkillFilters>(DEFAULT_INSTALLED_FILTERS);
  const handleFilters = useCallback(
    (patch: Partial<InstalledSkillFilters>) => setFilters((prev) => ({ ...prev, ...patch })),
    [],
  );
  const visible = useMemo(
    () => filterInstalledSkills(catalog.skills, filters),
    [catalog.skills, filters],
  );
  const isFiltered =
    catalog.skills.length > 0 &&
    (filters.query.trim() !== "" ||
      filters.provider !== "all" ||
      filters.scope !== "all" ||
      filters.source !== "all" ||
      filters.ownership !== "all");

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SkillEntry>) => (
      <SkillRow entry={item} busy={busyIds.has(item.skillId)} handlers={handlers} />
    ),
    [busyIds, handlers],
  );
  const keyExtractor = useCallback((item: SkillEntry) => item.skillId, []);
  const header = useMemo(
    () => (
      <InstalledFilters
        skills={catalog.skills}
        filters={filters}
        onChange={handleFilters}
        resultCount={visible.length}
      />
    ),
    [catalog.skills, filters, handleFilters, visible.length],
  );
  const footer = useMemo(
    () => <WrittenPathsSection written={catalog.written} onCopy={onCopyWrittenPath} />,
    [catalog.written, onCopyWrittenPath],
  );
  const renderEmpty = useCallback(
    () => (
      <InstalledEmpty
        status={catalog.status}
        error={catalog.error}
        filtered={isFiltered}
        cwd={cwd}
      />
    ),
    [catalog.error, catalog.status, cwd, isFiltered],
  );
  const contentStyle = useMemo(
    () => [styles.listContent, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );
  return (
    <FlatList
      data={visible}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={renderEmpty}
      contentContainerStyle={contentStyle}
      showsVerticalScrollIndicator={false}
      initialNumToRender={12}
      windowSize={9}
      testID="skills-installed-list"
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  listContent: { padding: theme.spacing[4], paddingTop: theme.spacing[2], gap: theme.spacing[2] },
  filters: { gap: theme.spacing[2], marginBottom: theme.spacing[2] },
  search: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  count: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  written: { gap: theme.spacing[2], marginTop: theme.spacing[4] },
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  pathRow: {
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  pathText: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[4],
  },
}));
