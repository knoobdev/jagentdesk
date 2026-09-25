import { router, usePathname } from "expo-router";
import { memo, useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { Settings, Smartphone, type LucideIcon } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppNavItems, type AppNavItem } from "@/components/sidebar/use-app-nav";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { resolvePluginIcon, usePluginSidebarGroups, usePluginSidebarNavigation } from "@/plugins";
import type { PluginSidebarGroup } from "@/plugins/sidebar-groups";
import { usePairDeviceModalStore } from "@/stores/pair-device-modal-store";
import type { Theme } from "@/styles/theme";
import { buildSettingsRoute } from "@/utils/host-routes";
import { GradientFill } from "./gradient-fill";

export const CLICKUP_RAIL_WIDTH = 64;
const RAIL_RADIUS = 10;
const RAIL_ICON_BOX = 32;
const RAIL_ICON_SIZE = 17;

const ThemedGradientFill = withUnistyles(GradientFill);
const railGradientMapping = (theme: Theme) => ({
  colors: theme.chrome.railGradient.join(","),
});
const railIconMapping = (theme: Theme) => ({ color: theme.chrome.railForeground });
const railIconActiveMapping = (theme: Theme) => ({
  color: theme.chrome.railActiveForeground,
});

interface RailButtonProps {
  icon: LucideIcon;
  label: string;
  shortLabel: string;
  isActive: boolean;
  onPress: () => void;
  testID: string;
}

/** One rail destination: an icon in a rounded box with a short label under it, as in ClickUp. */
const RailButton = memo(function RailButton({
  icon,
  label,
  shortLabel,
  isActive,
  onPress,
  testID,
}: RailButtonProps) {
  const ThemedIcon = useMemo(() => withUnistyles(icon), [icon]);
  const accessibilityState = useMemo(() => ({ selected: isActive }), [isActive]);
  const renderContent = useCallback(
    ({ hovered }: PressableStateCallbackType & { hovered?: boolean }) => {
      let boxStyle = styles.iconBox;
      if (isActive) boxStyle = styles.iconBoxActive;
      else if (hovered) boxStyle = styles.iconBoxHovered;
      let labelStyle: object = styles.label;
      if (isActive) labelStyle = styles.labelActive;
      else if (hovered) labelStyle = styles.labelHovered;
      return (
        <>
          <View style={boxStyle}>
            <ThemedIcon
              size={RAIL_ICON_SIZE}
              strokeWidth={isActive ? 2.25 : 1.9}
              uniProps={isActive ? railIconActiveMapping : railIconMapping}
            />
          </View>
          <Text numberOfLines={1} style={labelStyle}>
            {shortLabel}
          </Text>
        </>
      );
    },
    [ThemedIcon, isActive, shortLabel],
  );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>
        <Pressable
          onPress={onPress}
          style={styles.button}
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={accessibilityState}
          testID={testID}
        >
          {renderContent}
        </Pressable>
      </TooltipTrigger>
      <TooltipContent side="right" align="center" offset={6}>
        <Text style={styles.tooltipText}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
});

function RailNavItem({ item }: { item: AppNavItem }) {
  const handlePress = useCallback(() => router.push(item.route), [item.route]);
  return (
    <RailButton
      icon={item.icon}
      label={item.label}
      shortLabel={item.shortLabel}
      isActive={item.isActive}
      onPress={handlePress}
      testID={item.testID}
    />
  );
}

function RailPluginItem({ group }: { group: PluginSidebarGroup }) {
  const { navigate, isActive } = usePluginSidebarNavigation(group);
  return (
    <RailButton
      icon={resolvePluginIcon(group.icon)}
      label={group.title}
      shortLabel={group.title.split(/\s+/)[0] ?? group.title}
      isActive={isActive}
      onPress={navigate}
      testID={`rail-plugin-${group.pluginId}-${group.contributionId}`}
    />
  );
}

/**
 * ClickUp's vertical icon rail: the app's primary destinations and plugin sidebar entries on a
 * rounded rail (violet gradient in light, #191919 in dark), pair-device and settings pinned at the
 * bottom. It stays visible when the workspace sidebar is collapsed.
 */
export function ClickUpRail() {
  const { t } = useTranslation();
  const items = useAppNavItems();
  const pluginGroups = usePluginSidebarGroups();
  const localServerId = useLocalDaemonServerId();
  const openPairDeviceModal = usePairDeviceModalStore((state) => state.open);
  const handlePairDevice = useCallback(() => {
    if (localServerId) openPairDeviceModal(localServerId);
  }, [localServerId, openPairDeviceModal]);
  const handleSettings = useCallback(() => router.push(buildSettingsRoute()), []);
  const isSettingsActive = usePathname().startsWith("/settings");

  return (
    <View style={styles.rail} testID="clickup-rail">
      <ThemedGradientFill radius={RAIL_RADIUS} uniProps={railGradientMapping} />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {items.map((item) => (
          <RailNavItem key={item.key} item={item} />
        ))}
        {pluginGroups.map((group) => (
          <RailPluginItem key={group.key} group={group} />
        ))}
      </ScrollView>
      <View style={styles.footer}>
        {localServerId ? (
          <RailButton
            icon={Smartphone}
            label={t("openProject.tiles.pairDevice.title")}
            shortLabel="Pair"
            isActive={false}
            onPress={handlePairDevice}
            testID="rail-pair-device"
          />
        ) : null}
        <RailButton
          icon={Settings}
          label={t("sidebar.actions.settings")}
          shortLabel={t("sidebar.actions.settings")}
          isActive={isSettingsActive}
          onPress={handleSettings}
          testID="rail-settings"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme: Theme) => {
  const iconBoxBase = {
    width: RAIL_ICON_BOX,
    height: RAIL_ICON_BOX,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  } as const;
  const labelBase = {
    fontSize: 10,
    lineHeight: 12,
    maxWidth: CLICKUP_RAIL_WIDTH - 8,
  } as const;
  return {
    rail: {
      width: CLICKUP_RAIL_WIDTH,
      marginLeft: theme.spacing[2],
      marginBottom: theme.spacing[2],
      borderRadius: RAIL_RADIUS,
      overflow: "hidden",
    },
    scroll: { flex: 1 },
    scrollContent: {
      alignItems: "center",
      paddingTop: theme.spacing[2],
      paddingBottom: theme.spacing[2],
      gap: theme.spacing[1],
    },
    footer: {
      alignItems: "center",
      paddingTop: theme.spacing[1],
      paddingBottom: theme.spacing[2],
      gap: theme.spacing[1],
    },
    button: {
      width: CLICKUP_RAIL_WIDTH - 8,
      alignItems: "center",
      gap: 3,
      paddingVertical: 3,
    },
    iconBox: iconBoxBase,
    iconBoxHovered: { ...iconBoxBase, backgroundColor: "rgba(255, 255, 255, 0.14)" },
    iconBoxActive: {
      ...iconBoxBase,
      backgroundColor: theme.chrome.railActiveBackground,
    },
    label: {
      ...labelBase,
      color: theme.chrome.railForegroundMuted,
      fontWeight: theme.fontWeight.medium,
    },
    labelHovered: {
      ...labelBase,
      color: theme.chrome.railForeground,
      fontWeight: theme.fontWeight.medium,
    },
    labelActive: {
      ...labelBase,
      color: theme.chrome.railForeground,
      fontWeight: theme.fontWeight.semibold,
    },
    tooltipText: { fontSize: theme.fontSize.sm, color: theme.colors.popoverForeground },
  };
});
