import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Text, View, type ListRenderItemInfo } from "react-native";
import { RefreshCw, Search, SlidersHorizontal } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { SkillCatalogItem, SkillSourceStatus } from "@jagentdesk/protocol/native-skills";
import { AdaptiveTextInput } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQueries, useFetchQuery } from "@/data/query";
import { filterCatalogItems, skillErrorMessage } from "@/skills/native-skill-logic";
import {
  BROWSE_ALL_SOURCES,
  BROWSE_PROVIDER_MARKETPLACES,
  browseRequestFor,
  effectiveBrowseFilter,
} from "@/skills/skill-sources-logic";
import { CatalogCard } from "@/skills/ui/catalog-card";
import { ChipGroup, type ChipOption } from "@/skills/ui/skill-chrome";
import {
  skillsBrowseQueryKey,
  skillsSourcesQueryKey,
  useSkillSourcesQuery,
} from "@/skills/ui/use-skill-sources";
import type { Theme } from "@/styles/theme";

type Translate = ReturnType<typeof useTranslation>["t"];

/** Chips: All · each enabled source · Provider marketplaces (not part of the merge). */
function useSourceChips(sources: readonly SkillSourceStatus[], t: Translate) {
  return useMemo<ChipOption<string>[]>(
    () => [
      { value: BROWSE_ALL_SOURCES, label: t("skillsHub.browse.allSources") },
      ...sources
        .filter((source) => source.enabled)
        .map((source) => ({ value: source.sourceId, label: source.label })),
      { value: BROWSE_PROVIDER_MARKETPLACES, label: t("skillsHub.browse.sources.marketplace") },
    ],
    [sources, t],
  );
}

interface BrowseControlsProps {
  sources: readonly SkillSourceStatus[];
  filter: string;
  onFilterChange: (filter: string) => void;
  onQueryChange: (query: string) => void;
  onSubmitQuery: () => void;
  onRefresh: () => void;
  onManageSources: () => void;
  refreshing: boolean;
  resultCount: number;
  /** The selected source is a directory: the query is searched on submit. */
  directory: SkillSourceStatus | null;
  /** "Search <directory>" offered from the merged view when there is a query. */
  searchOffer: { label: string; onPress: () => void } | null;
}

function BrowseControls(props: BrowseControlsProps) {
  const { t } = useTranslation();
  const chips = useSourceChips(props.sources, t);
  const failing = props.sources.filter((source) => source.enabled && source.error).length;
  return (
    <View style={styles.controls}>
      <ChipGroup
        label={t("skillsHub.browse.source")}
        options={chips}
        value={props.filter}
        onChange={props.onFilterChange}
        testIDPrefix="skills-browse-source"
      />
      <View style={styles.searchRow}>
        <AdaptiveTextInput
          style={styles.search}
          onChangeText={props.onQueryChange}
          onSubmitEditing={props.onSubmitQuery}
          returnKeyType="search"
          placeholder={
            props.directory
              ? t("skillsHub.browse.searchDirectory", { label: props.directory.label })
              : t("skillsHub.browse.search")
          }
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
        <Button
          size="sm"
          variant="outline"
          leftIcon={SlidersHorizontal}
          onPress={props.onManageSources}
          testID="skills-browse-sources"
        >
          {t("skillsHub.sources.button")}
        </Button>
      </View>
      <Text style={styles.hint}>
        {props.directory
          ? t("skillsHub.browse.directoryHint", { label: props.directory.label })
          : t("skillsHub.browse.resultCount", { count: props.resultCount })}
      </Text>
      {props.searchOffer ? (
        <View style={styles.searchRow}>
          <Button
            size="sm"
            variant="outline"
            leftIcon={Search}
            onPress={props.searchOffer.onPress}
            testID="skills-browse-search-directory"
          >
            {t("skillsHub.browse.searchIn", { label: props.searchOffer.label })}
          </Button>
        </View>
      ) : null}
      {failing > 0 ? (
        <Text style={styles.warning} testID="skills-browse-failing-sources">
          {t("skillsHub.browse.failingSources", { count: failing })}
        </Text>
      ) : null}
    </View>
  );
}

interface BrowseEmptyProps {
  noSources: boolean;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Replaces the default "nothing found" text. */
  emptyText?: string;
}

