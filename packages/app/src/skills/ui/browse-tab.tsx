import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Text, View, type ListRenderItemInfo } from "react-native";
import { RefreshCw } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import {
  OFFICIAL_SKILL_REPOS,
  type SkillCatalogItem,
  type SkillSourceRef,
} from "@jagentdesk/protocol/native-skills";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import {
  buildBrowseSource,
  filterCatalogItems,
  skillErrorMessage,
  type BrowseSourceKind,
} from "@/skills/native-skill-logic";
import { CatalogCard } from "@/skills/ui/catalog-card";
import { ChipGroup, type ChipOption } from "@/skills/ui/skill-chrome";
import type { Theme } from "@/styles/theme";

export function skillsBrowseQueryKey(serverId: string, source?: SkillSourceRef | null) {
  return source ? ["skills-browse", serverId, JSON.stringify(source)] : ["skills-browse", serverId];
}

type Translate = ReturnType<typeof useTranslation>["t"];

function useSourceOptions(t: Translate) {
  return useMemo(() => {
    const kinds: ChipOption<BrowseSourceKind>[] = [
      { value: "official", label: t("skillsHub.browse.sources.official") },
      { value: "provider-marketplace", label: t("skillsHub.browse.sources.marketplace") },
      { value: "url", label: t("skillsHub.browse.sources.link") },
    ];
    const repos: ChipOption<string>[] = [
      { value: "all", label: t("skillsHub.browse.allRepos") },
      ...OFFICIAL_SKILL_REPOS.map((repo) => ({ value: repo, label: repo })),
    ];
    const providers: ChipOption<string>[] = [
      { value: "all", label: t("skillsHub.browse.allProviders") },
      { value: "claude", label: "Claude" },
      { value: "codex", label: "Codex" },
    ];
    return { kinds, repos, providers };
  }, [t]);
}

interface LinkInputProps {
  onSubmit: (link: string) => void;
}

