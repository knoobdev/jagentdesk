import { useCallback, useMemo, useState, type ReactElement } from "react";
import { FlatList, Pressable, ScrollView, Text, View, type ListRenderItem } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useRouter } from "expo-router";
import {
  Check,
  LayoutGrid,
  List,
  ListFilter,
  Minus,
  RefreshCw,
  RotateCw,
} from "lucide-react-native";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { ArgoCdAppSummary } from "@jagentdesk/protocol/argocd/rpc-schemas";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useIsCompactFormFactor } from "@/constants/layout";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";
import {
  appCluster,
  appKey,
  collectFacetOptions,
  countActiveFilters,
  EMPTY_APP_FILTERS,
  filterApps,
  shortRevision,
  toggleFacetValue,
  type ArgoCdAppFilters,
  type ArgoCdAutoSyncFilter,
  type ArgoCdFacet,
} from "./app-list";
import { ArgoCdHealthBadge, ArgoCdSyncBadge } from "./status";
import { errorMessage } from "./use-instances";

// Applications of one instance (spec 30.3): name search + facet filters, list on every form
// factor, tiles and multi-select bulk Sync / Refresh on desktop.

type ViewMode = "list" | "tiles";
type BulkAction = "sync" | "refresh";
type BulkStatus =
  | { status: "pending"; action: BulkAction }
  | { status: "done"; action: BulkAction }
  | { status: "failed"; action: BulkAction; error: string };

const VIEW_OPTIONS: SegmentedControlOption<ViewMode>[] = [
  {
    value: "list",
    label: "List",
    icon: ({ color, size }) => <List color={color} size={size} />,
    testID: "argocd-apps-view-list",
  },
  {
    value: "tiles",
    label: "Tiles",
    icon: ({ color, size }) => <LayoutGrid color={color} size={size} />,
    testID: "argocd-apps-view-tiles",
  },
];

const AUTO_SYNC_OPTIONS: SegmentedControlOption<ArgoCdAutoSyncFilter>[] = [
  { value: "any", label: "Any" },
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
];

const FACET_LABELS: Record<ArgoCdFacet, string> = {
  sync: "Sync status",
  health: "Health status",
  projects: "Projects",
  labels: "Labels",
  clusters: "Clusters",
  namespaces: "Namespaces",
  repos: "Repositories",
  operations: "Operation",
};

const FACET_ORDER: readonly ArgoCdFacet[] = [
  "sync",
  "health",
  "operations",
  "projects",
  "clusters",
  "namespaces",
  "labels",
  "repos",
];

const BULK_CONCURRENCY = 4;

const BULK_LABELS: Record<BulkAction, { pending: string; done: string }> = {
  sync: { pending: "Starting sync...", done: "Sync started" },
  refresh: { pending: "Refreshing...", done: "Refreshed" },
};

