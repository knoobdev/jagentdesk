import { router } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChevronDown, PanelLeft, Search } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { HostPicker } from "@/components/hosts/host-picker";
import { SidebarHelpMenu } from "@/components/sidebar/sidebar-help-menu";
import { Shortcut } from "@/components/ui/shortcut";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useHosts } from "@/runtime/host-runtime";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { usePanelStore } from "@/stores/panel-store";
import type { Theme } from "@/styles/theme";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import { buildSettingsAddHostRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";

export const CLICKUP_TOP_BAR_HEIGHT = 45;
const SEARCH_WIDTH = 380;

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedSearch = withUnistyles(Search);
const ThemedPanelLeft = withUnistyles(PanelLeft);
const mutedIconMapping = (theme: Theme) => ({
  color: theme.chrome.searchForeground,
});
const strongIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

/** ClickUp's workspace switcher chip, here the host switcher: initial avatar, name, chevron. */
function HostSwitcher() {
  const hosts = useHosts();
  const anchorRef = useRef<View | null>(null);
  const [open, setOpen] = useState(false);
  const first = hosts[0];
  const label = first ? first.label : "No host";
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const handleOpen = useCallback(() => setOpen(true), []);
  const handleSelect = useCallback((serverId: string) => {
    router.push(buildSettingsHostSectionRoute(serverId, "connections"));
  }, []);
  const handleAddHost = useCallback(() => router.push(buildSettingsAddHostRoute(Date.now())), []);
  return (
    <HostPicker
      hosts={hosts}
      value=""
      onSelect={handleSelect}
      open={open}
      onOpenChange={setOpen}
      anchorRef={anchorRef}
      includeAddHost
      onAddHost={handleAddHost}
      showActiveConnection
      searchable
      desktopPlacement="bottom-start"
      desktopMinWidth={260}
    >
      <Pressable
        ref={anchorRef}
        onPress={handleOpen}
        style={styles.switcher}
        accessibilityRole="button"
        accessibilityLabel={label}
        testID="clickup-host-switcher"
      >
        {({ hovered }) => (
          <>
            {hovered ? <View style={styles.switcherHover} /> : null}
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initial}</Text>
            </View>
            <Text style={styles.switcherLabel} numberOfLines={1}>
              {label}
            </Text>
            {hosts.length > 1 ? (
              <Text style={styles.switcherCount}>+{hosts.length - 1}</Text>
            ) : null}
            <ThemedChevronDown size={14} uniProps={mutedIconMapping} />
          </>
        )}
      </Pressable>
    </HostPicker>
  );
}

/** The centered search pill; it opens the command center, as ClickUp's opens its search. */
function SearchPill() {
  const { t } = useTranslation();
  const keys = useShortcutKeys("toggle-command-center");
  const openCommandCenter = useCallback(() => {
    useKeyboardShortcutsStore.getState().setCommandCenterOpen(true);
  }, []);
  return (
    <Pressable
      onPress={openCommandCenter}
      style={styles.search}
      accessibilityRole="search"
      testID="clickup-search"
    >
      <ThemedSearch size={15} uniProps={mutedIconMapping} />
      <Text style={styles.searchText}>{t("clickupShell.search")}</Text>
      {keys ? <Shortcut chord={keys} /> : null}
    </Pressable>
  );
}

function SidebarToggle() {
  const toggle = usePanelStore((state) => state.toggleAgentListForLayout);
  const handlePress = useCallback(() => toggle({ isCompact: false }), [toggle]);
  return (
    <Pressable
      onPress={handlePress}
      style={styles.iconButton}
      accessibilityRole="button"
      testID="clickup-sidebar-toggle"
    >
      {({ hovered }) => (
        <ThemedPanelLeft size={16} uniProps={hovered ? strongIconMapping : mutedIconMapping} />
      )}
    </Pressable>
  );
}

/**
 * ClickUp's global top bar: host switcher on the left, search in the middle, help on the right.
 * It owns both top window corners, so it clears the macOS traffic lights and doubles as the
 * window drag region.
 */
export function ClickUpTopBar() {
  return (
    <View style={styles.bar} testID="clickup-top-bar">
      <TitlebarDragRegion />
      <WindowChromeSafeArea placement="inline" horizontalPadding={8} style={styles.inner}>
        <View style={styles.side}>
          <SidebarToggle />
          <HostSwitcher />
        </View>
        <View style={styles.center} pointerEvents="box-none">
          <SearchPill />
        </View>
        <View style={[styles.side, styles.sideRight]}>
          <SidebarHelpMenu />
        </View>
      </WindowChromeSafeArea>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => {
  return {
    bar: {
      height: CLICKUP_TOP_BAR_HEIGHT,
      position: "relative",
      backgroundColor: theme.chrome.topBar,
    },
    inner: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
    },
    side: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      minWidth: 0,
    },
    sideRight: { justifyContent: "flex-end" },
    center: {
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
    },
    switcher: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[2],
      height: 30,
      borderRadius: theme.borderRadius.md,
      maxWidth: 260,
    },
    switcherHover: {
      position: "absolute",
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface3,
    },
    avatar: {
      width: 20,
      height: 20,
      borderRadius: theme.borderRadius.base,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.chrome.createBackground,
    },
    avatarText: {
      fontSize: 11,
      fontWeight: theme.fontWeight.bold,
      color: theme.chrome.createForeground,
    },
    switcherLabel: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      flexShrink: 1,
    },
    switcherCount: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
    search: {
      width: SEARCH_WIDTH,
      height: 30,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      borderRadius: theme.borderRadius.full,
      borderWidth: 1,
      backgroundColor: theme.chrome.searchBackground,
      borderColor: theme.chrome.searchBorder,
    },
    searchText: {
      flex: 1,
      fontSize: theme.fontSize.sm,
      color: theme.chrome.searchForeground,
    },
    iconButton: {
      width: 30,
      height: 30,
      borderRadius: theme.borderRadius.md,
      alignItems: "center",
      justifyContent: "center",
    },
  };
});
