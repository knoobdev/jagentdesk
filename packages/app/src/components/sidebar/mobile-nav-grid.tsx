import { router, type Href } from "expo-router";
import { memo, useCallback, useMemo, type MutableRefObject } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type PressableStateCallbackType,
} from "react-native";
import type { GestureType } from "react-native-gesture-handler";
import { NestableScrollContainer } from "react-native-draggable-flatlist";
import { ChevronDown, ChevronUp, type LucideIcon } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAppNavItems, type AppNavItem } from "@/components/sidebar/use-app-nav";
import { useMobileNavGridStore } from "@/stores/mobile-nav-grid-store";
import { isNative as platformIsNative } from "@/constants/platform";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import type { Theme } from "@/styles/theme";

/** Menu tiles per row. Five columns fit every item (17–20) in four rows, about a third of the drawer. */
const GRID_COLUMNS = 5;
const TILE_MIN_HEIGHT = 52;
const TILE_ICON_SIZE = 20;
const MENU_TOGGLE_ROW_HEIGHT = 36;

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** A grid tile: one nav destination, its icon over its short label. */
export interface MobileNavTile {
  key: string;
  icon: LucideIcon;
  label: string;
  shortLabel: string;
  route: Href;
  isActive: boolean;
  testID: string;
}

/**
 * The drawer rows predate the grid and their `sidebar-*` testIDs are load-bearing for the
 * mobile e2e suites, so tiles keep those IDs instead of the rail's `rail-*` ones. Keys that
 * did not exist when the grid landed (Figma, later sections) fall back to the rail testID.
 */
const LEGACY_ROW_TEST_IDS: Readonly<Record<string, string>> = {
  sessions: "sidebar-sessions",
  schedules: "sidebar-schedules",
  "shared-sessions": "sidebar-shared-sessions",
  team: "sidebar-agent-forum",
  clusters: "sidebar-clusters-nav",
  databases: "sidebar-databases-nav",
  servers: "sidebar-servers-nav",
  argocd: "sidebar-argocd-nav",
  jira: "sidebar-jira-nav",
  skills: "sidebar-skills-nav",
  marketplace: "sidebar-marketplace-nav",
  docker: "sidebar-docker-nav",
  simulators: "sidebar-simulator-nav",
  workbench: "sidebar-workbench-nav",
  usage: "sidebar-insights-nav",
  forge: "sidebar-forge-nav",
};

export function mobileNavTileTestID(key: string, railTestID: string): string {
  return LEGACY_ROW_TEST_IDS[key] ?? railTestID;
}

/** The rail's nav items as grid tiles: same order, same active flags, drawer testIDs. */
export function buildMobileNavTiles(items: AppNavItem[]): MobileNavTile[] {
  return items.map((item) => ({
    key: item.key,
    icon: item.icon,
    label: item.label,
    shortLabel: item.shortLabel,
    route: item.route,
    isActive: item.isActive,
    testID: mobileNavTileTestID(item.key, item.testID),
  }));
}

const NavGridTile = memo(function NavGridTile({
  tile,
  onOpen,
}: {
  tile: MobileNavTile;
  onOpen: (tile: MobileNavTile) => void;
}) {
  const ThemedIcon = useMemo(() => withUnistyles(tile.icon), [tile.icon]);
  const accessibilityState = useMemo(() => ({ selected: tile.isActive }), [tile.isActive]);
  const handlePress = useCallback(() => onOpen(tile), [onOpen, tile]);
  const tileStyle = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.tile,
      (Boolean(hovered) || tile.isActive) && styles.tileHighlighted,
    ],
    [tile.isActive],
  );
  const renderContent = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      const isHighlighted = Boolean(hovered) || tile.isActive;
      return (
        <>
          <ThemedIcon
            size={TILE_ICON_SIZE}
            strokeWidth={tile.isActive ? 2.25 : 1.9}
            uniProps={isHighlighted ? foregroundColorMapping : foregroundMutedColorMapping}
          />
          <Text
            numberOfLines={1}
            style={[styles.tileLabel, isHighlighted && styles.tileLabelHighlighted]}
          >
            {tile.shortLabel}
          </Text>
        </>
      );
    },
    [ThemedIcon, tile.isActive, tile.shortLabel],
  );

  return (
    <Pressable
      onPress={handlePress}
      style={tileStyle}
      accessible
      accessibilityRole="button"
      accessibilityLabel={tile.label}
      accessibilityState={accessibilityState}
      testID={tile.testID}
    >
      {renderContent}
    </Pressable>
  );
});

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronUp = withUnistyles(ChevronUp);