function LinkInput({ onSubmit }: LinkInputProps) {
  const { t } = useTranslation();
  const draftRef = useRef("");
  const handleChange = useCallback((value: string) => {
    draftRef.current = value;
  }, []);
  const handleSubmit = useCallback(() => onSubmit(draftRef.current), [onSubmit]);
  return (
    <View style={styles.linkBlock}>
      <View style={styles.linkRow}>
        <AdaptiveTextInput
          style={styles.linkInput}
          onChangeText={handleChange}
          onSubmitEditing={handleSubmit}
          placeholder={t("skillsHub.browse.linkPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="skills-browse-link-input"
        />
        <Button size="sm" variant="default" onPress={handleSubmit} testID="skills-browse-link-go">
          {t("skillsHub.browse.linkGo")}
        </Button>
      </View>
      <Text style={styles.hint}>{t("skillsHub.browse.linkHint")}</Text>
    </View>
  );
}

interface BrowseControlsProps {
  kind: BrowseSourceKind;
  option: string;
  onKindChange: (kind: BrowseSourceKind) => void;
  onOptionChange: (option: string) => void;
  onLinkSubmit: (link: string) => void;
  onQueryChange: (query: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  resultCount: number;
}

function BrowseControls(props: BrowseControlsProps) {
  const { t } = useTranslation();
  const options = useSourceOptions(t);
  return (
    <View style={styles.controls}>
      <ChipGroup
        label={t("skillsHub.browse.source")}
        options={options.kinds}
        value={props.kind}
        onChange={props.onKindChange}
        testIDPrefix="skills-browse-source"
      />
      {props.kind === "official" ? (
        <ChipGroup
          label={t("skillsHub.browse.repository")}
          options={options.repos}
          value={props.option}
          onChange={props.onOptionChange}
          testIDPrefix="skills-browse-repo"
        />
      ) : null}
      {props.kind === "provider-marketplace" ? (
        <ChipGroup
          label={t("skillsHub.browse.provider")}
          options={options.providers}
          value={props.option}
          onChange={props.onOptionChange}
          testIDPrefix="skills-browse-provider"
        />
      ) : null}
      {props.kind === "url" ? <LinkInput onSubmit={props.onLinkSubmit} /> : null}
      <View style={styles.searchRow}>
        <AdaptiveTextInput
          style={styles.search}
          onChangeText={props.onQueryChange}
          placeholder={t("skillsHub.browse.search")}
          autoCapitalize="none"
          autoCorrect={false}
          testID="skills-browse-search"
        />
        <Button
          size="sm"
          variant="outline"
          leftIcon={RefreshCw}
          onPress={props.onRefresh}
          loading={props.refreshing}
          testID="skills-browse-refresh"
        >
          {t("skillsHub.browse.refresh")}
        </Button>
      </View>
      <Text style={styles.hint}>
        {t("skillsHub.browse.resultCount", { count: props.resultCount })}
      </Text>
    </View>
  );
}

interface BrowseEmptyProps {
  waitingForLink: boolean;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
}

function BrowseEmpty({ waitingForLink, isLoading, error, onRetry }: BrowseEmptyProps) {
  const { t } = useTranslation();
  if (waitingForLink) return <Text style={styles.empty}>{t("skillsHub.browse.linkEmpty")}</Text>;
  if (isLoading) return <Text style={styles.empty}>{t("skillsHub.browse.loading")}</Text>;
  if (error) {
    return (
      <Alert
        variant="error"
        title={t("skillsHub.browse.errorTitle")}
        description={skillErrorMessage(error)}
      >
        <Button variant="outline" size="sm" onPress={onRetry}>
          {t("skillsHub.states.retry")}
        </Button>
      </Alert>
    );
  }
  return <Text style={styles.empty}>{t("skillsHub.browse.empty")}</Text>;
}

export interface BrowseTabProps {
  serverId: string;
  client: DaemonClient | null;
  connected: boolean;
  onOpenItem: (item: SkillCatalogItem) => void;
}

export function BrowseTab({ serverId, client, connected, onOpenItem }: BrowseTabProps) {
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const [kind, setKind] = useState<BrowseSourceKind>("official");
  const [option, setOption] = useState("all");
  const [link, setLink] = useState("");
  const [query, setQuery] = useState("");
  const refreshNextRef = useRef(false);
  const source = useMemo(() => buildBrowseSource(kind, option, link), [kind, option, link]);

  const browse = useFetchQuery({
    queryKey: skillsBrowseQueryKey(serverId, source),
    queryFn: async () => {
      if (!client || !source) return [];
      const refresh = refreshNextRef.current;
      refreshNextRef.current = false;
      const result = await client.browseSkillSource(source, refresh ? { refresh } : {});
      return result.items;
    },
    enabled: Boolean(client && connected && source),
    dataShape: "list",
    staleTimeMs: 60_000,
  });
  const items = useMemo(() => filterCatalogItems(browse.data ?? [], query), [browse.data, query]);

  const handleKindChange = useCallback((next: BrowseSourceKind) => {
    setKind(next);
    setOption("all");
  }, []);
  const handleLinkSubmit = useCallback((value: string) => setLink(value.trim()), []);
  const { refetch } = browse;
  const handleRefresh = useCallback(() => {
    refreshNextRef.current = true;
    void refetch();
  }, [refetch]);

  const numColumns = isCompact ? 1 : 2;
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<SkillCatalogItem>) => (
      <View style={styles.cell}>
        <CatalogCard item={item} onOpen={onOpenItem} />
      </View>
    ),
    [onOpenItem],
  );
  const keyExtractor = useCallback(
    (item: SkillCatalogItem) => `${JSON.stringify(item.source)}:${item.itemId}`,
    [],
  );
  const header = useMemo(
    () => (
      <BrowseControls
        kind={kind}
        option={option}
        onKindChange={handleKindChange}
        onOptionChange={setOption}
        onLinkSubmit={handleLinkSubmit}
        onQueryChange={setQuery}
        onRefresh={handleRefresh}
        refreshing={browse.isFetching}
        resultCount={items.length}
      />
    ),
    [
      browse.isFetching,
      handleKindChange,
      handleLinkSubmit,
      handleRefresh,
      items.length,
      kind,
      option,
    ],
  );
  const renderEmpty = useCallback(
    () => (
      <BrowseEmpty
        waitingForLink={kind === "url" && !source}
        isLoading={browse.isLoading}
        error={browse.error}
        onRetry={handleRefresh}
      />
    ),
    [browse.error, browse.isLoading, handleRefresh, kind, source],
  );
  const contentStyle = useMemo(
    () => [styles.listContent, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );
  return (
    <FlatList
      key={`skills-browse-${numColumns}`}
      data={items}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      numColumns={numColumns}
      columnWrapperStyle={numColumns > 1 ? styles.columnWrap : undefined}
      ListHeaderComponent={header}
      ListEmptyComponent={renderEmpty}
      contentContainerStyle={contentStyle}
      showsVerticalScrollIndicator={false}
      initialNumToRender={8}
      windowSize={9}
      testID="skills-browse-list"
    />
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  listContent: { padding: theme.spacing[4], paddingTop: theme.spacing[2], gap: theme.spacing[3] },
  columnWrap: { gap: theme.spacing[3] },
  cell: { flex: 1, marginBottom: theme.spacing[3] },
  controls: { gap: theme.spacing[2], marginBottom: theme.spacing[2] },
  linkBlock: { gap: theme.spacing[1] },
  linkRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  linkInput: {
    flex: 1,
    minWidth: 0,
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
  searchRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  search: {
    flex: 1,
    minWidth: 0,
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
  hint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[4],
  },
}));
