import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View, type ListRenderItemInfo } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { BackHeader } from "@/components/headers/back-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useFetchQuery } from "@/data/query";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useHostRouteServerId } from "@/navigation/host-route-context";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import {
  collectPlatforms,
  filterAndSortPlugins,
  isThemePlugin,
  normalizeRepoUrl,
  parseGithubSource,
  useMarketplaceCatalog,
  type MarketplacePlugin,
  type MarketplaceSort,
} from "@/marketplace/catalog";
import { MarketplaceCard, type MarketplaceInstallStatus } from "@/marketplace/marketplace-card";
import { MarketplaceControls } from "@/marketplace/marketplace-controls";
import { MarketplaceDetail } from "@/marketplace/marketplace-detail";
import { MarketplaceOverview } from "@/marketplace/marketplace-overview";

type LocalStatus = "pending" | "failed";
type MarketplaceTab = "browse" | "installed";

const BROWSE_PAGE_SIZE = 24;

interface MarketplaceTabButtonProps {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}

function MarketplaceTabButton({ label, active, onPress, testID }: MarketplaceTabButtonProps) {
  const state = useMemo(() => ({ selected: active }), [active]);
  return (
    <Pressable
      onPress={onPress}
      style={active ? styles.tabActive : styles.tab}
      accessibilityRole="button"
      accessibilityState={state}
      testID={testID}
    >
      <Text style={active ? styles.tabTextActive : styles.tabText}>{label}</Text>
    </Pressable>
  );
}

function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((entry) => entry !== value) : [...list, value];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type MarketplaceEmptyStatus = "loading" | "error" | "empty";

function resolveEmptyStatus(isLoading: boolean, isError: boolean): MarketplaceEmptyStatus {
  if (isLoading) return "loading";
  if (isError) return "error";
  return "empty";
}