function BrowseEmpty({ noSources, isLoading, error, onRetry, emptyText }: BrowseEmptyProps) {
  const { t } = useTranslation();
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
  if (noSources) return <Text style={styles.empty}>{t("skillsHub.browse.noSources")}</Text>;
  return <Text style={styles.empty}>{emptyText ?? t("skillsHub.browse.empty")}</Text>;
}

async function fetchBrowseItems(
  client: DaemonClient,
  filter: string,
  refresh: boolean,
): Promise<SkillCatalogItem[]> {
  const request = browseRequestFor(filter);
  const options = refresh ? { refresh } : {};
  if (request.kind === "provider-marketplace") {
    return (await client.browseSkillSource({ kind: "provider-marketplace" }, options)).items;
  }
  const sourceId = request.sourceId ? { sourceId: request.sourceId } : {};
  return (await client.browseSkillSources({ ...sourceId, ...options })).items;
}

interface DirectoryPage {
  items: SkillCatalogItem[];
  hasMore: boolean;
}

/**
 * Pages 1..pageCount of a directory search (ADR-0023): one request per page, only
 * after submit; "Load more" adds a page.
 */
function useDirectorySearch(input: {
  serverId: string;
  client: DaemonClient | null;
  connected: boolean;
  directory: SkillSourceStatus | null;
  query: string;
}) {
  const { serverId, client, connected, directory, query } = input;
  const [pageCount, setPageCount] = useState(1);
  const searchKey = `${directory?.sourceId ?? ""}:${query}`;
  const [pagedKey, setPagedKey] = useState(searchKey);
  if (pagedKey !== searchKey) {
    setPagedKey(searchKey);
    setPageCount(1);
  }
  const enabled = Boolean(client && connected && directory && query.trim());
  const results = useFetchQueries<DirectoryPage>(
    Array.from({ length: pageCount }, (_unused, index) => ({
      queryKey: [
        ...skillsBrowseQueryKey(serverId, directory?.sourceId ?? "none"),
        "search",
        query,
        index + 1,
      ],
      queryFn: async (): Promise<DirectoryPage> => {
        if (!client || !directory) return { items: [], hasMore: false };
        const result = await client.browseSkillSources({
          sourceId: directory.sourceId,
          query,
          page: index + 1,
        });
        return { items: result.items, hasMore: result.hasMore === true };
      },
      enabled,
      dataShape: "value" as const,
      staleTimeMs: 10 * 60_000,
    })),
  );
  const last = results[results.length - 1];
  const loadMore = useCallback(() => setPageCount((count) => count + 1), []);
  const refetch = useCallback(() => {
    for (const result of results) void result.refetch();
  }, [results]);
  return {
    items: results.flatMap((result) => result.data?.items ?? []),
    hasMore: last?.data?.hasMore === true,
    isLoading: enabled && (results[0]?.isLoading ?? false),
    isFetching: results.some((result) => result.isFetching),
    isFetchingMore: pageCount > 1 && (last?.isFetching ?? false),
    error: results.find((result) => result.error)?.error ?? null,
    refetch,
    loadMore,
  };
}

export interface BrowseTabProps {
  serverId: string;
  client: DaemonClient | null;
  connected: boolean;
  onOpenItem: (item: SkillCatalogItem) => void;
  onManageSources: () => void;
}

/**
 * Browse (spec 22.5, 22.6): the merged marketplace of every enabled source,
 * filterable by source; provider plugin marketplaces are their own filter.
 * Listing reads metadata only — installing fetches only the chosen skill.
 */
