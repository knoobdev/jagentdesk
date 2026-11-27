import { useCallback } from "react";
import { Text, View, useWindowDimensions, type PressableStateCallbackType } from "react-native";
import { Bell } from "lucide-react-native";
import { router, type Href } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHostFeature } from "@/runtime/host-features";
import type { Theme } from "@/styles/theme";
import { buildHostNotificationsRoute, buildSettingsSectionRoute } from "@/utils/host-routes";
import { feedBadgeText } from "./model";
import {
  NotificationFeedActions,
  NotificationFeedList,
  useNotificationFeedUnreadCount,
} from "./list";

const ThemedBell = withUnistyles(Bell);
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** Popover geometry (spec 14 §8.5): 400 wide, at most 70 % of the window tall. */
export const NOTIFICATION_FEED_POPOVER_WIDTH = 400;
const POPOVER_HEIGHT_RATIO = 0.7;
const POPOVER_PADDING = 16;
const POPOVER_HEADER_HEIGHT = 40;

function openNotificationSettings(): void {
  router.push(buildSettingsSectionRoute("notifications") as Href);
}

/**
 * The bell in the sidebar host row (spec 38 §4.2, ADR-0063). With the host's notification feed it
 * carries the unread badge and opens the list: a popover on desktop, the Notifications page on a
 * phone. A host without the feed keeps the old shortcut to Settings → This device → Notifications.
 */
export function NotificationsHostButton({
  serverId,
  onNavigate,
}: {
  serverId: string;
  onNavigate: () => void;
}) {
  const supported = useHostFeature(serverId, "notificationFeed");
  const compact = useIsCompactFormFactor();
  const openSettings = useCallback(() => {
    onNavigate();
    openNotificationSettings();
  }, [onNavigate]);
  const openPage = useCallback(() => {
    onNavigate();
    router.push(buildHostNotificationsRoute(serverId) as Href);
  }, [onNavigate, serverId]);
  if (!supported) return <BellButton count={0} onPress={openSettings} />;
  if (compact) return <BellWithBadge serverId={serverId} onPress={openPage} />;
  return <NotificationsPopover serverId={serverId} onNavigate={onNavigate} />;
}

function BellWithBadge({ serverId, onPress }: { serverId: string; onPress: () => void }) {
  const count = useNotificationFeedUnreadCount(serverId);
  return <BellButton count={count} onPress={onPress} />;
}

function useBellLabel(count: number): string {
  const { t } = useTranslation();
  return count > 0 ? t("notificationFeed.unread", { count }) : t("notificationFeed.title");
}

function BellButton({ count, onPress }: { count: number; onPress: () => void }) {
  const label = useBellLabel(count);
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.button,
      (hovered || pressed) && styles.buttonHovered,
    ],
    [],
  );
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        style={style}
        testID="sidebar-notifications"
      >
        <ThemedBell size={18} uniProps={muted} />
        <NotificationsBadge count={count} />
      </TooltipTrigger>
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltip}>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function NotificationsPopover({
  serverId,
  onNavigate,
}: {
  serverId: string;
  onNavigate: () => void;
}) {
  const count = useNotificationFeedUnreadCount(serverId);
  const label = useBellLabel(count);
  const { height } = useWindowDimensions();
  const maxHeight = Math.round(height * POPOVER_HEIGHT_RATIO);
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: { hovered: boolean; pressed: boolean; open: boolean }) => [
      styles.button,
      (hovered || pressed || open) && styles.buttonHovered,
    ],
    [],
  );
  return (
    <DropdownMenu>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <View style={styles.anchor}>
            <DropdownMenuTrigger
              style={triggerStyle}
              accessibilityRole="button"
              accessibilityLabel={label}
              testID="sidebar-notifications"
            >
              <ThemedBell size={18} uniProps={muted} />
              <NotificationsBadge count={count} />
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltip}>{label}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="top"
        align="start"
        width={NOTIFICATION_FEED_POPOVER_WIDTH}
        maxHeight={maxHeight}
        surfaceStyle={styles.surface}
        testID="notification-feed-popover"
      >
        <PopoverBody
          serverId={serverId}
          onNavigate={onNavigate}
          listMaxHeight={maxHeight - POPOVER_PADDING * 2 - POPOVER_HEADER_HEIGHT}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PopoverBody({
  serverId,
  onNavigate,
  listMaxHeight,
}: {
  serverId: string;
  onNavigate: () => void;
  listMaxHeight: number;
}) {
  const { t } = useTranslation();
  const close = useDropdownMenuClose();
  const opened = useCallback(() => {
    close();
    onNavigate();
  }, [close, onNavigate]);
  const openSettings = useCallback(() => {
    opened();
    openNotificationSettings();
  }, [opened]);
  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <Text style={styles.title}>{t("notificationFeed.title")}</Text>
        <NotificationFeedActions serverId={serverId} onOpenSettings={openSettings} />
      </View>
      <NotificationFeedList serverId={serverId} maxHeight={listMaxHeight} onOpened={opened} />
    </View>
  );
}

function NotificationsBadge({ count }: { count: number }) {
  const text = feedBadgeText(count);
  if (!text) return null;
  return (
    <View style={styles.badge} pointerEvents="none" testID="sidebar-notifications-badge">
      <Text style={styles.badgeText}>{text}</Text>
    </View>
  );
}

// Button and badge geometry match the Browser tabs host button (spec 04 §27d.1): 32 × 32, radius
// 8; the badge is `StatusBadge` muted shrunk to 16 px, 2 px outside the corner.
const styles = StyleSheet.create((theme: Theme) => ({
  anchor: { flexShrink: 0 },
  button: {
    width: { xs: 44, md: 32 },
    height: { xs: 44, md: 32 },
    flexShrink: 0,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  buttonHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  badge: {
    position: "absolute",
    top: -2,
    right: -2,
    height: 16,
    minWidth: 16,
    paddingHorizontal: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: {
    fontSize: 12,
    lineHeight: 14,
    fontWeight: "400",
    color: theme.colors.foregroundMuted,
  },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.popoverForeground },
  // The menu measures its content, so the padding lives on the body, not the surface.
  surface: {
    borderRadius: 12,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  body: { padding: POPOVER_PADDING },
  header: {
    height: POPOVER_HEADER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 0,
  },
  title: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
}));
