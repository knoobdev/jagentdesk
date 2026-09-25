import { router, usePathname } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { History, Home, LayoutList, Plus, Settings, type LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useNewWorkspaceNavigate } from "@/components/sidebar/use-app-nav";
import { useIsCompactFormFactor } from "@/constants/layout";
import { usePanelStore } from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";
import {
  buildOpenProjectRoute,
  buildSessionsRoute,
  buildSettingsRoute,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import { useIsClickUpTheme } from "./use-clickup-chrome";

const TAB_BAR_HEIGHT = 56;
const ICON_SIZE = 22;

const activeIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const idleIconMapping = (theme: Theme) => ({ color: theme.chrome.tabIdle });
const createIconMapping = (theme: Theme) => ({ color: theme.chrome.tabCreateForeground });

interface TabProps {
  icon: LucideIcon;
  label: string;
  isActive: boolean;
  onPress: () => void;
  testID: string;
}

const Tab = memo(function Tab({ icon, label, isActive, onPress, testID }: TabProps) {
  const ThemedIcon = useMemo(() => withUnistyles(icon), [icon]);
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  return (
    <Pressable
      onPress={onPress}
      style={styles.tab}
      accessibilityRole="tab"
      accessibilityLabel={label}
      accessibilityState={accessibilityState}
      testID={testID}
    >
      <ThemedIcon
        size={ICON_SIZE}
        strokeWidth={isActive ? 2.2 : 1.8}
        uniProps={isActive ? activeIconMapping : idleIconMapping}
      />
      <Text style={isActive ? styles.labelActive : styles.label} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
});

/**
 * ClickUp's iOS tab bar: four destinations around a violet "Create" square. It shows on list
 * screens and hides inside a workspace, where the composer owns the bottom edge.
 */
export function ClickUpMobileTabBar({ chromeEnabled }: { chromeEnabled: boolean }) {
  const { t } = useTranslation();
  const isClickUp = useIsClickUpTheme();
  const isCompact = useIsCompactFormFactor();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const toggleMobileAgentList = usePanelStore((state) => state.toggleMobileAgentList);
  const handleCreate = useNewWorkspaceNavigate();
  const handleHome = useCallback(() => router.push(buildOpenProjectRoute()), []);
  const handleHistory = useCallback(() => router.push(buildSessionsRoute()), []);
  const handleSettings = useCallback(() => router.push(buildSettingsRoute()), []);
  const barStyle = useMemo(
    () => [styles.bar, { paddingBottom: Math.max(insets.bottom, 6) }],
    [insets.bottom],
  );

  const isWorkspaceRoute = parseHostWorkspaceRouteFromPathname(pathname) !== null;
  if (!isClickUp || !isCompact || !chromeEnabled || isWorkspaceRoute) return null;

  return (
    <View style={barStyle} accessibilityRole="tablist" testID="clickup-mobile-tab-bar">
      <Tab
        icon={Home}
        label={t("sidebar.actions.home")}
        isActive={pathname === "/open-project"}
        onPress={handleHome}
        testID="clickup-tab-home"
      />
      <Tab
        icon={LayoutList}
        label={t("clickupShell.workspaces")}
        isActive={false}
        onPress={toggleMobileAgentList}
        testID="clickup-tab-workspaces"
      />
      <Pressable
        onPress={handleCreate}
        style={styles.tab}
        accessibilityRole="button"
        accessibilityLabel={t("sidebar.actions.newWorkspace")}
        testID="clickup-tab-create"
      >
        <View style={styles.createSquare}>
          <CreatePlus />
        </View>
        <Text style={styles.label}>{t("clickupShell.newWorkspace")}</Text>
      </Pressable>
      <Tab
        icon={History}
        label={t("sidebar.sections.sessions")}
        isActive={pathname.includes("/sessions") && !pathname.includes("/shared-sessions")}
        onPress={handleHistory}
        testID="clickup-tab-history"
      />
      <Tab
        icon={Settings}
        label={t("sidebar.actions.settings")}
        isActive={pathname.startsWith("/settings")}
        onPress={handleSettings}
        testID="clickup-tab-settings"
      />
    </View>
  );
}

const ThemedPlus = withUnistyles(Plus);
function CreatePlus() {
  return <ThemedPlus size={18} strokeWidth={2.6} uniProps={createIconMapping} />;
}

const styles = StyleSheet.create((theme: Theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "flex-start",
    minHeight: TAB_BAR_HEIGHT,
    paddingTop: 6,
    backgroundColor: theme.chrome.tabBar,
    borderTopWidth: 1,
    borderTopColor: theme.chrome.tabBarBorder,
  },
  tab: {
    flex: 1,
    alignItems: "center",
    gap: 3,
    paddingVertical: 2,
  },
  createSquare: {
    width: 26,
    height: 26,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.chrome.tabCreateBackground,
  },
  label: {
    fontSize: 11,
    color: theme.chrome.tabIdle,
  },
  labelActive: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
}));
