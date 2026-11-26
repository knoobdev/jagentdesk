import { BuiltinLeftPanel, BuiltinSidebarDestinations } from "@/plugins/builtin/surfaces";
import { builtinClientRegistry } from "@/plugins/builtin/loaded";
import { SidebarFooterIconHighlight } from "@/components/sidebar/sidebar-footer-icon-highlight";
import { UsageSidebarItem, useUsageSummary, useOpenSidebarUsage } from "@/usage/sidebar-item";
import { BotsSidebar } from "@/bots/sidebar";
import { isNative as platformIsNative } from "@/constants/platform";
import { PluginSidebarPanel } from "@/plugins/sidebar-screen-items";
import { BuiltinPluginGate } from "@/plugins/builtin/gate";
import { router, usePathname, type Href } from "expo-router";
import {
  Bot,
  BarChart3,
  CalendarClock,
  FolderPlus,
  History,
  Home,
  Plus,
  Search,
  Server,
  Settings,
  Smartphone,
  Store,
  X,
} from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet as RNStyleSheet,
  Text,
  useWindowDimensions,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { Gesture, ScrollView as GHScrollView } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  TitlebarDragRegion,
  WINDOW_CONTENT_DATASET,
} from "@/components/desktop/titlebar-drag-region";
import { resolveDesktopSidebarWidth } from "@/components/desktop-sidebar-layout";
import { HostPicker } from "@/components/hosts/host-picker";
import { MobileNavGrid } from "@/components/sidebar/mobile-nav-grid";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useAppNavTargets, useNewWorkspaceNavigate } from "@/components/sidebar/use-app-nav";
import { GumloopSidebarHeader } from "@/components/gumloop-shell/gumloop-sidebar-header";
import { useIsGumloopTheme } from "@/components/gumloop-shell/use-gumloop-chrome";
import { PluginSidebarItems } from "@/plugins";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/sidebar-display-preferences-menu";
import { SidebarToastRegion } from "@/components/sidebar/sidebar-toast-region";
import { SidebarHelpMenu } from "@/components/sidebar/sidebar-help-menu";
import { SidebarResizeHandle } from "@/components/sidebar-resize-handle";
import { Shortcut } from "@/components/ui/shortcut";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { HEADER_INNER_HEIGHT, useIsCompactFormFactor } from "@/constants/layout";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import {
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import type { PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { RetainedPanelActivity } from "@/components/retained-panel";
import type { StatusGroup } from "@/hooks/sidebar-status-view-model";
import { type SidebarGroupMode, useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useHosts } from "@/runtime/host-runtime";
import { usePanelStore } from "@/stores/panel-store";
import { useOwnsWindowChromeCorner, WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCloseAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { useIsMobilePanelPresented } from "@/mobile-panels/provider";
import {
  buildOpenProjectRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
  buildSettingsAddHostRoute,
  buildSettingsHostSectionRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { SidebarAgentListSkeleton } from "./sidebar-agent-list-skeleton";
import { shouldShowAddProject, shouldShowSidebarFooter } from "./sidebar-add-project-visibility";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";
import { SidebarWorkspaceList } from "./sidebar-workspace-list";

// Classic sidebar positions of migrated built-in destinations; the rest follow Marketplace.
const CLASSIC_SLOT_SHARING: readonly string[] = ["shared-sessions"];
const CLASSIC_SLOT_SKILLS: readonly string[] = ["skills", "memory"];
const CLASSIC_SLOT_INSIGHTS: readonly string[] = ["insights"];
const CLASSIC_SLOT_INFRA: readonly string[] = ["clusters", "databases", "servers"];
const CLASSIC_SLOT_DEPLOY: readonly string[] = ["argocd"];
const CLASSIC_SLOT_INTEGRATIONS: readonly string[] = ["jira"];
const CLASSIC_SLOT_TAIL: readonly string[] = ["forge"];
const CLASSIC_PLACED_DESTINATIONS: readonly string[] = [
  ...CLASSIC_SLOT_SHARING,
  ...CLASSIC_SLOT_SKILLS,
  ...CLASSIC_SLOT_INSIGHTS,
  ...CLASSIC_SLOT_INFRA,
  ...CLASSIC_SLOT_DEPLOY,
  ...CLASSIC_SLOT_INTEGRATIONS,
  ...CLASSIC_SLOT_TAIL,
];

/** Sections whose route owns the desktop left column instead of the workspace list. */
type SectionRoute =
  | { section: "plugin"; serverId: string; pluginId: string }
  | { section: "servers" | "jira" | "bots"; serverId: string };

export function resolveSectionRoute(pathname: string): SectionRoute | null {
  const plugin = /^\/h\/([^/]+)\/plugin\/([^/]+)/.exec(pathname);
  if (plugin)
    return {
      section: "plugin",
      serverId: decodeURIComponent(plugin[1]),
      pluginId: decodeURIComponent(plugin[2]),
    };
  const match = pathname.match(/\/h\/([^/]+)\/(servers|jira|bots)(?:$|[/?])/);
  const section = match?.[2];
  if (!match?.[1] || (section !== "servers" && section !== "bots")) return null;
  return { section, serverId: decodeURIComponent(match[1]) };
}

/**
 * Whether the sidebar footer may render "Add project" — re-exported from
 * sidebar-add-project-visibility so the rule stays pure and unit-testable.
 */
export { shouldShowAddProject, shouldShowSidebarFooter } from "./sidebar-add-project-visibility";

/**
 * Pick the sidebar body for a route: a resource nav when the route points at a
 * cluster or database, otherwise the workspace list. Returned as an element and
 * rendered directly (not passed as a prop) so the two sidebar variants avoid a
 * nested ternary without tripping the prop-identity perf rules.
 */
export function resolveSidebarNavBody(
  builtinPanelRoute: { serverId: string; segment: string } | null,
  fallback: ReactNode,
  sectionRoute: SectionRoute | null = null,
): ReactNode {
  if (sectionRoute?.section === "bots")
    return (
      <BuiltinPluginGate serverId={sectionRoute.serverId} id="bots">
        <BotsSidebar serverId={sectionRoute.serverId} />
      </BuiltinPluginGate>
    );
  if (sectionRoute?.section === "plugin")
    return <PluginSidebarPanel serverId={sectionRoute.serverId} pluginId={sectionRoute.pluginId} />;
  // A section that owns the left column (spec 25.13.1 Servers, 29.3 Jira).
  if (sectionRoute?.section === "servers")
    return <BuiltinLeftPanel serverId={sectionRoute.serverId} segment="servers" />;
  if (sectionRoute?.section === "jira")
    return <BuiltinLeftPanel serverId={sectionRoute.serverId} segment="jira" />;
  if (builtinPanelRoute) {
    return (
      <BuiltinLeftPanel serverId={builtinPanelRoute.serverId} segment={builtinPanelRoute.segment} />
    );
  }
  return fallback;
}
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { usePairDeviceModalStore } from "@/stores/pair-device-modal-store";

type SidebarTheme = ReturnType<typeof useUnistyles>["theme"];

interface SidebarSharedProps {
  theme: SidebarTheme;
  statusGroups: StatusGroup[];
  pinnedGroups: PinnedSidebarGroups;
  projects: SidebarProjectEntry[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  isInitialLoad: boolean;
  isRevalidating: boolean;
  isManualRefresh: boolean;
  groupMode: SidebarGroupMode;
  collapsedProjectKeys: ReadonlySet<string>;
  shortcutIndexByWorkspaceKey: Map<string, number>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  handleRefresh: () => void;
  handleOpenProject: () => void;
  handleHome: () => void;
  handleSettings: () => void;
  handleMarketplace: () => void;
  labels: SidebarLabels;
  newWorkspaceKeys: ShortcutKey[][] | null;
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
}

interface SidebarLabels {
  addProject: string;
  newWorkspace: string;
  hosts: string;
  home: string;
  pairDevice: string;
  settings: string;
  searchHosts: string;
  sessions: string;
  schedules: string;
  bots: string;
  marketplace: string;
  closeSidebar: string;
}

interface MobileSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  insetsBottom: number;
  closeSidebar: () => void;
}

interface DesktopSidebarProps extends SidebarSharedProps {
  insetsTop: number;
  insetsBottom: number;
  active: boolean;
  handleViewMore: () => void;
  handleViewSchedules: () => void;
}

export const LeftSidebar = memo(function LeftSidebar({ active }: { active: boolean }) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const isCompactLayout = useIsCompactFormFactor();
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const {
    projects,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    refreshAll,
    statusGroups,
    pinnedGroups,
    collapsedProjectKeys,
    toggleProjectCollapsed,
    groupMode,
    shortcutModel,
  } = useSidebarModel();
  const { shortcutIndexByWorkspaceKey } = shortcutModel;

  const [isManualRefresh, setIsManualRefresh] = useState(false);

  const handleRefresh = useCallback(() => {
    setIsManualRefresh(true);
    refreshAll();
  }, [refreshAll]);

  useEffect(() => {
    if (!isRevalidating && isManualRefresh) {
      setIsManualRefresh(false);
    }
  }, [isRevalidating, isManualRefresh]);

  const openProjectPicker = useOpenAddProject();

  const handleOpenProjectMobile = useCallback(() => {
    showMobileAgent();
    void openProjectPicker();
  }, [showMobileAgent, openProjectPicker]);

  const handleOpenProjectDesktop = useCallback(() => {
    void openProjectPicker();
  }, [openProjectPicker]);

  const handleSettingsMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsRoute());
  }, [showMobileAgent]);

  const handleSettingsDesktop = useCallback(() => {
    router.push(buildSettingsRoute());
  }, []);

  const handleAddHostMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildSettingsAddHostRoute(Date.now()));
  }, [showMobileAgent]);

  const handleAddHostDesktop = useCallback(() => {
    router.push(buildSettingsAddHostRoute(Date.now()));
  }, []);

  const handleOpenHostSettingsMobile = useCallback(
    (serverId: string) => {
      showMobileAgent();
      router.push(buildSettingsHostSectionRoute(serverId, "connections"));
    },
    [showMobileAgent],
  );

  const handleOpenHostSettingsDesktop = useCallback((serverId: string) => {
    router.push(buildSettingsHostSectionRoute(serverId, "connections"));
  }, []);

  const handleHomeMobile = useCallback(() => {
    showMobileAgent();
    router.push(buildOpenProjectRoute());
  }, [showMobileAgent]);

  const handleHomeDesktop = useCallback(() => {
    router.push(buildOpenProjectRoute());
  }, []);

  const { marketplaceRoute } = useAppNavTargets();

  const handleMarketplaceDesktop = useCallback(() => {
    if (marketplaceRoute) router.push(marketplaceRoute);
  }, [marketplaceRoute]);

  const handleMarketplaceMobile = useCallback(() => {
    if (marketplaceRoute) {
      showMobileAgent();
      router.push(marketplaceRoute);
    }
  }, [marketplaceRoute, showMobileAgent]);

  const handleViewMoreNavigate = useCallback(() => {
    router.push(buildSessionsRoute());
  }, []);

  const handleViewSchedulesNavigate = useCallback(() => {
    router.push(buildSchedulesRoute());
  }, []);

  const newWorkspaceKeys = useShortcutKeys("new-workspace");
  const labels = useMemo(
    (): SidebarLabels => ({
      addProject: t("sidebar.actions.addProject"),
      newWorkspace: t("sidebar.actions.newWorkspace"),
      hosts: t("sidebar.actions.hosts"),
      home: t("sidebar.actions.home"),
      pairDevice: t("openProject.tiles.pairDevice.title"),
      settings: t("sidebar.actions.settings"),
      searchHosts: t("sidebar.host.searchPlaceholder"),
      sessions: t("sidebar.sections.sessions"),
      schedules: t("sidebar.sections.schedules"),
      bots: t("bots.title"),
      marketplace: t("sidebar.actions.marketplace"),
      closeSidebar: t("sidebar.actions.closeSidebar"),
    }),
    [t],
  );

  const sharedProps = {
    theme,
    statusGroups,
    pinnedGroups,
    projects,
    workspaceEntriesByKey,
    isInitialLoad,
    isRevalidating,
    isManualRefresh,
    groupMode,
    collapsedProjectKeys,
    shortcutIndexByWorkspaceKey,
    toggleProjectCollapsed,
    handleRefresh,
    handleMarketplace: handleMarketplaceDesktop,
    labels,
    newWorkspaceKeys,
  };

  if (isCompactLayout) {
    return (
      <RetainedPanelActivity active={active}>
        <MobileSidebar
          {...sharedProps}
          handleMarketplace={handleMarketplaceMobile}
          insetsTop={insets.top}
          insetsBottom={insets.bottom}
          closeSidebar={showMobileAgent}
          handleOpenProject={handleOpenProjectMobile}
          handleHome={handleHomeMobile}
          handleSettings={handleSettingsMobile}
          handleAddHost={handleAddHostMobile}
          handleOpenHostSettings={handleOpenHostSettingsMobile}
        />
      </RetainedPanelActivity>
    );
  }

  return (
    <RetainedPanelActivity active={active}>
      <DesktopSidebar
        {...sharedProps}
        handleMarketplace={handleMarketplaceDesktop}
        insetsTop={insets.top}
        insetsBottom={insets.bottom}
        active={active}
        handleOpenProject={handleOpenProjectDesktop}
        handleHome={handleHomeDesktop}
        handleSettings={handleSettingsDesktop}
        handleAddHost={handleAddHostDesktop}
        handleOpenHostSettings={handleOpenHostSettingsDesktop}
        handleViewMore={handleViewMoreNavigate}
        handleViewSchedules={handleViewSchedulesNavigate}
      />
    </RetainedPanelActivity>
  );
});

