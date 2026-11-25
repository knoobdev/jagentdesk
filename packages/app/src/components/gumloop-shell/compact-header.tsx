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
import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { usePathname } from "expo-router";
import { Menu, PanelRight, Plus } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useAppNavItems, useNewWorkspaceNavigate } from "@/components/sidebar/use-app-nav";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { parseHostWorkspaceRouteFromPathname } from "@/utils/host-routes";
import { useIsGumloopTheme } from "./use-gumloop-chrome";
import type { Theme } from "@/styles/theme";

const ThemedMenu = withUnistyles(Menu);
const ThemedPanelRight = withUnistyles(PanelRight);
const ThemedPlus = withUnistyles(Plus);
const foreground = (theme: Theme) => ({ color: theme.colors.foreground });
const NO_KEYS: [] = [];

function selectFocusedTitle(
  state: ReturnType<typeof useSessionStore.getState>,
  serverId: string | undefined,
) {
  const session = serverId ? state.sessions[serverId] : null;
  const agent = session?.focusedAgentId ? session.agents.get(session.focusedAgentId) : null;
  return agent?.title;
}

function resolveHeaderTitle(
  pathname: string,
  workspace: boolean,
  agent: string | null | undefined,
  name: string | undefined,
  active: string | undefined,
  t: import("i18next").TFunction,
): string {
  if (workspace) return agent ?? name ?? t("workspace.header.title");
  if (pathname.includes("/settings")) return t("sidebar.actions.settings");
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
  const workspace = useWorkspace(route?.serverId ?? null, route?.workspaceId ?? null);
  const agentTitle = useSessionStore((state) => selectFocusedTitle(state, route?.serverId));
  const nav = useAppNavItems();
  const active = nav.find((item) => item.isActive);
  const title = resolveHeaderTitle(
    pathname,
    route !== null,
    agentTitle,
    workspace?.name,
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
  const action = pathname.includes("/settings") ? (
    <View style={styles.button} />
  ) : (
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
        <Text style={styles.title} numberOfLines={1} testID="compact-header-title">
          {title}
        </Text>
        {verticalActions ? <View style={styles.button} /> : action}
      </WindowChromeSafeArea>
      <WindowLayoutActions active={enabled}>{action}</WindowLayoutActions>
    </View>
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
    textAlign: "center",
    fontSize: 17,
    fontWeight: "600",
    color: theme.colors.foreground,
  },
}));
