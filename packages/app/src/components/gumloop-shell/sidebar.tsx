import { builtinClientRegistry } from "@/plugins/builtin/loaded";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { openSettingsFromSidebar } from "@/navigation/settings-navigation";
import { getSettingsSidebarReturn } from "@/navigation/settings-presentation/session";
import { getLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWindowDimensions, type LayoutChangeEvent } from "react-native";
import { useWindowLayout, resolveDesktopDivisionLayout } from "@/window-layout";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountButton } from "./account-button";
import { BuiltinLeftPanel } from "@/plugins/builtin/surfaces";
import { GumloopRow } from "./row";
export { GumloopRow } from "./row";
import { JAgentDeskLogo } from "@/components/icons/jagentdesk-logo";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarViewSlot } from "@/plugins/sidebar-view/slot";
import { PortalHost } from "@gorhom/portal";
import { router, usePathname } from "expo-router";
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import {
  ArrowLeft,
  ArrowDownUp,
  Blocks,
  ChevronDown,
  ChevronRight,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Smartphone,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { HostPicker } from "@/components/hosts/host-picker";
import { useTranslation } from "react-i18next";
import { hostTransportLabelKey } from "@/types/host-connection";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { HostStatusDot } from "@/components/host-status-dot";
import { SidebarWorkspaceList } from "@/components/sidebar-workspace-list";
import { SidebarToastRegion } from "@/components/sidebar/sidebar-toast-region";
import { SidebarSelectionHost } from "@/sidebar-selection";
import { useSidebarModel } from "@/components/sidebar/sidebar-model";
import {
  useAppNavItems,
  useNewWorkspaceNavigate,
  type AppNavItem,
} from "@/components/sidebar/use-app-nav";
import { SidebarDisplayPreferencesMenu } from "@/components/sidebar/sidebar-display-preferences-menu";
import { SidebarHelpMenu } from "@/components/sidebar/sidebar-help-menu";
import { usePluginSidebarGroups, usePluginSidebarNavigation } from "@/plugins/sidebar-items";
import { resolvePluginIcon } from "@/plugins/icons";
import type { PluginSidebarGroup } from "@/plugins/sidebar-groups";
import { openPluginSidebarItem, usePluginScreenSidebarItems } from "@/plugins/sidebar-screen-items";
import { useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { usePanelStore } from "@/stores/panel-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { usePairDeviceModalStore } from "@/stores/pair-device-modal-store";
import { useUsageSummary, UsageSidebarItem } from "@/usage/sidebar-item";
import { BrowserTabsHostButton } from "@/desktop/browser/live-tabs/host-button";
import { NotificationsHostButton } from "@/notification-feed/host-button";
import type { Theme } from "@/styles/theme";
import {
  buildSettingsAddHostRoute,
  buildClientHostSettingsRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { resolveSidebarNavBody, resolveSectionRoute } from "@/components/left-sidebar";
import { WorkspaceSidebar } from "./workspace-sidebar";
import { SidebarBotsSection } from "@/bots/sidebar-section";
import { useSidebarMiddleHeight } from "@/bots/sidebar-store";
import {
  GUMLOOP_PANEL_HOST,
  resolveSidebarDrillIn as resolveCoreSidebarDrillIn,
  useGumloopSidebarState,
} from "./sidebar-state";

function resolveSidebarDrillIn(pathname: string) {
  return resolveCoreSidebarDrillIn(pathname, builtinClientRegistry.drillTitles());
}

const PRIMARY_ORDER: readonly string[] = [
  "home",
  "sessions",
  "schedules",
  "skills",
  "memory",
  "marketplace",
  "usage",
  "insights",
];
const PRIMARY_KEYS = new Set(PRIMARY_ORDER);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedPanelLeft = withUnistyles(PanelLeft);
const ThemedSearch = withUnistyles(Search);
const ThemedArrowDownUp = withUnistyles(ArrowDownUp);
const ThemedPlus = withUnistyles(Plus);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedArrowLeft = withUnistyles(ArrowLeft);

function NavRow({ item, onNavigate }: { item: AppNavItem; onNavigate: () => void }) {
  const onPress = useCallback(() => {
    onNavigate();
    if (item.onPress) item.onPress();
    else router.push(item.route);
  }, [item, onNavigate]);
  let label = item.label;
  if (item.key === "simulators") label = "Devices";
  if (item.key === "databases") label = "Data";
  if (item.key === "marketplace") label = "Market";
  return (
    <GumloopRow
      icon={item.icon}
      label={label}
      selected={item.isActive}
      onPress={onPress}
      testID={`sidebar-${item.key}`}
    />
  );
}

function BrandRow() {
  const openSearch = useCallback(
    () => useKeyboardShortcutsStore.getState().setCommandCenterOpen(true),
    [],
  );
  const compact = useIsCompactFormFactor();
  const collapse = usePanelStore((state) =>
    compact ? state.showMobileAgent : state.closeDesktopAgentList,
  );
  return (
    <WindowChromeSafeArea placement="inline" style={styles.brand}>
      <TitlebarDragRegion />
      <JAgentDeskLogo size={28} />
      <Text style={styles.brandName}>JAgentDesk</Text>
      <Pressable
        onPress={openSearch}
        accessibilityRole="button"
        accessibilityLabel="Command Center ⌘K"
        style={styles.iconButton}
        testID="gumloop-search"
      >
        <ThemedSearch size={18} uniProps={foreground} />
      </Pressable>
      <Pressable
        onPress={collapse}
        accessibilityRole="button"
        accessibilityLabel="Collapse sidebar"
        style={styles.iconButton}
        testID="gumloop-sidebar-toggle"
      >
        <ThemedPanelLeft size={18} uniProps={foreground} />
      </Pressable>
    </WindowChromeSafeArea>
  );
}

function HostRow({ serverId }: { serverId: string }) {
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<View | null>(null);
  const openPicker = useCallback(() => setOpen(true), []);
  const focusHost = useSidebarViewStore((state) => state.focusHost);
  const select = useCallback(
    (id: string) => {
      focusHost(id);
      router.push(`/h/${encodeURIComponent(id)}`);
    },
    [focusHost],
  );
  const add = useCallback(() => router.push(buildSettingsAddHostRoute(Date.now())), []);
  return (
    <HostPicker
      hosts={hosts}
      value={serverId}
      onSelect={select}
      open={open}
      onOpenChange={setOpen}
      anchorRef={anchorRef}
      includeAddHost
      onAddHost={add}
      showActiveConnection
      searchable
      desktopPlacement="bottom-start"
      desktopMinWidth={328}
    >
      <Pressable
        ref={anchorRef}
        onPress={openPicker}
        accessibilityRole="button"
        accessibilityLabel="Switch host"
        style={styles.hostRow}
        testID="gumloop-host-switcher"
      >
        <HostStatusDot serverId={serverId} />
        <Text style={styles.label} numberOfLines={1}>
          {host?.label ?? "No host"}
        </Text>
        <ThemedArrowDownUp size={18} uniProps={foreground} />
      </Pressable>
    </HostPicker>
  );
}

function ConnectionFooter({ serverId, onNavigate }: { serverId: string; onNavigate: () => void }) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const settingsSelected = resolveSidebarDrillIn(pathname)?.kind === "settings";
  const hosts = useHosts();
  const host = hosts.find((entry) => entry.serverId === serverId);
  const snapshot = useHostRuntimeSnapshot(serverId);
  const sources = useUsageSummary();
  const pair = usePairDeviceModalStore((state) => state.open);
  const handlePair = useCallback(() => {
    onNavigate();
    pair(serverId);
  }, [onNavigate, pair, serverId]);
  const compact = useIsCompactFormFactor();
  const settings = useCallback(
    () => openSettingsFromSidebar({ workspace: getLastWorkspaceSelection(), isCompact: compact }),
    [compact],
  );
  const connections = useCallback(() => {
    onNavigate();
    router.push(buildClientHostSettingsRoute(serverId));
  }, [serverId, onNavigate]);
  // Same transport label as the host picker and Settings: Local, Tailscale or
  // Relay (spec 05.1.2; the desktop's bundled daemon reads "Local", ADR-0056).
  const transportLabel = t(hostTransportLabelKey(snapshot?.activeConnection?.type ?? "directTcp"));
  return (
    <View style={styles.footer} testID="gumloop-sidebar-footer">
      {sources.length > 0 ? (
        <View style={styles.usage} testID="gumloop-sidebar-usage">
          <UsageSidebarItem sources={sources} onNavigate={onNavigate} />
        </View>
      ) : null}
      <Pressable
        onPress={connections}
        style={styles.connection}
        accessibilityRole="button"
        testID="gumloop-connection"
      >
        <View style={styles.connectionHeading}>
          <Text style={styles.connectionTitle}>Connection</Text>
          <HostStatusDot serverId={serverId} />
        </View>
        <Text style={styles.muted}>
          {snapshot?.connectionStatus === "online"
            ? transportLabel
            : (snapshot?.connectionStatus ?? "Disconnected")}
        </Text>
      </Pressable>
      <View style={styles.account}>
        <Pressable
          style={styles.accountHost}
          onPress={connections}
          accessibilityRole="button"
          accessibilityLabel="Host account"
        >
          <View style={styles.avatar}>
            <Text style={styles.avatarLetter}>{(host?.label ?? "?").charAt(0).toUpperCase()}</Text>
          </View>
          <Text numberOfLines={1} style={styles.label}>
            {host?.label ?? "No host"}
          </Text>
        </Pressable>
        <AccountButton
          icon={Smartphone}
          label="Pair device"
          onPress={handlePair}
          testID="sidebar-pair-device"
        />
        <AccountButton
          icon={Settings}
          label="Settings"
          onPress={settings}
          selected={settingsSelected}
          testID="sidebar-settings"
        />
        <BrowserTabsHostButton />
        <NotificationsHostButton serverId={serverId} onNavigate={onNavigate} />
        <SidebarHelpMenu />
      </View>
    </View>
  );
}
// Group headings (spec 38 §4.2 "Nhóm Tools"/"Nhóm Projects"): a 12/600 muted title, then the
// fold chevron on the right, then any group actions.
function GroupHeading({
  title,
  count,
  collapsed,
  onPress,
  children,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  onPress: () => void;
  children?: ReactNode;
}) {
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const Chevron = collapsed ? ThemedChevronRight : ThemedChevronDown;
  return (
    <View style={styles.groupHeading}>
      <Pressable
        style={styles.groupToggle}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${collapsed ? "Expand" : "Collapse"} ${title}`}
        accessibilityState={accessibilityState}
        aria-expanded={!collapsed}
        testID={`gumloop-group-${title.toLowerCase()}`}
      >
        <Text style={styles.groupLabel} numberOfLines={1}>
          {count === undefined ? title : `${title} · ${count}`}
        </Text>
        <Chevron size={14} uniProps={muted} />
      </Pressable>
      {children}
    </View>
  );
}

function PluginGroupRow({
  group,
  onNavigate,
}: {
  group: PluginSidebarGroup;
  onNavigate: () => void;
}) {
  const { navigate, isActive } = usePluginSidebarNavigation(group, onNavigate);
  const icon = useMemo(() => resolvePluginIcon(group.icon), [group.icon]);
  return (
    <GumloopRow
      icon={icon}
      label={group.title}
      selected={isActive}
      onPress={navigate}
      testID={`plugin-sidebar-${group.pluginId}-${group.contributionId}`}
    />
  );
}

function RootNavigation({ serverId, onNavigate }: { serverId: string; onNavigate: () => void }) {
  // Bots is a section above Projects, not a nav row (spec 38.4.2).
  const items = useAppNavItems().filter((item) => item.key !== "bots");
  const groups = usePluginSidebarGroups();
  const pluginHeaders = usePluginScreenSidebarItems("header");
  const pluginFooters = usePluginScreenSidebarItems("footer");
  const tools = items.filter((item) => !PRIMARY_KEYS.has(item.key) && item.group !== "main");
  const toolsCollapsed = useGumloopSidebarState((state) => state.toolsCollapsed);
  const projectsCollapsed = useGumloopSidebarState((state) => state.projectsCollapsed);
  const setCollapsed = useGumloopSidebarState((state) => state.setToolsCollapsed);
  const toggleProjects = useGumloopSidebarState((state) => state.toggleProjects);
  const toolCount = tools.length + groups.length + pluginHeaders.length + pluginFooters.length;
  const toggleTools = useCallback(
    () => setCollapsed(!toolsCollapsed),
    [setCollapsed, toolsCollapsed],
  );
  const openAddProject = useOpenAddProject();
  const addProject = useCallback(() => openAddProject(), [openAddProject]);
  return (
    <View style={styles.navigation}>
      <View style={styles.navItems}>
        {items
          .filter((item) => PRIMARY_KEYS.has(item.key) || item.group === "main")
          .sort((left, right) => PRIMARY_ORDER.indexOf(left.key) - PRIMARY_ORDER.indexOf(right.key))
          .map((item) => (
            <NavRow key={item.key} item={item} onNavigate={onNavigate} />
          ))}
      </View>
      {toolCount > 0 ? (
        <View testID="gumloop-tools">
          <View style={styles.divider} />
          <GroupHeading
            title="Tools"
            count={toolCount}
            collapsed={toolsCollapsed}
            onPress={toggleTools}
          />
          {toolsCollapsed ? null : (
            <View style={styles.navItems}>
              {tools.map((item) => (
                <NavRow key={item.key} item={item} onNavigate={onNavigate} />
              ))}
              {groups.map((group) => (
                <PluginGroupRow key={group.key} group={group} onNavigate={onNavigate} />
              ))}
              {[...pluginHeaders, ...pluginFooters].map(({ key, plugin, item }) => (
                <ScreenPluginRow key={key} plugin={plugin} item={item} />
              ))}
            </View>
          )}
        </View>
      ) : null}
      {serverId ? (
        <View style={styles.botsSection}>
          <SidebarBotsSection serverId={serverId} onNavigate={onNavigate} />
        </View>
      ) : null}
      <View style={styles.projectsHeading}>
        <GroupHeading title="Projects" collapsed={projectsCollapsed} onPress={toggleProjects}>
          <SidebarDisplayPreferencesMenu />
          <Pressable
            onPress={addProject}
            accessibilityRole="button"
            accessibilityLabel="Add project"
            style={styles.iconButton}
          >
            <ThemedPlus size={18} uniProps={foreground} />
          </Pressable>
        </GroupHeading>
      </View>
    </View>
  );
}

function DestinationPanel({ pathname }: { pathname: string }) {
  const drill = resolveSidebarDrillIn(pathname);
  if (drill?.kind === "destination" && builtinClientRegistry.hasPanel(drill.section))
    return <BuiltinLeftPanel serverId={drill.serverId} segment={drill.section} />;
  if (drill?.kind === "settings") return <PortalHost name={GUMLOOP_PANEL_HOST} />;
  return resolveSidebarNavBody(
    null,
    <DestinationLinks pathname={pathname} />,
    resolveSectionRoute(pathname),
  );
}

function DestinationLinks({ pathname: _pathname }: { pathname: string }) {
  const items = useAppNavItems();
  const navigate = useCallback(() => {}, []);
  return (
    <ScrollView contentContainerStyle={styles.drillContent}>
      {items
        .filter((item) => item.isActive)
        .map((item) => (
          <NavRow key={item.key} item={item} onNavigate={navigate} />
        ))}
    </ScrollView>
  );
}

function ScreenPluginRow({ plugin, item }: ReturnType<typeof usePluginScreenSidebarItems>[number]) {
  const open = useCallback(() => openPluginSidebarItem(plugin, item.id), [plugin, item.id]);
  return (
    <GumloopRow
      icon={Blocks}
      label={item.title}
      onPress={open}
      testID={`sidebar-plugin-${plugin.id}-${item.id}`}
    />
  );
}

function sidebarDrillTitle(
  drill: ReturnType<typeof resolveSidebarDrillIn>,
  workspaceName: string | undefined,
): string {
  if (drill?.kind === "workspace") return workspaceName ?? "Workspace";
  return drill?.title ?? "";
}

function useSidebarPathname(): string {
  const routePathname = usePathname();
  const origin = getSettingsSidebarReturn();
  return routePathname.startsWith("/settings") && origin
    ? `/h/${encodeURIComponent(origin.serverId)}/workspace/${encodeURIComponent(origin.workspaceId)}`
    : routePathname;
}

export function GumloopSidebar({ active }: { active: boolean }) {
  const pathname = useSidebarPathname();
  const hosts = useHosts();
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const match = /^\/h\/([^/]+)/.exec(pathname);
  const serverId = match
    ? decodeURIComponent(match[1])
    : (hostFilters[0] ?? hosts[0]?.serverId ?? "");
  const [dismissedPath, setDismissedPath] = useState<string | null>(null);
  const drill = pathname === dismissedPath ? null : resolveSidebarDrillIn(pathname);
  const model = useSidebarModel();
  const workspace =
    drill?.kind === "workspace"
      ? model.workspaceEntriesByKey.get(`${drill.serverId}:${drill.workspaceId}`)
      : null;
  const title = sidebarDrillTitle(drill, workspace?.name);
  const navigateNewAgent = useNewWorkspaceNavigate();
  const newAgent = useCallback(() => {
    usePanelStore.getState().showMobileAgent();
    navigateNewAgent();
  }, [navigateNewAgent]);
  const projectsCollapsed = useGumloopSidebarState((state) => state.projectsCollapsed);
  const openAddProject = useOpenAddProject();
  const addProject = useCallback(() => openAddProject(), [openAddProject]);
  const resetDrill = useCallback(() => {
    setDismissedPath(null);
    usePanelStore.getState().showMobileAgent();
  }, []);
  const back = useCallback(() => setDismissedPath(pathname), [pathname]);
  const navigation = useMemo(
    () => <RootNavigation serverId={serverId} onNavigate={resetDrill} />,
    [resetDrill, serverId],
  );
  const setMiddleHeight = useSidebarMiddleHeight((state) => state.set);
  const onMiddleLayout = useCallback(
    (event: LayoutChangeEvent) => setMiddleHeight(event.nativeEvent.layout.height),
    [setMiddleHeight],
  );
  let middle: ReactNode;
  if (drill?.kind === "workspace")
    middle = <WorkspaceSidebar serverId={drill.serverId} workspaceId={drill.workspaceId} />;
  else if (drill) middle = <DestinationPanel pathname={pathname} />;
  else if (projectsCollapsed)
    middle = <ScrollView contentContainerStyle={styles.rootScroll}>{navigation}</ScrollView>;
  else
    // The region shows the list's toasts (archive undo, the select-mode bar) over its bottom edge.
    middle = (
      <SidebarToastRegion active={active}>
        <SidebarWorkspaceList
          statusGroups={model.statusGroups}
          pinnedGroups={model.pinnedGroups}
          projects={model.projects}
          workspaceEntriesByKey={model.workspaceEntriesByKey}
          collapsedProjectKeys={model.collapsedProjectKeys}
          onToggleProjectCollapsed={model.toggleProjectCollapsed}
          shortcutIndexByWorkspaceKey={model.shortcutModel.shortcutIndexByWorkspaceKey}
          groupMode="project"
          onAddProject={addProject}
          onWorkspacePress={resetDrill}
          navigationHeaderComponent={navigation}
        />
        <SidebarSelectionHost active={active} workspaceEntriesByKey={model.workspaceEntriesByKey} />
      </SidebarToastRegion>
    );
  const dismissPluginView = useCallback(() => setDismissedPath(null), []);
  if (!drill) middle = <SidebarViewSlot dismiss={dismissPluginView}>{middle}</SidebarViewSlot>;
  const compact = useIsCompactFormFactor();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const division = resolveDesktopDivisionLayout({
    geometry: useWindowLayout(),
    windowWidth: width,
    windowHeight: height,
    leftInset: insets.left,
    rightInset: insets.right,
  });
  const sidebarStyle = useMemo(
    () => [
      styles.sidebar,
      !active && !compact && styles.hiddenSidebar,
      division && !compact && { width: division.sidebarWidth },
      compact && styles.compactSidebar,
      compact && { paddingTop: insets.top, paddingBottom: insets.bottom },
    ],
    [active, compact, division, insets.top, insets.bottom],
  );
  return (
    <RetainedPanelActivity active={active}>
      <View style={sidebarStyle} pointerEvents={active ? "auto" : "none"} testID="gumloop-sidebar">
        <View style={styles.header} testID="gumloop-sidebar-header">
          <BrandRow />
          {drill ? (
            <View style={styles.drillRow}>
              <Pressable
                style={styles.iconButton}
                onPress={back}
                accessibilityRole="button"
                accessibilityLabel="Back to sidebar"
                testID="gumloop-drill-back"
              >
                <ThemedArrowLeft size={18} uniProps={foreground} />
              </Pressable>
              <Text style={styles.label} numberOfLines={1}>
                {title}
              </Text>
              <DrillQuickSwitch drill={drill} onSelect={resetDrill} />
            </View>
          ) : (
            <HostRow serverId={serverId} />
          )}
          <Pressable
            style={styles.newAgent}
            onPress={newAgent}
            accessibilityRole="button"
            testID="sidebar-global-new-workspace"
          >
            <ThemedPlus size={16} uniProps={foreground} />
            <Text style={styles.newAgentLabel}>New agent</Text>
          </Pressable>
        </View>
        <View style={styles.middle} onLayout={onMiddleLayout} testID="gumloop-sidebar-middle">
          {middle}
        </View>
        <ConnectionFooter serverId={serverId} onNavigate={resetDrill} />
      </View>
    </RetainedPanelActivity>
  );
}

function DrillQuickSwitch({
  drill,
  onSelect,
}: {
  drill: NonNullable<ReturnType<typeof resolveSidebarDrillIn>>;
  onSelect: () => void;
}) {
  const model = useSidebarModel();
  const destinations = useAppNavItems();
  const options = useMemo(() => {
    if (drill.kind === "workspace") {
      return [...model.workspaceEntriesByKey.values()].map((workspace) => ({
        id: workspace.workspaceKey,
        label: workspace.name,
        action: () => {
          onSelect();
          navigateToWorkspace({ serverId: workspace.serverId, workspaceId: workspace.workspaceId });
        },
      }));
    }
    if (drill.kind === "settings") {
      return (["general", "hosts", "appearance", "sidebar", "chat", "diagnostics"] as const).map(
        (section) => ({
          id: section,
          label:
            section === "chat"
              ? "Chat & panes"
              : section.charAt(0).toUpperCase() + section.slice(1),
          action: () => {
            onSelect();
            router.push(buildSettingsSectionRoute(section));
          },
        }),
      );
    }
    return destinations
      .filter((item) => !PRIMARY_KEYS.has(item.key) && item.group !== "main" && item.key !== "bots")
      .map((item) => ({
        id: item.key,
        label: item.label,
        action: () => {
          onSelect();
          if (item.onPress) item.onPress();
          else router.push(item.route);
        },
      }));
  }, [destinations, drill.kind, model.workspaceEntriesByKey, onSelect]);
  return (
    <View style={styles.quickSwitch}>
      <DropdownMenu>
        <DropdownMenuTrigger
          style={styles.iconButton}
          accessibilityLabel="Switch item"
          testID="gumloop-drill-switcher"
        >
          <ThemedArrowDownUp size={18} uniProps={foreground} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" width={280}>
          {options.map((option) => (
            <DropdownMenuItem key={option.id} onSelect={option.action}>
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  hiddenSidebar: { display: "none" },
  compactSidebar: { width: "100%", flex: 1 },
  sidebar: {
    width: 324,
    flexShrink: 0,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceSidebar,
  },
  header: { paddingHorizontal: 10, paddingBottom: 12 },
  brand: { height: 60, flexDirection: "row", alignItems: "center", gap: 6 },
  logo: {
    width: 26,
    height: 26,
    borderRadius: 8,
    backgroundColor: theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  logoLetter: { fontSize: 18, fontWeight: "600", color: theme.colors.primaryForeground },
  brandName: { flex: 1, fontSize: 20, fontWeight: "600", color: theme.colors.foreground },
  iconButton: {
    width: { xs: 44, md: 30 },
    height: { xs: 44, md: 34 },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  hostRow: {
    height: { xs: 44, md: 36 },
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
  },
  // Sidebar labels (host row, account row, drill-in title) are 14/500 like the nav (spec 38 §4.2).
  label: { flex: 1, fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  newAgent: {
    height: { xs: 44, md: 34 },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 10,
  },
  newAgentLabel: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  middle: { flex: 1, minHeight: 0, overflow: "hidden" },
  rootScroll: { paddingHorizontal: 8, paddingBottom: 16 },
  drillContent: { paddingHorizontal: 10, paddingBottom: 16 },
  navigation: { paddingHorizontal: 2 },
  // 32 px rows on a 34 px pitch (spec 38 §4.2).
  navItems: { gap: 2 },
  // Tools sits right under the main nav behind a 1 px rule with 8 px either side (spec 38 §4.2).
  divider: { height: 1, marginVertical: 8, backgroundColor: theme.colors.border },
  projectsHeading: { marginTop: 16 },
  botsSection: { marginTop: 16 },
  groupHeading: {
    height: { xs: 44, md: 32 },
    flexDirection: "row",
    alignItems: "center",
  },
  groupToggle: {
    flex: 1,
    height: { xs: 44, md: 32 },
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
  },
  groupLabel: {
    flex: 1,
    fontSize: 12,
    fontWeight: "600",
    color: theme.colors.foregroundMuted,
  },
  footer: {
    paddingHorizontal: 10,
    paddingTop: 12,
    paddingBottom: 8,
    flexShrink: 0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // The Usage row sits on the bordered Connection card, so it gets the same 12 px below as the
  // footer's top padding gives it above; flush against the card, the card's border read as
  // cutting the row off (user 2026-11-27).
  usage: { marginBottom: 12 },
  connection: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 12,
    gap: 6,
  },
  connectionHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  connectionTitle: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  muted: { fontSize: 13, color: theme.colors.foregroundMuted },
  account: { minHeight: 40, flexDirection: "row", alignItems: "center", marginTop: 6 },
  accountHost: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarLetter: { fontSize: 14, color: theme.colors.foreground },
  drillRow: { height: { xs: 44, md: 36 }, flexDirection: "row", alignItems: "center", gap: 6 },
  quickSwitch: { width: 36, overflow: "hidden" },
  panelHint: { padding: 16, fontSize: 14, color: theme.colors.foregroundMuted },
}));