function sidebarHostOptionTestID(serverId: string): string {
  return `sidebar-host-row-${serverId}`;
}

function FooterIconButton({
  buttonRef,
  onPress,
  testID,
  label,
  icon: Icon,
  iconSize,
  shortcutKeys,
  theme,
}: {
  onPress: () => void;
  testID: string;
  label: string;
  icon: typeof FolderPlus;
  iconSize?: number;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
  theme: SidebarTheme;
  buttonRef?: RefObject<View | null>;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          ref={buttonRef}
          style={styles.footerIconButton}
          testID={testID}
          nativeID={testID}
          collapsable={false}
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
        >
          {({ hovered, pressed }) => (
            <>
              <SidebarFooterIconHighlight visible={pressed} />
              <Icon
                size={iconSize ?? theme.iconSize.md}
                color={hovered ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            </>
          )}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function footerAddProjectButtonStyle({
  hovered,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.footerAddProjectButton, Boolean(hovered) && styles.footerAddProjectButtonHovered];
}

function FooterAddProjectButton({
  onPress,
  label,
  shortcutKeys,
  theme,
}: {
  onPress: () => void;
  label: string;
  shortcutKeys: ReturnType<typeof useShortcutKeys>;
  theme: SidebarTheme;
}) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Pressable
          style={footerAddProjectButtonStyle}
          testID="sidebar-add-project"
          nativeID="sidebar-add-project"
          accessible
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={onPress}
        >
          {({ hovered }) => {
            const isHovered = Boolean(hovered);
            return (
              <>
                <FolderPlus
                  size={theme.iconSize.sm}
                  color={isHovered ? theme.colors.foreground : theme.colors.foregroundMuted}
                />
                <Text
                  numberOfLines={1}
                  style={[
                    styles.footerAddProjectLabel,
                    isHovered && styles.footerAddProjectLabelHovered,
                  ]}
                >
                  {label}
                </Text>
              </>
            );
          }}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <IconTooltipContent label={label} shortcutKeys={shortcutKeys} />
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarHostPicker({
  theme,
  label,
  onAddHost,
  onOpenHostSettings,
}: {
  theme: SidebarTheme;
  label: string;
  onAddHost: () => void;
  onOpenHostSettings: (serverId: string) => void;
}) {
  const hosts = useHosts();
  const triggerRef = useRef<View | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleSelect = useCallback(
    (id: string) => {
      onOpenHostSettings(id);
    },
    [onOpenHostSettings],
  );

  const handleOpen = useCallback(() => setIsOpen(true), []);

  return (
    <HostPicker
      hosts={hosts}
      value=""
      onSelect={handleSelect}
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={triggerRef}
      includeAddHost
      onAddHost={onAddHost}
      showActiveConnection
      onOpenHostSettings={onOpenHostSettings}
      searchable
      desktopPlacement="top-start"
      desktopMinWidth={240}
      addHostTestID="sidebar-host-add"
      hostOptionTestID={sidebarHostOptionTestID}
    >
      <FooterIconButton
        buttonRef={triggerRef}
        onPress={handleOpen}
        testID="sidebar-hosts-trigger"
        label={label}
        icon={Server}
        iconSize={theme.iconSize.sm}
        theme={theme}
      />
    </HostPicker>
  );
}

function IconTooltipContent({
  label,
  shortcutKeys,
}: {
  label: string;
  shortcutKeys?: ReturnType<typeof useShortcutKeys>;
}) {
  return (
    <View style={styles.tooltipRow}>
      <Text style={styles.tooltipText}>{label}</Text>
      {shortcutKeys ? <Shortcut chord={shortcutKeys} /> : null}
    </View>
  );
}

const SidebarNewWorkspaceHeaderRow = memo(function SidebarNewWorkspaceHeaderRow({
  label,
  testID,
  variant,
  shortcutKeys,
  onBeforeNavigate,
}: {
  label: string;
  testID: string;
  variant: "header" | "compact";
  shortcutKeys: ShortcutKey[][] | null;
  onBeforeNavigate?: () => void;
}) {
  const handlePress = useNewWorkspaceNavigate(onBeforeNavigate);

  return (
    <SidebarHeaderRow
      icon={Plus}
      label={label}
      onPress={handlePress}
      testID={testID}
      variant={variant}
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarFooter({
  theme,
  handleOpenProject,
  handleHome,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  showAddProject = true,
}: {
  theme: SidebarTheme;
  handleOpenProject: () => void;
  handleHome: () => void;
  handleSettings: () => void;
  labels: {
    addProject: string;
    hosts: string;
    home: string;
    pairDevice: string;
    settings: string;
    searchHosts: string;
  };
  handleAddHost: () => void;
  handleOpenHostSettings: (serverId: string) => void;
  showAddProject?: boolean;
}) {
  const openUsage = useOpenSidebarUsage();
  const usageSummary = useUsageSummary();
  const newAgentKeys = useShortcutKeys("new-agent");
  const settingsKeys = useShortcutKeys("toggle-settings");
  const isGumloop = useIsGumloopTheme();
  const localServerId = useLocalDaemonServerId();
  const openPairDeviceModal = usePairDeviceModalStore((state) => state.open);
  const handleOpenPairDevice = useCallback(() => {
    if (localServerId) {
      openPairDeviceModal(localServerId);
    }
  }, [localServerId, openPairDeviceModal]);

  return (
    <View style={[styles.sidebarFooter, styles.footerWithUsage]} testID="sidebar-footer">
      <SidebarHeaderRow
        icon={BarChart3}
        label="Usage"
        onPress={openUsage}
        testID="sidebar-usage-open"
        variant="compact"
      />
      <UsageSidebarItem sources={usageSummary} />
      {showAddProject ? (
        <FooterAddProjectButton
          onPress={handleOpenProject}
          label={labels.addProject}
          shortcutKeys={newAgentKeys}
          theme={theme}
        />
      ) : null}
      {/* The Gumloop shell moves hosts, help, pairing and settings to the top bar and rail. */}
      <View style={isGumloop ? styles.footerIconRowHidden : styles.footerIconRow}>
        <SidebarHostPicker
          theme={theme}
          label={labels.hosts}
          onAddHost={handleAddHost}
          onOpenHostSettings={handleOpenHostSettings}
        />
        <FooterIconButton
          onPress={handleHome}
          testID="sidebar-home"
          label={labels.home}
          icon={Home}
          theme={theme}
        />
        {localServerId ? (
          <FooterIconButton
            onPress={handleOpenPairDevice}
            testID="sidebar-pair-device"
            label={labels.pairDevice}
            icon={Smartphone}
            theme={theme}
          />
        ) : null}
        <SidebarHelpMenu />
        <FooterIconButton
          onPress={handleSettings}
          testID="sidebar-settings"
          label={labels.settings}
          icon={Settings}
          shortcutKeys={settingsKeys}
          theme={theme}
        />
      </View>
    </View>
  );
}

function MobileSidebar({
  theme,
  statusGroups,
  pinnedGroups,
  projects,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  newWorkspaceKeys,
  handleOpenProject,
  handleHome,
  handleSettings,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  insetsBottom,
  closeSidebar,
}: MobileSidebarProps) {
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const pathname = usePathname();
  // Section panels (Argo CD) are desktop-only, as core sections are.
  const navigationPanel = builtinClientRegistry.navigationPanelRoute(pathname);
  const builtinPanelRoute = navigationPanel?.section ? null : navigationPanel;
  const { gesture: closeGesture, gestureRef: closeGestureRef } = useCloseAgentListGesture();
  const isGumloop = useIsGumloopTheme();
  const dragGestureHostPresented = useIsMobilePanelPresented("agent-list");

  const handleWorkspacePress = useCallback(() => {
    closeSidebar();
  }, [closeSidebar]);

  const mobileSidebarInsetStyle = useMemo(
    () => ({
      paddingTop: insetsTop,
      paddingBottom: insetsBottom,
      backgroundColor: theme.colors.surfaceSidebar,
    }),
    [insetsTop, insetsBottom, theme.colors.surfaceSidebar],
  );

  const mobileWorkspaceBody =
    isInitialLoad && !hasActiveHostFilter ? (
      <SidebarAgentListSkeleton />
    ) : (
      <SidebarWorkspaceList
        collapsedProjectKeys={collapsedProjectKeys}
        onToggleProjectCollapsed={toggleProjectCollapsed}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        groupMode={groupMode}
        statusGroups={statusGroups}
        pinnedGroups={pinnedGroups}
        projects={projects}
        workspaceEntriesByKey={workspaceEntriesByKey}
        isRefreshing={isManualRefresh && isRevalidating}
        onRefresh={handleRefresh}
        onWorkspacePress={handleWorkspacePress}
        onAddProject={handleOpenProject}
        parentGestureRef={closeGestureRef}
        dragGestureHostPresented={dragGestureHostPresented}
        listHeaderComponent={workspacesSectionHeaderElement}
      />
    );

  const mobileNavRows = (
    <View style={styles.sidebarHeaderGroup}>
      {isGumloop ? null : (
        <SidebarNewWorkspaceHeaderRow
          label={labels.newWorkspace}
          testID="sidebar-global-new-workspace"
          variant="compact"
          shortcutKeys={newWorkspaceKeys}
          onBeforeNavigate={closeSidebar}
        />
      )}
      <MobileNavGrid onBeforeNavigate={closeSidebar} parentGestureRef={closeGestureRef} />
      <PluginSidebarItems onBeforeNavigate={closeSidebar} />
    </View>
  );

  const mobileNavigation = platformIsNative ? (
    <GHScrollView
      simultaneousHandlers={closeGestureRef}
      style={styles.mobileNavScroll}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical={false}
      testID="sidebar-nav-scroll"
    >
      {mobileNavRows}
    </GHScrollView>
  ) : (
    <ScrollView
      style={styles.mobileNavScroll}
      showsVerticalScrollIndicator={false}
      alwaysBounceVertical={false}
      testID="sidebar-nav-scroll"
    >
      {mobileNavRows}
    </ScrollView>
  );

  return (
    <MobilePanelOverlay
      panel="agent-list"
      closeGesture={closeGesture}
      panelStyle={mobileSidebarInsetStyle}
    >
      <View style={styles.sidebarContent} pointerEvents="auto">
        <WindowChromeSafeArea placement="below" />
        {isGumloop ? (
          <GumloopSidebarHeader onBeforeNavigate={closeSidebar} reserveCloseButton />
        ) : null}
        {builtinPanelRoute ? null : mobileNavigation}
        <WindowChromeSafeArea placement="inline" style={styles.mobileCloseButtonRow}>
          <Pressable
            style={styles.mobileCloseButton}
            onPress={closeSidebar}
            testID="sidebar-close"
            nativeID="sidebar-close"
            accessible
            accessibilityRole="button"
            accessibilityLabel={labels.closeSidebar}
            hitSlop={8}
          >
            {({ hovered, pressed }) => (
              <X
                size={theme.iconSize.md}
                color={hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted}
              />
            )}
          </Pressable>
        </WindowChromeSafeArea>

        {resolveSidebarNavBody(
          builtinPanelRoute,
          <SidebarToastRegion active={dragGestureHostPresented}>
            {mobileWorkspaceBody}
          </SidebarToastRegion>,
        )}

        <SidebarFooter
          theme={theme}
          handleOpenProject={handleOpenProject}
          handleHome={handleHome}
          handleSettings={handleSettings}
          labels={labels}
          handleAddHost={handleAddHost}
          handleOpenHostSettings={handleOpenHostSettings}
        />
      </View>
    </MobilePanelOverlay>
  );
}

function DesktopSidebar({
  theme,
  statusGroups,
  pinnedGroups,
  projects,
  workspaceEntriesByKey,
  isInitialLoad,
  isRevalidating,
  isManualRefresh,
  groupMode,
  collapsedProjectKeys,
  shortcutIndexByWorkspaceKey,
  toggleProjectCollapsed,
  handleRefresh,
  newWorkspaceKeys,
  handleOpenProject,
  handleHome,
  handleSettings,
  handleMarketplace,
  labels,
  handleAddHost,
  handleOpenHostSettings,
  insetsTop,
  insetsBottom,
  active,
  handleViewMore,
  handleViewSchedules,
}: DesktopSidebarProps) {
  const builtinTargets = useAppNavTargets();
  const handleBots = useCallback(() => {
    if (builtinTargets.botsRoute) router.push(builtinTargets.botsRoute);
  }, [builtinTargets.botsRoute]);
  const ownsTopLeft = useOwnsWindowChromeCorner("top-left");
  const isGumloop = useIsGumloopTheme();
  const pathname = usePathname();
  const hasActiveHostFilter = useSidebarViewStore((state) => state.hostFilters.length > 0);
  const isSessionsActive = pathname.includes("/sessions");
  const isSchedulesActive = pathname.includes("/schedules");
  const isMarketplaceActive = pathname.includes("/marketplace");
  const builtinPanelRoute = builtinClientRegistry.navigationPanelRoute(pathname);
  const sectionRoute = resolveSectionRoute(pathname);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const setSidebarWidth = usePanelStore((state) => state.setSidebarWidth);
  const { width: viewportWidth } = useWindowDimensions();
  const visibleSidebarWidth = resolveDesktopSidebarWidth({
    requestedWidth: sidebarWidth,
    viewportWidth,
  });

  const startWidthRef = useRef(visibleSidebarWidth);
  const resizeWidth = useSharedValue(visibleSidebarWidth);

  useEffect(() => {
    resizeWidth.value = visibleSidebarWidth;
  }, [resizeWidth, visibleSidebarWidth]);

  const resizeGesture = useMemo(
    () =>
      Gesture.Pan()
        .hitSlop({ left: 8, right: 8, top: 0, bottom: 0 })
        .onStart(() => {
          startWidthRef.current = visibleSidebarWidth;
          resizeWidth.value = visibleSidebarWidth;
        })
        .onUpdate((event) => {
          // Dragging right (positive translationX) increases width
          const newWidth = startWidthRef.current + event.translationX;
          resizeWidth.value = resolveDesktopSidebarWidth({
            requestedWidth: newWidth,
            viewportWidth,
          });
        })
        .onEnd(() => {
          runOnJS(setSidebarWidth)(resizeWidth.value);
        }),
    [resizeWidth, setSidebarWidth, viewportWidth, visibleSidebarWidth],
  );

  const resizeAnimatedStyle = useAnimatedStyle(() => ({
    width: resizeWidth.value,
  }));

  const desktopSidebarStyle = useMemo(
    () => [
      staticStyles.desktopSidebar,
      !active && staticStyles.desktopSidebarHidden,
      resizeAnimatedStyle,
    ],
    [active, resizeAnimatedStyle],
  );
  const desktopSidebarBorderStyle = useMemo(
    () => [
      styles.desktopSidebarBorder,
      { flex: 1, paddingTop: insetsTop, paddingBottom: insetsBottom },
    ],
    [insetsTop, insetsBottom],
  );
  const sidebarHeaderGroupStyle = useMemo(
    () => [styles.sidebarHeaderGroup, ownsTopLeft && styles.sidebarHeaderGroupBelowChrome],
    [ownsTopLeft],
  );
  const workspaceListElement =
    isInitialLoad && !hasActiveHostFilter ? (
      <SidebarAgentListSkeleton />
    ) : (
      <SidebarWorkspaceList
        collapsedProjectKeys={collapsedProjectKeys}
        onToggleProjectCollapsed={toggleProjectCollapsed}
        shortcutIndexByWorkspaceKey={shortcutIndexByWorkspaceKey}
        groupMode={groupMode}
        statusGroups={statusGroups}
        pinnedGroups={pinnedGroups}
        projects={projects}
        workspaceEntriesByKey={workspaceEntriesByKey}
        isRefreshing={isManualRefresh && isRevalidating}
        onRefresh={handleRefresh}
        onAddProject={handleOpenProject}
        listHeaderComponent={workspacesSectionHeaderElement}
      />
    );
  return (
    <Animated.View
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      pointerEvents={active ? "auto" : "none"}
      style={desktopSidebarStyle}
    >
      <View style={desktopSidebarBorderStyle}>
        <View style={styles.sidebarDragArea}>
          {ownsTopLeft ? (
            <View style={styles.desktopChromeRow}>
              <TitlebarDragRegion />
            </View>
          ) : (
            <View style={styles.desktopDragStrip}>
              <TitlebarDragRegion />
            </View>
          )}
          {isGumloop && !sectionRoute && !builtinPanelRoute?.section ? (
            <GumloopSidebarHeader />
          ) : null}
        </View>
        {builtinPanelRoute || sectionRoute || isGumloop ? null : (
          <ScrollView
            dataSet={WINDOW_CONTENT_DATASET}
            style={styles.navScroll}
            contentContainerStyle={sidebarHeaderGroupStyle}
            showsVerticalScrollIndicator={false}
            testID="sidebar-nav-scroll"
          >
            <SidebarNewWorkspaceHeaderRow
              label={labels.newWorkspace}
              testID="sidebar-global-new-workspace"
              variant="compact"
              shortcutKeys={newWorkspaceKeys}
            />
            <SidebarHeaderRow
              icon={History}
              label={labels.sessions}
              onPress={handleViewMore}
              isActive={isSessionsActive}
              testID="sidebar-sessions"
              variant="compact"
            />
            <SidebarHeaderRow
              icon={CalendarClock}
              label={labels.schedules}
              onPress={handleViewSchedules}
              isActive={isSchedulesActive}
              testID="sidebar-schedules"
              variant="compact"
            />
            <NavTargetGate route={builtinTargets.botsRoute}>
              <SidebarHeaderRow
                icon={Bot}
                label={labels.bots}
                onPress={handleBots}
                isActive={pathname.includes("/bots")}
                testID="sidebar-bots"
                variant="compact"
              />
            </NavTargetGate>
            <BuiltinSidebarDestinations only={CLASSIC_SLOT_SHARING} />

            <BuiltinSidebarDestinations only={CLASSIC_SLOT_INFRA} />
            <BuiltinSidebarDestinations only={CLASSIC_SLOT_DEPLOY} />
            <BuiltinSidebarDestinations only={CLASSIC_SLOT_INTEGRATIONS} />
            <BuiltinSidebarDestinations only={CLASSIC_SLOT_SKILLS} />
            <SidebarHeaderRow
              icon={Store}
              label={labels.marketplace}
              onPress={handleMarketplace}
              isActive={isMarketplaceActive}
              testID="sidebar-marketplace-nav"
              variant="compact"
            />
            <BuiltinSidebarDestinations except={CLASSIC_PLACED_DESTINATIONS} />
            <BuiltinSidebarDestinations only={CLASSIC_SLOT_INSIGHTS} />
            <BuiltinSidebarDestinations only={CLASSIC_SLOT_TAIL} />
            <PluginSidebarItems />
          </ScrollView>
        )}

        {resolveSidebarNavBody(
          builtinPanelRoute,
          <SidebarToastRegion active={active}>{workspaceListElement}</SidebarToastRegion>,
          sectionRoute,
        )}

        <SidebarCalloutSlot />

        {shouldShowSidebarFooter(pathname) ? (
          <SidebarFooter
            theme={theme}
            handleOpenProject={handleOpenProject}
            handleHome={handleHome}
            handleSettings={handleSettings}
            labels={labels}
            handleAddHost={handleAddHost}
            handleOpenHostSettings={handleOpenHostSettings}
            showAddProject={shouldShowAddProject(pathname)}
          />
        ) : null}

        <SidebarResizeHandle
          edge="right"
          gesture={resizeGesture}
          testID="left-sidebar-resize-handle"
        />
      </View>
    </Animated.View>
  );
}

function WorkspacesSectionHeader() {
  const { theme } = useUnistyles();
  const isGumloop = useIsGumloopTheme();
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const commandCenterKeys = useShortcutKeys("toggle-command-center");
  const handleSearchPress = useCallback(() => setCommandCenterOpen(true), [setCommandCenterOpen]);
  const searchButtonStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.workspacesHeaderIconButton,
      (hovered || pressed) && styles.workspacesHeaderIconButtonHovered,
    ],
    [],
  );

  return (
    <View style={styles.workspacesSectionHeader}>
      <Text style={styles.workspacesSectionTitle}>{isGumloop ? "Projects" : "Workspaces"}</Text>
      <View style={styles.workspacesSectionActions}>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open command center"
              testID="sidebar-command-center-search"
              style={searchButtonStyle}
              onPress={handleSearchPress}
            >
              {({ hovered, pressed }) => (
                <Search
                  size={14}
                  color={
                    hovered || pressed ? theme.colors.foreground : theme.colors.foregroundMuted
                  }
                />
              )}
            </Pressable>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <IconTooltipContent label="Search" shortcutKeys={commandCenterKeys} />
          </TooltipContent>
        </Tooltip>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <View>
              <SidebarDisplayPreferencesMenu />
            </View>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={8}>
            <IconTooltipContent label="Display preferences" />
          </TooltipContent>
        </Tooltip>
      </View>
    </View>
  );
}

// Stable element so the sidebar list's listHeaderComponent prop keeps identity across
// renders (WorkspacesSectionHeader takes no props).
const workspacesSectionHeaderElement = <WorkspacesSectionHeader />;

// Static styles for Animated.Views — must NOT use Unistyles dynamic theme to
// avoid the "Unable to find node on an unmounted component" crash when Unistyles
// tries to patch the native node that Reanimated also manages.
const staticStyles = RNStyleSheet.create({
  desktopSidebar: {
    position: "relative" as const,
  },
  desktopSidebarHidden: {
    display: "none",
  },
});

const styles = StyleSheet.create((theme) => ({
  mobileNavScroll: { flexGrow: 0, flexShrink: 1, maxHeight: "50%" },
  navScroll: { flexGrow: 0, flexShrink: 1, maxHeight: "50%" },
  desktopDragStrip: { position: "relative", height: theme.spacing[2] },
  sidebarHeaderGroup: {
    paddingTop: theme.spacing[2],
    gap: 2,
    paddingBottom: theme.spacing[1.5],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  sidebarHeaderGroupBelowChrome: {
    paddingTop: 0,
  },
  workspacesSectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    // Rendered inside the scroll's listContent (paddingHorizontal spacing[2]), so the
    // title lands at spacing[2] left to align with project icons, and the trailing
    // pill sits flush with the list edge on the right.
    paddingLeft: theme.spacing[2],
    paddingRight: 0,
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  workspacesSectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
  },
  workspacesSectionActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  workspacesHeaderIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  workspacesHeaderIconButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  sidebarContent: {
    flex: 1,
    minHeight: 0,
  },
  mobileCloseButtonRow: {
    position: "absolute",
    top: theme.spacing[3],
    left: 0,
    right: 0,
    zIndex: 2,
    alignItems: "flex-end",
    pointerEvents: "box-none",
  },
  mobileCloseButton: {
    marginRight: theme.spacing[4],
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  desktopSidebarBorder: {
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  sidebarDragArea: {
    position: "relative",
  },
  desktopChromeRow: {
    position: "relative",
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
  footerWithUsage: { flexDirection: "column", alignItems: "stretch" },
  sidebarFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  footerIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexShrink: 0,
  },
  footerIconRowHidden: {
    display: "none",
  },
  footerAddProjectButton: {
    minWidth: 0,
    minHeight: 32,
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  footerAddProjectButtonHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  footerAddProjectLabel: {
    minWidth: 0,
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  footerAddProjectLabelHovered: {
    color: theme.colors.foreground,
  },
  footerIconButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
}));

function NavTargetGate({ route, children }: { route: Href | null; children: ReactNode }) {
  return route ? children : null;
}