function MarketplaceEmpty({
  status,
  errorText,
  onRetry,
}: {
  status: MarketplaceEmptyStatus;
  errorText: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (status === "loading") {
    return <Text style={styles.empty}>{t("marketplace.states.loading")}</Text>;
  }
  if (status === "error") {
    return (
      <Alert variant="error" title={t("marketplace.states.errorTitle")} description={errorText}>
        <Button variant="outline" size="sm" onPress={onRetry}>
          {t("marketplace.states.retry")}
        </Button>
      </Alert>
    );
  }
  return <Text style={styles.empty}>{t("marketplace.states.empty")}</Text>;
}

function buildInstalledLookup(installed: { id: string; remote?: string }[] | undefined): {
  remotes: Set<string>;
  ids: Set<string>;
} {
  const remotes = new Set<string>();
  const ids = new Set<string>();
  for (const plugin of installed ?? []) {
    ids.add(plugin.id);
    const remote = normalizeRepoUrl(plugin.remote);
    if (remote) {
      remotes.add(remote);
    }
  }
  return { remotes, ids };
}

interface ThemeGalleryProps {
  plugins: MarketplacePlugin[];
  onOpenDetail: (plugin: MarketplacePlugin) => void;
}

function ThemeChip({
  plugin,
  onOpenDetail,
}: {
  plugin: MarketplacePlugin;
  onOpenDetail: (plugin: MarketplacePlugin) => void;
}) {
  const handlePress = useCallback(() => onOpenDetail(plugin), [onOpenDetail, plugin]);
  return (
    <Pressable style={styles.themeCard} onPress={handlePress} accessibilityRole="button">
      <Text style={styles.themeName} numberOfLines={1}>
        {plugin.name}
      </Text>
      <Text style={styles.themeAuthor} numberOfLines={1}>
        {plugin.author || plugin.repo}
      </Text>
    </Pressable>
  );
}

function ThemeGallery({ plugins, onOpenDetail }: ThemeGalleryProps) {
  const { t } = useTranslation();
  if (plugins.length === 0) {
    return null;
  }
  return (
    <View style={styles.themeSection}>
      <Text style={styles.sectionTitle}>{t("marketplace.themes.title")}</Text>
      <Text style={styles.sectionHint}>{t("marketplace.themes.subtitle")}</Text>
      <View style={styles.themeGrid}>
        {plugins.map((plugin) => (
          <ThemeChip key={plugin.id} plugin={plugin} onOpenDetail={onOpenDetail} />
        ))}
      </View>
    </View>
  );
}

export function MarketplaceScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const serverId = useHostRouteServerId() ?? "";
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const toast = useToast();

  const catalog = useMarketplaceCatalog();
  const plugins = useMemo(() => catalog.data ?? [], [catalog.data]);

  const installedQuery = useFetchQuery({
    queryKey: ["marketplace-installed", serverId],
    queryFn: async () => {
      if (!client) throw new Error("Plugin host is offline");
      return client.listPlugins();
    },
    enabled: Boolean(client && connected),
    dataShape: "list",
    staleTimeMs: 1_000,
  });
  const installedLookup = useMemo(
    () => buildInstalledLookup(installedQuery.data),
    [installedQuery.data],
  );

  const [search, setSearch] = useState("");
  const [searchResetKey, setSearchResetKey] = useState(0);
  const [sort, setSort] = useState<MarketplaceSort>("popular");
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [detailPlugin, setDetailPlugin] = useState<MarketplacePlugin | null>(null);
  const [localStatuses, setLocalStatuses] = useState<Record<string, LocalStatus>>({});
  const [tab, setTab] = useState<MarketplaceTab>("browse");
  const [visibleCount, setVisibleCount] = useState(BROWSE_PAGE_SIZE);

  const platforms = useMemo(() => collectPlatforms(plugins), [plugins]);
  const themePlugins = useMemo(() => plugins.filter(isThemePlugin), [plugins]);
  const visiblePlugins = useMemo(
    () => filterAndSortPlugins({ plugins, search, categories, platforms: selectedPlatforms, sort }),
    [plugins, search, categories, selectedPlatforms, sort],
  );

  const install = useMutation({
    mutationFn: async (plugin: MarketplacePlugin) => {
      if (!client) throw new Error("Plugin host is offline");
      const { source, ref, pluginPath } = parseGithubSource(plugin.url);
      await client.installSourcePlugin(source, { ref, pluginPath });
      return plugin;
    },
    onMutate: (plugin) => {
      setLocalStatuses((prev) => ({ ...prev, [plugin.id]: "pending" }));
    },
    onSuccess: async (plugin) => {
      setLocalStatuses((prev) => {
        const next = { ...prev };
        delete next[plugin.id];
        return next;
      });
      await installedQuery.refetch();
      toast.show(t("marketplace.install.success", { name: plugin.name }), { variant: "success" });
    },
    onError: (error, plugin) => {
      setLocalStatuses((prev) => ({ ...prev, [plugin.id]: "failed" }));
      toast.error(t("marketplace.install.failed", { message: errorMessage(error) }));
    },
  });
  const runInstall = install.mutate;

  const resolveStatus = useCallback(
    (plugin: MarketplacePlugin): MarketplaceInstallStatus => {
      const local = localStatuses[plugin.id];
      if (local === "pending") return "pending";
      const installed =
        installedLookup.ids.has(plugin.id) ||
        installedLookup.remotes.has(normalizeRepoUrl(parseGithubSource(plugin.url).source));
      if (installed) return "installed";
      if (local === "failed") return "failed";
      return "idle";
    },
    [installedLookup, localStatuses],
  );

  const installedPlugins = useMemo(
    () => visiblePlugins.filter((plugin) => resolveStatus(plugin) === "installed"),
    [visiblePlugins, resolveStatus],
  );
  const browsePlugins = useMemo(
    () => visiblePlugins.slice(0, visibleCount),
    [visiblePlugins, visibleCount],
  );
  const listData = tab === "installed" ? installedPlugins : browsePlugins;
  const activeCount = tab === "installed" ? installedPlugins.length : visiblePlugins.length;
  const canLoadMore = tab === "browse" && visibleCount < visiblePlugins.length;

  // Reset paging to the first page whenever the filtered set can change or the
  // active tab switches, so "Load more" never carries a stale offset.
  useEffect(() => {
    setVisibleCount(BROWSE_PAGE_SIZE);
  }, [search, categories, selectedPlatforms, sort, tab]);

  const handleLoadMore = useCallback(() => {
    setVisibleCount((count) => count + BROWSE_PAGE_SIZE);
  }, []);
  const handleSelectBrowse = useCallback(() => setTab("browse"), []);
  const handleSelectInstalled = useCallback(() => setTab("installed"), []);

  const handleInstall = useCallback(
    (plugin: MarketplacePlugin) => {
      if (!client) {
        toast.error(t("marketplace.states.offline"));
        return;
      }
      runInstall(plugin);
    },
    [client, runInstall, t, toast],
  );
  const handleOpenDetail = useCallback((plugin: MarketplacePlugin) => setDetailPlugin(plugin), []);
  const handleCloseDetail = useCallback(() => setDetailPlugin(null), []);
  const handleBack = useCallback(() => router.back(), [router]);
  const handleToggleCategory = useCallback(
    (value: string) => setCategories((prev) => toggleValue(prev, value)),
    [],
  );
  const handleTogglePlatform = useCallback(
    (value: string) => setSelectedPlatforms((prev) => toggleValue(prev, value)),
    [],
  );
  const handleClearFilters = useCallback(() => {
    setCategories([]);
    setSelectedPlatforms([]);
    setSearch("");
    setSearchResetKey((key) => key + 1);
  }, []);
  const handleRetry = useCallback(() => {
    void catalog.refetch();
  }, [catalog]);

  const numColumns = isCompact ? 1 : 2;
  const columnWrapperStyle = numColumns > 1 ? styles.columnWrap : undefined;
  const contentStyle = useMemo(
    () => [styles.listContent, { paddingBottom: insets.bottom + 24 }],
    [insets.bottom],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<MarketplacePlugin>) => (
      <View style={styles.cell}>
        <MarketplaceCard
          plugin={item}
          installStatus={resolveStatus(item)}
          onOpenDetail={handleOpenDetail}
          onInstall={handleInstall}
        />
      </View>
    ),
    [handleInstall, handleOpenDetail, resolveStatus],
  );
  const keyExtractor = useCallback((item: MarketplacePlugin) => item.id, []);

  const installedTabLabel =
    installedPlugins.length > 0
      ? `${t("marketplace.tabs.installed")} (${installedPlugins.length})`
      : t("marketplace.tabs.installed");
  const isBrowseTab = tab === "browse";
  const listHeader = useMemo(
    () => (
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{t("marketplace.title")}</Text>
          <Text style={styles.subtitle}>{t("marketplace.subtitle")}</Text>
        </View>
        <View style={styles.tabRow}>
          <MarketplaceTabButton
            label={t("marketplace.tabs.browse")}
            active={isBrowseTab}
            onPress={handleSelectBrowse}
            testID="marketplace-tab-browse"
          />
          <MarketplaceTabButton
            label={installedTabLabel}
            active={!isBrowseTab}
            onPress={handleSelectInstalled}
            testID="marketplace-tab-installed"
          />
        </View>
        {!connected ? <Alert variant="warning" title={t("marketplace.states.offline")} /> : null}
        {isBrowseTab && plugins.length > 0 ? <MarketplaceOverview plugins={plugins} /> : null}
        <MarketplaceControls
          search={search}
          searchResetKey={searchResetKey}
          onSearchChange={setSearch}
          sort={sort}
          onSortChange={setSort}
          selectedCategories={categories}
          onToggleCategory={handleToggleCategory}
          platforms={platforms}
          selectedPlatforms={selectedPlatforms}
          onTogglePlatform={handleTogglePlatform}
          onClearFilters={handleClearFilters}
          resultCount={activeCount}
        />
        {isBrowseTab ? (
          <ThemeGallery plugins={themePlugins} onOpenDetail={handleOpenDetail} />
        ) : null}
        <Text style={styles.sectionTitle}>
          {isBrowseTab ? t("marketplace.browse.title") : t("marketplace.tabs.installed")}
        </Text>
      </View>
    ),
    [
      activeCount,
      categories,
      connected,
      handleClearFilters,
      handleOpenDetail,
      handleSelectBrowse,
      handleSelectInstalled,
      handleToggleCategory,
      handleTogglePlatform,
      installedTabLabel,
      isBrowseTab,
      platforms,
      plugins,
      search,
      searchResetKey,
      selectedPlatforms,
      sort,
      t,
      themePlugins,
    ],
  );

  const listFooter = useMemo(() => {
    if (!canLoadMore) return null;
    return (
      <View style={styles.loadMoreRow}>
        <Button variant="outline" onPress={handleLoadMore} testID="marketplace-load-more">
          {t("marketplace.tabs.loadMore")}
        </Button>
      </View>
    );
  }, [canLoadMore, handleLoadMore, t]);

  const emptyStatus = resolveEmptyStatus(catalog.isLoading, catalog.isError);
  const emptyErrorText = errorMessage(catalog.error);
  const showInstalledEmpty = !isBrowseTab && emptyStatus === "empty";
  const renderEmpty = useCallback(() => {
    if (showInstalledEmpty) {
      return <Text style={styles.empty}>{t("marketplace.tabs.installedEmpty")}</Text>;
    }
    return (
      <MarketplaceEmpty status={emptyStatus} errorText={emptyErrorText} onRetry={handleRetry} />
    );
  }, [showInstalledEmpty, emptyStatus, emptyErrorText, handleRetry, t]);

  return (
    <View style={styles.root}>
      <BackHeader title={t("marketplace.title")} onBack={handleBack} />
      <FlatList
        key={`marketplace-cols-${numColumns}`}
        data={listData}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numColumns={numColumns}
        columnWrapperStyle={columnWrapperStyle}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        ListEmptyComponent={renderEmpty}
        contentContainerStyle={contentStyle}
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        windowSize={9}
      />
      {detailPlugin ? (
        <MarketplaceDetail
          plugin={detailPlugin}
          installStatus={resolveStatus(detailPlugin)}
          onClose={handleCloseDetail}
          onInstall={handleInstall}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  listContent: { padding: theme.spacing[4], gap: theme.spacing[3] },
  columnWrap: { gap: theme.spacing[3] },
  cell: { flex: 1, marginBottom: theme.spacing[3] },
  header: { gap: theme.spacing[3], marginBottom: theme.spacing[1] },
  titleBlock: { gap: theme.spacing[1] },
  tabRow: {
    flexDirection: "row",
    gap: theme.spacing[1],
    padding: theme.spacing[1],
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    alignSelf: "flex-start",
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  tabActive: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  tabText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  tabTextActive: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  loadMoreRow: {
    flexDirection: "row",
    justifyContent: "center",
    paddingTop: theme.spacing[4],
  },
  title: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  subtitle: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  sectionTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  sectionHint: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  themeSection: { gap: theme.spacing[2] },
  themeGrid: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  themeCard: {
    minWidth: 140,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  themeName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  themeAuthor: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  empty: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontStyle: "italic",
    padding: theme.spacing[4],
  },
}));