/**
 * The phone drawer's menu, condensed to a 4-column icon grid so the workspace list below
 * keeps most of the screen. Items come from the same `useAppNavItems()` source as the
 * desktop rail, so a new destination shows up here without touching this file.
 */
export function MobileNavGrid({
  onBeforeNavigate,
  parentGestureRef,
}: {
  onBeforeNavigate?: () => void;
  /** Drawer close pan; the grid's own scroll stays simultaneous with it, as the workspace list does. */
  parentGestureRef?: MutableRefObject<GestureType | undefined>;
}) {
  const collapsed = useMobileNavGridStore((state) => state.collapsed);
  const toggleCollapsed = useMobileNavGridStore((state) => state.toggleCollapsed);
  const items = useAppNavItems();
  const tiles = useMemo(() => buildMobileNavTiles(items), [items]);
  const { height } = useWindowDimensions();
  // The menu section — toggle row plus tiles — claims at most a third of the drawer;
  // the workspace list owns the rest and scrolls.
  const gridMaxHeight = Math.max(Math.floor(height / 3) - MENU_TOGGLE_ROW_HEIGHT, TILE_MIN_HEIGHT);

  const handleTilePress = useCallback(
    (tile: MobileNavTile) => {
      onBeforeNavigate?.();
      router.push(tile.route);
    },
    [onBeforeNavigate],
  );

  const gridTiles = tiles.map((tile) => (
    <NavGridTile key={tile.key} tile={tile} onOpen={handleTilePress} />
  ));
  // NestableScrollContainer forwards props to the RNGH ScrollView. Keep vertical
  // scroll and the drawer close pan simultaneous (same contract as the workspace
  // list's scroll in this drawer).
  const simultaneousHandlersProps = useMemo(
    () => (parentGestureRef ? { simultaneousHandlers: parentGestureRef } : undefined),
    [parentGestureRef],
  );

  const gridStyle = useMemo(
    () => [styles.grid, inlineUnistylesStyle({ maxHeight: gridMaxHeight })],
    [gridMaxHeight],
  );
  const renderGrid = useCallback(() => {
    if (platformIsNative) {
      return (
        <NestableScrollContainer
          style={gridStyle}
          contentContainerStyle={styles.gridContent}
          {...simultaneousHandlersProps}
        >
          {gridTiles}
        </NestableScrollContainer>
      );
    }
    return (
      <ScrollView
        style={gridStyle}
        contentContainerStyle={styles.gridContent}
        showsVerticalScrollIndicator={false}
      >
        {gridTiles}
      </ScrollView>
    );
  }, [gridStyle, simultaneousHandlersProps, gridTiles]);

  const headerAccessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);

  return (
    <View testID="mobile-nav-grid">
      <Pressable
        onPress={toggleCollapsed}
        style={headerRowStyle}
        accessible
        accessibilityRole="button"
        accessibilityLabel="Menu"
        accessibilityState={headerAccessibilityState}
        testID="sidebar-menu-toggle"
      >
        {({ hovered, pressed }) => (
          <>
            <Text
              style={[
                styles.headerTitle,
                (Boolean(hovered) || pressed) && styles.headerTitleHovered,
              ]}
            >
              Menu
            </Text>
            {collapsed ? (
              <ThemedChevronDown
                size={14}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            ) : (
              <ThemedChevronUp
                size={14}
                uniProps={hovered || pressed ? foregroundColorMapping : foregroundMutedColorMapping}
              />
            )}
          </>
        )}
      </Pressable>
      {!collapsed && renderGrid()}
    </View>
  );
}

function headerRowStyle({
  hovered = false,
  pressed,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.headerRow, (Boolean(hovered) || pressed) && styles.headerRowHovered];
}

const styles = StyleSheet.create((theme) => ({
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: MENU_TOGGLE_ROW_HEIGHT,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    userSelect: "none",
  },
  headerRowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  headerTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  headerTitleHovered: {
    color: theme.colors.foreground,
  },
  grid: {
    flexGrow: 0,
  },
  gridContent: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingVertical: theme.spacing[1],
  },
  tile: {
    alignItems: "center",
    justifyContent: "center",
    gap: 3,
    minHeight: TILE_MIN_HEIGHT,
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    userSelect: "none",
    width: `${100 / GRID_COLUMNS}%`,
  },
  tileHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  tileLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    maxWidth: "100%",
    textAlign: "center",
  },
  tileLabelHighlighted: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
}));