export function BrowseTab({
  serverId,
  client,
  connected,
  onOpenItem,
  onManageSources,
}: BrowseTabProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const queryClient = useQueryClient();
  const [selectedFilter, setFilter] = useState(BROWSE_ALL_SOURCES);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const refreshNextRef = useRef(false);
  const sourcesQuery = useSkillSourcesQuery(serverId, client);
  const sources = useMemo(() => sourcesQuery.data ?? [], [sourcesQuery.data]);
  const filter = effectiveBrowseFilter(selectedFilter, sourcesQuery.data);
  const directory = useMemo(
    () => sources.find((source) => source.sourceId === filter && source.directory) ?? null,
    [filter, sources],
  );
  const offeredDirectory = useMemo(
    () =>
      filter === BROWSE_ALL_SOURCES && query.trim()
        ? (sources.find((source) => source.enabled && source.directory) ?? null)
        : null,
    [filter, query, sources],
  );
  const directorySearch = useDirectorySearch({
    serverId,
    client,
    connected,
    directory,
    query: submittedQuery,
  });
  const handleSubmitQuery = useCallback(() => setSubmittedQuery(query.trim()), [query]);
  const searchOffer = useMemo(
    () =>
      offeredDirectory
        ? {
            label: offeredDirectory.label,
            onPress: () => {
              setSubmittedQuery(query.trim());
              setFilter(offeredDirectory.sourceId);
            },
          }
        : null,
    [offeredDirectory, query],
  );

  const browse = useFetchQuery({
    queryKey: skillsBrowseQueryKey(serverId, filter),
    queryFn: async () => {
      if (!client) return [];
      const refresh = refreshNextRef.current;
      refreshNextRef.current = false;
      try {
        return await fetchBrowseItems(client, filter, refresh);
      } finally {
        // Listing updates each source's status (time, count, error).
        void queryClient.invalidateQueries({ queryKey: skillsSourcesQueryKey(serverId) });
      }
    },
    enabled: Boolean(client && connected && !directory),
    dataShape: "list",
    staleTimeMs: 60_000,
  });
  const directoryItems = directorySearch.items;
  const listedItems = useMemo(
    () => filterCatalogItems(browse.data ?? [], query),
    [browse.data, query],
  );
  const items = directory ? directoryItems : listedItems;

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
        sources={sources}
        filter={filter}
        onFilterChange={setFilter}
        onQueryChange={setQuery}
        onSubmitQuery={handleSubmitQuery}
        onRefresh={handleRefresh}
        onManageSources={onManageSources}
        refreshing={directory ? directorySearch.isFetching : browse.isFetching}
        resultCount={items.length}
        directory={directory}
        searchOffer={searchOffer}
      />
    ),
    [
      browse.isFetching,
      directory,
      directorySearch.isFetching,
      filter,
      handleRefresh,
      handleSubmitQuery,
      items.length,
      onManageSources,
      searchOffer,
      sources,
    ],
  );
  const noSources =
    filter === BROWSE_ALL_SOURCES &&
    Boolean(sourcesQuery.data) &&
    !sources.some((source) => source.enabled);
  const {
    refetch: retryDirectory,
    loadMore: handleLoadMore,
    hasMore: hasNextPage,
    isFetchingMore: isFetchingNextPage,
  } = directorySearch;
  const renderEmpty = useCallback(
    () =>
      directory ? (
        <BrowseEmpty
          noSources={false}
          isLoading={directorySearch.isLoading}
          error={directorySearch.error}
          onRetry={retryDirectory}
          emptyText={
            submittedQuery
              ? undefined
              : t("skillsHub.browse.directoryPrompt", {
                  label: directory.label,
                })
          }
        />
      ) : (
        <BrowseEmpty
          noSources={noSources}
          isLoading={browse.isLoading}
          error={browse.error}
          onRetry={handleRefresh}
        />
      ),
    [
      browse.error,
      browse.isLoading,
      directory,
      directorySearch.error,
      directorySearch.isLoading,
      handleRefresh,
      noSources,
      retryDirectory,
      submittedQuery,
      t,
    ],
  );
  const footer = useMemo(
    () =>
      directory && hasNextPage ? (
        <View style={styles.footer}>
          <Button
            variant="outline"
            size="sm"
            onPress={handleLoadMore}
            loading={isFetchingNextPage}
            testID="skills-browse-load-more"
          >
            {t("skillsHub.browse.loadMore")}
          </Button>
        </View>
      ) : null,
    [directory, handleLoadMore, hasNextPage, isFetchingNextPage, t],
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
      ListFooterComponent={footer}
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
  footer: { alignItems: "center", paddingVertical: theme.spacing[3] },
  controls: { gap: theme.spacing[2], marginBottom: theme.spacing[2] },
  searchRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  search: {
    flex: 1,
    minWidth: 160,
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
  warning: { fontSize: theme.fontSize.xs, color: theme.colors.statusWarning },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[4],
  },
}));
