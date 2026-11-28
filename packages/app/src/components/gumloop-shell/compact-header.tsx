import {
  settingsPresentation,
  getSettingsSidebarReturn,
} from "@/navigation/settings-presentation/session";
import {
  useWindowLayout,
  resolveWorkspaceActionPlacement,
  WindowLayoutActions,
} from "@/window-layout";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { useCallback, useMemo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { router, usePathname, type Href } from "expo-router";
import { PortalHost } from "@gorhom/portal";
import { Menu, PanelRight, Plus, Settings } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppNavItems, useNewWorkspaceNavigate } from "@/components/sidebar/use-app-nav";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import {
  buildSettingsSectionRoute,
  isHostNotificationsPathname,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import { formatCompactWorkspaceTitle } from "@/screens/workspace/workspace-header-source";
import { useIsGumloopTheme } from "./use-gumloop-chrome";
import { useCompactPageAction, type CompactPageAction } from "./compact-page-action";
import { GUMLOOP_COMPACT_ACTIONS_HOST } from "./sidebar-state";
import type { Theme } from "@/styles/theme";
import {
  PhoneBotsHeaderAction,
  PhoneBotsHeaderTitle,
  useBotsRouteTarget,
} from "@/bots/phone/header";

const ThemedMenu = withUnistyles(Menu);
const ThemedPanelRight = withUnistyles(PanelRight);
const ThemedPlus = withUnistyles(Plus);
const ThemedSettings = withUnistyles(Settings);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const NO_KEYS: [] = [];

// In a workspace the title is the workspace, not the agent: the tab switcher row
// right below already names the active agent (spec 38 §5).
function resolveHeaderTitle(
  pathname: string,
  workspace: boolean,
  name: string | undefined,
  active: string | undefined,
  t: import("i18next").TFunction,
): string {
  if (workspace) return name ?? t("workspace.header.title");
  if (pathname.includes("/settings")) return t("sidebar.actions.settings");
  if (isHostNotificationsPathname(pathname)) return t("notificationFeed.title");
  return active ?? t("sidebar.actions.home");
}

export function GumloopCompactHeader({ enabled }: { enabled: boolean }) {
  const compact = useIsCompactFormFactor();
  const layout = useWindowLayout();
  const verticalActions = resolveWorkspaceActionPlacement(layout) === "vertical-bar";
  const gumloop = useIsGumloopTheme();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const route = parseHostWorkspaceRouteFromPathname(pathname);
  // A bot's page names the bot and opens its panel (spec 37.6).
  const botsRoute = useBotsRouteTarget();
  const workspace = useWorkspace(route?.serverId ?? null, route?.workspaceId ?? null);
  const nav = useAppNavItems();
  const active = nav.find((item) => item.isActive);
  const title = resolveHeaderTitle(
    pathname,
    route !== null,
    workspace ? formatCompactWorkspaceTitle(workspace) : undefined,
    active?.label,
    t,
  );
  const toggleDrawer = usePanelStore((state) => state.toggleMobileAgentList);
  const openDrawer = useCallback(() => {
    if (pathname.startsWith("/settings") && getSettingsSidebarReturn()) {
      settingsPresentation.clearSidebarReturn();
      usePanelStore.getState().showMobileAgentList();
      return;
    }
    toggleDrawer();
  }, [pathname, toggleDrawer]);
  const toggleExplorer = usePanelStore((state) => state.toggleFileExplorerForCheckout);
  const newAgent = useNewWorkspaceNavigate();
  const inspect = useCallback(() => {
    if (!route || !workspace?.workspaceDirectory) return;
    toggleExplorer({
      isCompact: true,
      checkout: { serverId: route.serverId, cwd: workspace.workspaceDirectory, isGit: true },
    });
  }, [route, workspace?.workspaceDirectory, toggleExplorer]);
  const rootStyle = useMemo(() => [styles.root, { paddingTop: insets.top }], [insets.top]);
  // The Notifications page carries its settings gear here (spec 14 §8.5).
  const notificationsPage = isHostNotificationsPathname(pathname);
  const openNotificationSettings = useCallback(() => {
    router.push(buildSettingsSectionRoute("notifications") as Href);
  }, []);
  const settingsGear = (
    <HeaderToggleButton
      onPress={openNotificationSettings}
      tooltipLabel={t("notificationFeed.settings")}
      tooltipKeys={NO_KEYS}
      tooltipSide="bottom"
      accessibilityLabel={t("notificationFeed.settings")}
      testID="notification-feed-settings"
      style={styles.button}
    >
      <ThemedSettings size={22} uniProps={foreground} />
    </HeaderToggleButton>
  );
  const defaultAction = (
    <HeaderToggleButton
      onPress={route ? inspect : newAgent}
      tooltipLabel={
        route ? t("workspace.tabs.explorerSidebar.toggle") : t("sidebar.actions.newWorkspace")
      }
      tooltipKeys={NO_KEYS}
      tooltipSide="bottom"
      accessibilityLabel={
        route ? t("workspace.tabs.explorerSidebar.toggle") : t("sidebar.actions.newWorkspace")
      }
      testID={route ? "compact-inspector-toggle" : "compact-new-agent"}
      style={styles.button}
    >
      {route ? (
        <ThemedPanelRight size={22} uniProps={foreground} />
      ) : (
        <ThemedPlus size={22} uniProps={foreground} />
      )}
    </HeaderToggleButton>
  );
  let action = <PageActionOrDefault pathname={pathname}>{defaultAction}</PageActionOrDefault>;
  if (pathname.includes("/settings")) action = <View style={styles.button} />;
  else if (notificationsPage) action = settingsGear;
  if (!enabled || !compact || !gumloop) return null;
  return (
    <View style={rootStyle} testID="gumloop-compact-header">
      <WindowChromeSafeArea placement="inline" horizontalPadding={6} style={styles.row}>
        <HeaderToggleButton
          onPress={openDrawer}
          tooltipLabel={t("shell.menu.open")}
          tooltipKeys={NO_KEYS}
          tooltipSide="bottom"
          accessibilityLabel={t("shell.menu.open")}
          testID="menu-button"
          style={styles.button}
        >
          <ThemedMenu size={22} uniProps={foreground} />
        </HeaderToggleButton>
        <PhoneBotsHeaderTitle target={botsRoute}>
          <Text style={styles.title} numberOfLines={1} testID="compact-header-title">
            {title}
          </Text>
        </PhoneBotsHeaderTitle>
        {route ? <PortalHost name={GUMLOOP_COMPACT_ACTIONS_HOST} /> : null}
        {verticalActions ? (
          <View style={styles.button} />
        ) : (
          <PhoneBotsHeaderAction target={botsRoute} buttonStyle={styles.button}>
            {action}
          </PhoneBotsHeaderAction>
        )}
      </WindowChromeSafeArea>
      <WindowLayoutActions active={enabled}>
        <PhoneBotsHeaderAction target={botsRoute} buttonStyle={styles.button}>
          {action}
        </PhoneBotsHeaderAction>
      </WindowLayoutActions>
    </View>
  );
}
/** A page's own primary action ("Add memory") replaces the generic "+" (spec 38 §5). */
function PageActionOrDefault({ pathname, children }: { pathname: string; children: ReactNode }) {
  const pageAction = useCompactPageAction(pathname);
  return pageAction ? <PageActionButton action={pageAction} /> : children;
}

function PageActionButton({ action }: { action: CompactPageAction }) {
  const Icon = action.icon;
  const ThemedIcon = useMemo(() => withUnistyles(Icon), [Icon]);
  return (
    <HeaderToggleButton
      onPress={action.onPress}
      disabled={action.disabled}
      tooltipLabel={action.label}
      tooltipKeys={NO_KEYS}
      tooltipSide="bottom"
      accessibilityLabel={action.label}
      testID={action.testID}
      style={styles.button}
    >
      <ThemedIcon size={22} uniProps={action.disabled ? muted : foreground} />
    </HeaderToggleButton>
  );
}

const styles = StyleSheet.create((theme: Theme) => ({
  root: {
    backgroundColor: theme.colors.surface0,
  },
  row: { height: 56, flexDirection: "row", alignItems: "center", gap: 6 },
  button: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: {
    flex: 1,
    textAlign: "left",
    fontSize: 17,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
}));