async function runPool<T>(items: T[], limit: number, task: (item: T) => Promise<void>) {
  const queue = [...items];
  async function worker() {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await task(next);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function lastSyncLabel(app: ArgoCdAppSummary): string {
  return app.lastSyncAt_ms ? formatTimeAgo(new Date(app.lastSyncAt_ms)) : "Never";
}

function destinationLabel(app: ArgoCdAppSummary): string {
  const cluster = appCluster(app) || "—";
  return app.destNamespace ? `${cluster} / ${app.destNamespace}` : cluster;
}

function operationLabel(app: ArgoCdAppSummary): string | null {
  if (app.deleting) return "Deleting";
  if (app.operationPhase === "Running") return "Syncing";
  if (app.operationPhase === "Terminating") return "Terminating";
  if (app.operationPhase === "Failed" || app.operationPhase === "Error") return "Sync failed";
  return null;
}

interface AppsViewProps {
  serverId: string;
  client: DaemonClient;
  instanceId: string;
  apps: ArgoCdAppSummary[];
}

export function ArgoCdAppsView({ serverId, client, instanceId, apps }: AppsViewProps) {
  const isCompact = useIsCompactFormFactor();
  const router = useRouter();
  const [filters, setFilters] = useState<ArgoCdAppFilters>(EMPTY_APP_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setView] = useState<ViewMode>("list");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulk, setBulk] = useState<Readonly<Record<string, BulkStatus>>>({});

  const visible = useMemo(() => filterApps(apps, filters), [apps, filters]);
  const facetOptions = useMemo(() => collectFacetOptions(apps), [apps]);
  const activeFilters = countActiveFilters(filters);
  const selectable = !isCompact;
  const mode: ViewMode = isCompact ? "list" : view;
  const selectedApps = useMemo(
    () => apps.filter((app) => selected.has(appKey(app))),
    [apps, selected],
  );
  const bulkRunning = Object.values(bulk).some((entry) => entry.status === "pending");

  const open = useCallback(
    (app: ArgoCdAppSummary) => {
      const params = app.appNamespace
        ? { serverId, instanceId, name: app.name, ns: app.appNamespace }
        : { serverId, instanceId, name: app.name };
      router.push({ pathname: "/h/[serverId]/argocd/[instanceId]/app", params });
    },
    [instanceId, router, serverId],
  );

  const toggleSelected = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const allVisibleSelected =
    visible.length > 0 && visible.every((app) => selected.has(appKey(app)));
  const toggleAll = useCallback(() => {
    setSelected(allVisibleSelected ? new Set() : new Set(visible.map(appKey)));
  }, [allVisibleSelected, visible]);
  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setBulk({});
  }, []);

  const runBulk = useCallback(
    async (action: BulkAction) => {
      const targets = selectedApps;
      setBulk(
        Object.fromEntries(targets.map((app) => [appKey(app), { status: "pending", action }])),
      );
      await runPool(targets, BULK_CONCURRENCY, async (app) => {
        const ref = { name: app.name, appNamespace: app.appNamespace };
        let result: BulkStatus;
        try {
          const res =
            action === "sync"
              ? await client.argocd("argocd.app.sync.request", {
                  instanceId,
                  app: ref,
                  options: {
                    prune: false,
                    dryRun: false,
                    force: false,
                    applyOnly: false,
                    syncOptions: [],
                  },
                })
              : await client.argocd("argocd.app.refresh.request", {
                  instanceId,
                  app: ref,
                  hard: false,
                });
          result = res.error
            ? { status: "failed", action, error: res.error }
            : { status: "done", action };
        } catch (error) {
          result = { status: "failed", action, error: errorMessage(error, "The request failed") };
        }
        setBulk((current) => ({ ...current, [appKey(app)]: result }));
      });
    },
    [client, instanceId, selectedApps],
  );
  const syncSelected = useCallback(() => void runBulk("sync"), [runBulk]);
  const refreshSelected = useCallback(() => void runBulk("refresh"), [runBulk]);

  const setQuery = useCallback((query: string) => setFilters((f) => ({ ...f, query })), []);
  const toggleFilters = useCallback(() => setFiltersOpen((value) => !value), []);
  const clearFilters = useCallback(
    () => setFilters((current) => ({ ...EMPTY_APP_FILTERS, query: current.query })),
    [],
  );

  const filterPanel = useMemo(
    () =>
      filtersOpen ? (
        <FilterPanel
          filters={filters}
          options={facetOptions}
          onChange={setFilters}
          onClear={clearFilters}
        />
      ) : null,
    [clearFilters, facetOptions, filters, filtersOpen],
  );

  const failures = selectedApps.filter((app) => bulk[appKey(app)]?.status === "failed").length;

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <View style={styles.search}>
          <FormTextInput
            size={isCompact ? "md" : "sm"}
            initialValue={filters.query}
            onChangeText={setQuery}
            placeholder="Search applications"
            autoCapitalize="none"
            autoCorrect={false}
            testID="argocd-apps-search"
          />
        </View>
        <Button
          size={isCompact ? "md" : "sm"}
          variant={activeFilters > 0 ? "secondary" : "outline"}
          leftIcon={ListFilter}
          onPress={toggleFilters}
          testID="argocd-apps-filters"
        >
          {activeFilters > 0 ? `Filters (${activeFilters})` : "Filters"}
        </Button>
        {isCompact ? null : (
          <SegmentedControl
            size="sm"
            options={VIEW_OPTIONS}
            value={view}
            onValueChange={setView}
            testID="argocd-apps-view"
          />
        )}
      </View>

      {selectable && selected.size > 0 ? (
        <View style={styles.selectionBar} testID="argocd-apps-selection">
          <Text style={styles.selectionText}>
            {failures > 0
              ? `${selected.size} selected · ${failures} failed`
              : `${selected.size} selected`}
          </Text>
          <View style={styles.selectionActions}>
            <Button
              size="sm"
              variant="outline"
              leftIcon={RotateCw}
              loading={bulkRunning}
              disabled={bulkRunning}
              onPress={syncSelected}
              testID="argocd-apps-bulk-sync"
            >
              Sync
            </Button>
            <Button
              size="sm"
              variant="outline"
              leftIcon={RefreshCw}
              disabled={bulkRunning}
              onPress={refreshSelected}
              testID="argocd-apps-bulk-refresh"
            >
              Refresh
            </Button>
            <Button size="sm" variant="ghost" onPress={clearSelection} disabled={bulkRunning}>
              Clear
            </Button>
          </View>
        </View>
      ) : null}

      {mode === "list" ? (
        <AppList
          apps={visible}
          total={apps.length}
          compact={isCompact}
          selectable={selectable}
          selected={selected}
          allSelected={allVisibleSelected}
          bulk={bulk}
          header={filterPanel}
          onOpen={open}
          onToggle={toggleSelected}
          onToggleAll={toggleAll}
          onClearFilters={clearFilters}
          filtered={activeFilters > 0 || filters.query.trim().length > 0}
        />
      ) : (
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          {filterPanel}
          <ResultCount shown={visible.length} total={apps.length} />
          <View style={styles.tiles}>
            {visible.map((app) => (
              <AppTile
                key={appKey(app)}
                app={app}
                selected={selected.has(appKey(app))}
                bulk={bulk[appKey(app)] ?? null}
                onOpen={open}
                onToggle={toggleSelected}
              />
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function ResultCount({ shown, total }: { shown: number; total: number }) {
  const label =
    shown === total ? `${total} applications` : `Showing ${shown} of ${total} applications`;
  return (
    <Text style={styles.count} testID="argocd-apps-count">
      {label}
    </Text>
  );
}

interface AppListProps {
  apps: ArgoCdAppSummary[];
  total: number;
  compact: boolean;
  selectable: boolean;
  selected: ReadonlySet<string>;
  allSelected: boolean;
  bulk: Readonly<Record<string, BulkStatus>>;
  header: ReactElement | null;
  filtered: boolean;
  onOpen: (app: ArgoCdAppSummary) => void;
  onToggle: (key: string) => void;
  onToggleAll: () => void;
  onClearFilters: () => void;
}

function AppList({
  apps,
  total,
  compact,
  selectable,
  selected,
  allSelected,
  bulk,
  header,
  filtered,
  onOpen,
  onToggle,
  onToggleAll,
  onClearFilters,
}: AppListProps) {
  const renderItem = useCallback<ListRenderItem<ArgoCdAppSummary>>(
    ({ item, index }) => {
      const key = appKey(item);
      return (
        <AppRow
          app={item}
          isFirst={index === 0}
          compact={compact}
          selectable={selectable}
          selected={selected.has(key)}
          bulk={bulk[key] ?? null}
          onOpen={onOpen}
          onToggle={onToggle}
        />
      );
    },
    [bulk, compact, onOpen, onToggle, selectable, selected],
  );

  const listHeader = useMemo(
    () => (
      <View style={styles.listHeaderBlock}>
        {header}
        <ResultCount shown={apps.length} total={total} />
        {compact || apps.length === 0 ? null : (
          <View style={styles.columns}>
            {selectable ? (
              <SelectBox
                checked={allSelected}
                onPress={onToggleAll}
                label="Select all applications"
                testID="argocd-apps-select-all"
              />
            ) : null}
            <Text style={[styles.columnLabel, styles.colName]}>Name</Text>
            <Text style={[styles.columnLabel, styles.colHealth]}>Health</Text>
            <Text style={[styles.columnLabel, styles.colSync]}>Sync</Text>
            <Text style={[styles.columnLabel, styles.colRevision]}>Revision</Text>
            <Text style={[styles.columnLabel, styles.colDestination]}>Destination</Text>
            <Text style={[styles.columnLabel, styles.colLastSync]}>Last sync</Text>
          </View>
        )}
      </View>
    ),
    [allSelected, apps.length, compact, header, onToggleAll, selectable, total],
  );

  const empty = useMemo(
    () => (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>
          {filtered ? "No applications match the filters" : "No applications"}
        </Text>
        {filtered ? (
          <Button size="sm" variant="ghost" onPress={onClearFilters}>
            Clear filters
          </Button>
        ) : null}
      </View>
    ),
    [filtered, onClearFilters],
  );

  return (
    <FlatList
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      data={apps}
      keyExtractor={appKey}
      renderItem={renderItem}
      extraData={renderItem}
      ListHeaderComponent={listHeader}
      ListEmptyComponent={empty}
      testID="argocd-apps-list"
    />
  );
}

interface AppRowProps {
  app: ArgoCdAppSummary;
  isFirst: boolean;
  compact: boolean;
  selectable: boolean;
  selected: boolean;
  bulk: BulkStatus | null;
  onOpen: (app: ArgoCdAppSummary) => void;
  onToggle: (key: string) => void;
}

function AppRow({
  app,
  isFirst,
  compact,
  selectable,
  selected,
  bulk,
  onOpen,
  onToggle,
}: AppRowProps) {
  const handleOpen = useCallback(() => onOpen(app), [app, onOpen]);
  const handleToggle = useCallback(() => onToggle(appKey(app)), [app, onToggle]);
  const revision = shortRevision(app.syncRevision);
  const operation = operationLabel(app);
  const rowStyle = isFirst ? styles.row : [styles.row, styles.rowDivider];

  if (compact) {
    const compactStyle = isFirst
      ? [styles.row, styles.rowCompact]
      : [styles.row, styles.rowCompact, styles.rowDivider];
    const details = [app.project, destinationLabel(app), revision, lastSyncLabel(app)];
    return (
      <Pressable
        style={compactStyle}
        onPress={handleOpen}
        accessibilityRole="button"
        testID={`argocd-app-${app.name}`}
      >
        <View style={styles.compactMain}>
          <Text style={styles.name} numberOfLines={1}>
            {app.name}
          </Text>
          <View style={styles.badges}>
            <ArgoCdHealthBadge status={app.health} />
            <ArgoCdSyncBadge status={app.sync} />
            {operation ? <Text style={styles.operation}>{operation}</Text> : null}
            {app.autoSync ? <Text style={styles.meta}>Auto-sync</Text> : null}
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {details.filter(Boolean).join(" · ")}
          </Text>
        </View>
      </Pressable>
    );
  }

  return (
    <View style={rowStyle} testID={`argocd-app-${app.name}`}>
      <View style={styles.rowLine}>
        {selectable ? (
          <SelectBox
            checked={selected}
            onPress={handleToggle}
            label={`Select ${app.name}`}
            testID={`argocd-app-select-${app.name}`}
          />
        ) : null}
        <Pressable style={styles.rowMain} onPress={handleOpen} accessibilityRole="button">
          <View style={styles.colName}>
            <Text style={styles.name} numberOfLines={1}>
              {app.name}
            </Text>
            <Text style={styles.meta} numberOfLines={1}>
              {app.autoSync ? `${app.project} · Auto-sync` : app.project}
            </Text>
          </View>
          <View style={styles.colHealth}>
            <ArgoCdHealthBadge status={app.health} />
          </View>
          <View style={styles.colSync}>
            <ArgoCdSyncBadge status={app.sync} />
            {operation ? <Text style={styles.operation}>{operation}</Text> : null}
          </View>
          <Text style={[styles.mono, styles.colRevision]} numberOfLines={1}>
            {revision ?? "—"}
          </Text>
          <Text style={[styles.meta, styles.colDestination]} numberOfLines={1}>
            {destinationLabel(app)}
          </Text>
          <Text style={[styles.meta, styles.colLastSync]} numberOfLines={1}>
            {lastSyncLabel(app)}
          </Text>
        </Pressable>
      </View>
      <BulkLine bulk={bulk} />
    </View>
  );
}

function BulkLine({ bulk }: { bulk: BulkStatus | null }) {
  if (!bulk) return null;
  if (bulk.status === "failed") {
    return (
      <Text style={styles.bulkError} numberOfLines={2}>
        {bulk.error}
      </Text>
    );
  }
  const label = BULK_LABELS[bulk.action][bulk.status];
  return <Text style={bulk.status === "done" ? styles.bulkDone : styles.bulkPending}>{label}</Text>;
}

interface AppTileProps {
  app: ArgoCdAppSummary;
  selected: boolean;
  bulk: BulkStatus | null;
  onOpen: (app: ArgoCdAppSummary) => void;
  onToggle: (key: string) => void;
}

function AppTile({ app, selected, bulk, onOpen, onToggle }: AppTileProps) {
  const handleOpen = useCallback(() => onOpen(app), [app, onOpen]);
  const handleToggle = useCallback(() => onToggle(appKey(app)), [app, onToggle]);
  const operation = operationLabel(app);
  return (
    <View style={selected ? [styles.tile, styles.tileSelected] : styles.tile}>
      <View style={styles.tileHeader}>
        <SelectBox checked={selected} onPress={handleToggle} label={`Select ${app.name}`} />
        <Pressable style={styles.tileTitle} onPress={handleOpen} accessibilityRole="button">
          <Text style={styles.name} numberOfLines={1}>
            {app.name}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {app.autoSync ? `${app.project} · Auto-sync` : app.project}
          </Text>
        </Pressable>
      </View>
      <Pressable style={styles.tileBody} onPress={handleOpen}>
        <View style={styles.badges}>
          <ArgoCdHealthBadge status={app.health} />
          <ArgoCdSyncBadge status={app.sync} />
          {operation ? <Text style={styles.operation}>{operation}</Text> : null}
        </View>
        <TileField label="Destination" value={destinationLabel(app)} />
        <TileField label="Revision" value={shortRevision(app.syncRevision) ?? "—"} />
        <TileField label="Last sync" value={lastSyncLabel(app)} />
      </Pressable>
      <BulkLine bulk={bulk} />
    </View>
  );
}

function TileField({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.tileField}>
      <Text style={styles.tileFieldLabel}>{label}</Text>
      <Text style={styles.tileFieldValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function SelectBox({
  checked,
  onPress,
  label,
  testID,
}: {
  checked: boolean;
  onPress: () => void;
  label: string;
  testID?: string;
}) {
  return (
    <Pressable
      style={styles.selectHit}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={checked ? CHECKED : UNCHECKED}
      accessibilityLabel={label}
      testID={testID}
    >
      <View style={checked ? [styles.selectBox, styles.selectBoxChecked] : styles.selectBox}>
        {checked ? <ThemedCheck size={12} strokeWidth={3} uniProps={checkColor} /> : null}
      </View>
    </Pressable>
  );
}

interface FilterPanelProps {
  filters: ArgoCdAppFilters;
  options: ReturnType<typeof collectFacetOptions>;
  onChange: (update: (filters: ArgoCdAppFilters) => ArgoCdAppFilters) => void;
  onClear: () => void;
}

function FilterPanel({ filters, options, onChange, onClear }: FilterPanelProps) {
  // Desktop puts each facet's label beside its chips; phones stack them.
  const inline = !useIsCompactFormFactor();
  const setAutoSync = useCallback(
    (autoSync: ArgoCdAutoSyncFilter) => onChange((current) => ({ ...current, autoSync })),
    [onChange],
  );
  const toggle = useCallback(
    (facet: ArgoCdFacet, value: string) =>
      onChange((current) => toggleFacetValue(current, facet, value)),
    [onChange],
  );
  return (
    <View style={[settingsStyles.card, styles.filterPanel]} testID="argocd-apps-filter-panel">
      <View style={inline ? styles.facetInline : styles.facet}>
        <Text style={inline ? [styles.facetLabel, styles.facetLabelInline] : styles.facetLabel}>
          Auto-sync
        </Text>
        <View style={styles.facetControl}>
          <SegmentedControl
            size="xs"
            options={AUTO_SYNC_OPTIONS}
            value={filters.autoSync}
            onValueChange={setAutoSync}
            testID="argocd-apps-filter-autosync"
          />
        </View>
      </View>
      {FACET_ORDER.filter((facet) => options[facet].length > 0).map((facet) => (
        <View key={facet} style={inline ? styles.facetInline : styles.facet}>
          <Text style={inline ? [styles.facetLabel, styles.facetLabelInline] : styles.facetLabel}>
            {FACET_LABELS[facet]}
          </Text>
          <View style={styles.chips}>
            {options[facet].map((value) => (
              <FilterChip
                key={value}
                facet={facet}
                value={value}
                active={filters[facet].includes(value)}
                onToggle={toggle}
              />
            ))}
          </View>
        </View>
      ))}
      <View style={styles.filterFooter}>
        <Button size="xs" variant="ghost" leftIcon={Minus} onPress={onClear}>
          Clear filters
        </Button>
      </View>
    </View>
  );
}

function FilterChip({
  facet,
  value,
  active,
  onToggle,
}: {
  facet: ArgoCdFacet;
  value: string;
  active: boolean;
  onToggle: (facet: ArgoCdFacet, value: string) => void;
}) {
  const handlePress = useCallback(() => onToggle(facet, value), [facet, onToggle, value]);
  return (
    <Pressable
      style={active ? [styles.chip, styles.chipActive] : styles.chip}
      onPress={handlePress}
      accessibilityRole="checkbox"
      accessibilityState={active ? CHECKED : UNCHECKED}
      testID={`argocd-filter-${facet}-${value}`}
    >
      <Text style={active ? styles.chipTextActive : styles.chipText} numberOfLines={1}>
        {value}
      </Text>
    </Pressable>
  );
}

const CHECKED = { checked: true } as const;
const UNCHECKED = { checked: false } as const;
const ThemedCheck = withUnistyles(Check);
const checkColor = (theme: Theme) => ({ color: theme.colors.accentForeground });

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1, minHeight: 0 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  search: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 200,
    maxWidth: 420,
  },
  selectionBar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[3],
    marginHorizontal: theme.spacing[4],
    marginBottom: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
  },
  selectionText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  selectionActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginLeft: "auto",
  },
  scroll: { flex: 1, minHeight: 0 },
  scrollContent: {
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[6],
  },
  listHeaderBlock: { gap: theme.spacing[3] },
  count: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginBottom: theme.spacing[1],
  },
  columns: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  columnLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  row: {
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    gap: theme.spacing[1],
  },
  // Phones: rows sit on the page rail, like the count above them.
  rowCompact: { paddingHorizontal: 0 },
  rowDivider: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  rowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  colName: { flex: 2, minWidth: 0 },
  colHealth: { width: 112 },
  colSync: { width: 120, gap: 2 },
  colRevision: { width: 80 },
  colDestination: { flex: 1.5, minWidth: 0 },
  colLastSync: { width: 84 },
  compactMain: { gap: theme.spacing[1] },
  badges: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    columnGap: theme.spacing[3],
    rowGap: theme.spacing[1],
  },
  name: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  meta: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  operation: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.palette.blue[500],
  },
  bulkPending: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingLeft: theme.spacing[8],
  },
  bulkDone: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusSuccess,
    paddingLeft: theme.spacing[8],
  },
  bulkError: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
    paddingLeft: theme.spacing[8],
  },
  empty: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: 160,
    gap: theme.spacing[2],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  tiles: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  tile: {
    flexGrow: 1,
    flexBasis: 280,
    maxWidth: 400,
    padding: theme.spacing[3],
    gap: theme.spacing[3],
    borderRadius: theme.chrome.cardRadius,
    borderWidth: 1,
    borderColor: theme.chrome.cardBorder,
    backgroundColor: theme.chrome.cardBackground,
  },
  tileSelected: {
    borderColor: theme.colors.accent,
  },
  tileHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tileTitle: { flex: 1, minWidth: 0 },
  tileBody: { gap: theme.spacing[2] },
  tileField: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  tileFieldLabel: {
    width: 84,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  tileFieldValue: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  selectHit: {
    width: 20,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  selectBox: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  selectBoxChecked: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  filterPanel: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  facet: { gap: theme.spacing[1.5] },
  facetInline: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[3],
  },
  facetLabelInline: {
    width: 112,
    // Optical: lines the label up with the chip text.
    paddingTop: theme.spacing[1],
  },
  facetLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  facetControl: { flex: 1, alignItems: "flex-start" },
  chips: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  chip: {
    maxWidth: 320,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipActive: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  chipText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  chipTextActive: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.accentForeground,
  },
  filterFooter: {
    alignItems: "flex-start",
    marginLeft: -theme.spacing[2],
  },
}));
