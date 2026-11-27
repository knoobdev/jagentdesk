import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItem,
  type PressableStateCallbackType,
} from "react-native";
import { Bell, CircleAlert, CircleCheck, Hand, Puzzle, Settings } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { NotificationFeedItem } from "@jagentdesk/protocol/notification-feed";
import {
  normalizeNotificationPreferences,
  type NotificationPreferences,
} from "@jagentdesk/protocol/notification-preferences";
import { BotAvatar } from "@/bots/avatar";
import { useBots } from "@/bots/queries";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppSettings } from "@/hooks/use-settings";
import { PluginIconView } from "@/plugins/icons";
import { useInstalledPlugins } from "@/plugins/registry";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  feedRowIcon,
  feedTime,
  groupFeedItems,
  visibleFeedItems,
  visibleUnreadCount,
  type FeedDay,
  type FeedTime,
} from "./model";
import { openNotificationFeedItem } from "./open";
import {
  loadOlderNotificationFeedPage,
  markNotificationFeedRead,
  useNotificationFeed,
} from "./store";

const ThemedCheck = withUnistyles(CircleCheck);
const ThemedHand = withUnistyles(Hand);
const ThemedAlert = withUnistyles(CircleAlert);
const ThemedPuzzle = withUnistyles(Puzzle);
const ThemedBell = withUnistyles(Bell);
const ThemedSettings = withUnistyles(Settings);
const success = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const warning = (theme: Theme) => ({ color: theme.colors.statusWarning });
const danger = (theme: Theme) => ({ color: theme.colors.statusDanger });
const muted = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedPluginIcon = withUnistyles(PluginIconView, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

/** This device's notification preferences; a muted plugin's rows are hidden here (ADR-0063 §5). */
export function useNotificationFeedPreferences(): NotificationPreferences {
  const { settings } = useAppSettings();
  return useMemo(
    () => normalizeNotificationPreferences(settings.notifications),
    [settings.notifications],
  );
}

/** The bell's badge count on this device. */
export function useNotificationFeedUnreadCount(serverId: string): number {
  const feed = useNotificationFeed(serverId);
  const preferences = useNotificationFeedPreferences();
  return visibleUnreadCount(feed, preferences);
}

function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function dayLabel(day: FeedDay, t: TFunction, language: string): string {
  if (day.kind === "today") return t("notificationFeed.day.today");
  if (day.kind === "yesterday") return t("notificationFeed.day.yesterday");
  return new Date(day.dayMs).toLocaleDateString(language, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function timeLabel(time: FeedTime, t: TFunction, language: string): string {
  switch (time.kind) {
    case "now":
      return t("notificationFeed.time.now");
    case "minutes":
      return t("notificationFeed.time.minutes", { count: time.count });
    case "hours":
      return t("notificationFeed.time.hours", { count: time.count });
    case "yesterday":
      return t("notificationFeed.time.yesterday");
    case "date":
      return new Date(time.dayMs).toLocaleDateString(language, { month: "short", day: "numeric" });
  }
}

/** "Mark all read" and the settings gear, shared by the popover header and the phone page. */
export function NotificationFeedActions({
  serverId,
  onOpenSettings,
}: {
  serverId: string;
  /** Null where a header already carries the gear (the Gumloop phone header). */
  onOpenSettings: (() => void) | null;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const unread = useNotificationFeedUnreadCount(serverId);
  const markAll = useCallback(() => {
    if (!client) return;
    void markNotificationFeedRead(client, serverId, "all").catch((error) =>
      console.warn("[NotificationFeed] Failed to mark all read", error),
    );
  }, [client, serverId]);
  const settingsLabel = t("notificationFeed.settings");
  const gearStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.iconButton,
      (hovered || pressed) && styles.iconButtonHovered,
    ],
    [],
  );
  return (
    <View style={styles.actions}>
      <Button
        variant="outline"
        size="sm"
        onPress={markAll}
        disabled={unread === 0 || !client}
        testID="notification-feed-mark-all-read"
      >
        {t("notificationFeed.markAllRead")}
      </Button>
      {onOpenSettings ? (
        <Tooltip delayDuration={300}>
          <TooltipTrigger
            accessibilityRole="button"
            accessibilityLabel={settingsLabel}
            onPress={onOpenSettings}
            style={gearStyle}
            testID="notification-feed-settings"
          >
            <ThemedSettings size={16} uniProps={muted} />
          </TooltipTrigger>
          <TooltipContent side="bottom" align="center" offset={6}>
            <Text style={styles.tooltip}>{settingsLabel}</Text>
          </TooltipContent>
        </Tooltip>
      ) : null}
    </View>
  );
}

type ListRow =
  | { type: "day"; key: string; label: string; first: boolean }
  | { type: "item"; key: string; item: NotificationFeedItem };

/**
 * The rows (spec 14 §8.5): newest first, grouped by day, 50 more at the end of the scroll. New rows
 * arrive on top without moving what the user is reading: native keeps the first visible row,
 * browsers do it through scroll anchoring.
 */
export function NotificationFeedList({
  serverId,
  maxHeight,
  onOpened,
}: {
  serverId: string;
  /** The popover caps the list; the phone page lets it fill the screen. */
  maxHeight?: number;
  onOpened?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const feed = useNotificationFeed(serverId);
  const preferences = useNotificationFeedPreferences();
  const client = useHostRuntimeClient(serverId);
  const now = useMinuteClock();
  const loadingOlder = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const items = useMemo(() => visibleFeedItems(feed.items, preferences), [feed.items, preferences]);
  const rows = useMemo(() => {
    const result: ListRow[] = [];
    for (const group of groupFeedItems(items, now)) {
      result.push({
        type: "day",
        key: `day:${group.key}`,
        label: dayLabel(group.day, t, i18n.language),
        first: result.length === 0,
      });
      for (const item of group.items) result.push({ type: "item", key: item.id, item });
    }
    return result;
  }, [items, now, t, i18n.language]);
  const loadOlder = useCallback(() => {
    if (!client || !feed.hasMore || loadingOlder.current) return;
    loadingOlder.current = true;
    setLoadingMore(true);
    void loadOlderNotificationFeedPage(client, serverId)
      .catch((error) => console.warn("[NotificationFeed] Failed to load older rows", error))
      .finally(() => {
        loadingOlder.current = false;
        setLoadingMore(false);
      });
  }, [client, feed.hasMore, serverId]);
  const open = useCallback(
    (item: NotificationFeedItem) => {
      onOpened?.();
      openNotificationFeedItem(serverId, item);
    },
    [onOpened, serverId],
  );
  const renderItem = useCallback<ListRenderItem<ListRow>>(
    ({ item: row }) =>
      row.type === "day" ? (
        <Text style={[styles.day, row.first && styles.dayFirst]}>{row.label}</Text>
      ) : (
        <FeedRow
          serverId={serverId}
          item={row.item}
          time={timeLabel(feedTime(row.item.createdAtMs, now), t, i18n.language)}
          onPress={open}
        />
      ),
    [serverId, now, t, i18n.language, open],
  );
  const listStyle = useMemo(
    () => (maxHeight === undefined ? styles.fill : { maxHeight }),
    [maxHeight],
  );
  if (!feed.loaded) {
    return (
      <View style={styles.loading} testID="notification-feed-loading">
        <ActivityIndicator size="small" />
      </View>
    );
  }
  if (rows.length === 0) {
    return (
      <View style={styles.empty} testID="notification-feed-empty">
        <Text style={styles.emptyTitle}>{t("notificationFeed.emptyTitle")}</Text>
        <Text style={styles.emptyBody}>{t("notificationFeed.emptyBody")}</Text>
      </View>
    );
  }
  return (
    <FlatList
      style={listStyle}
      contentContainerStyle={styles.listContent}
      data={rows}
      keyExtractor={rowKey}
      renderItem={renderItem}
      onEndReached={loadOlder}
      onEndReachedThreshold={0.5}
      maintainVisibleContentPosition={MAINTAIN_POSITION}
      ListFooterComponent={loadingMore ? LoadingMore : null}
      testID="notification-feed-list"
    />
  );
}

function LoadingMore() {
  return <ActivityIndicator size="small" style={styles.more} />;
}

const MAINTAIN_POSITION = { minIndexForVisible: 0, autoscrollToTopThreshold: 24 };

function rowKey(row: ListRow): string {
  return row.key;
}

const FeedRow = memo(function FeedRow({
  serverId,
  item,
  time,
  onPress,
}: {
  serverId: string;
  item: NotificationFeedItem;
  time: string;
  onPress: (item: NotificationFeedItem) => void;
}) {
  const unread = item.readAtMs === null;
  const agentTitle = useSessionStore((state) => {
    const agentId = item.target.type === "agent" ? item.target.agentId : undefined;
    if (!agentId) return null;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    return agent?.title ?? null;
  });
  // The daemon stores the fixed notification strings (spec 14 §7.1); the agent's name is what
  // tells two "Agent finished" rows apart, so it leads the second line when this device knows it.
  const detail = agentTitle ? `${agentTitle} · ${item.body}` : item.body;
  const handlePress = useCallback(() => onPress(item), [item, onPress]);
  const style = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (hovered || pressed) && styles.rowHovered,
    ],
    [],
  );
  return (
    <Pressable
      style={style}
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={`${item.title}. ${detail}`}
      testID={unread ? "notification-feed-row-unread" : "notification-feed-row-read"}
    >
      <View style={[styles.dot, unread && styles.dotUnread]} />
      <View style={styles.icon}>
        <FeedRowIcon serverId={serverId} item={item} />
      </View>
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, unread && styles.rowTitleUnread]} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={styles.rowBody} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Text style={styles.time}>{time}</Text>
    </Pressable>
  );
});

function FeedRowIcon({ serverId, item }: { serverId: string; item: NotificationFeedItem }) {
  const icon = feedRowIcon(item.kind);
  if (icon === "finished") return <ThemedCheck size={16} uniProps={success} />;
  if (icon === "permission") return <ThemedHand size={16} uniProps={warning} />;
  if (icon === "error") return <ThemedAlert size={16} uniProps={danger} />;
  if (icon === "bot") return <BotRowIcon serverId={serverId} botId={item.target.botId} />;
  if (icon === "plugin")
    return <PluginRowIcon serverId={serverId} pluginId={item.target.pluginId} />;
  return <ThemedBell size={16} uniProps={muted} />;
}

function BotRowIcon({ serverId, botId }: { serverId: string; botId: string | undefined }) {
  const bots = useBots(serverId);
  const bot = bots.data?.find((entry) => entry.id === botId);
  if (!bot) return <ThemedBell size={16} uniProps={muted} />;
  return <BotAvatar bot={bot} serverId={serverId} size={16} radius={4} />;
}

function PluginRowIcon({ serverId, pluginId }: { serverId: string; pluginId: string | undefined }) {
  const plugins = useInstalledPlugins();
  const plugin = plugins.find((entry) => entry.serverId === serverId && entry.id === pluginId);
  const icon = plugin?.sidebarItems[0]?.icon;
  if (!icon) return <ThemedPuzzle size={16} uniProps={muted} />;
  return <ThemedPluginIcon icon={icon} size={16} />;
}

// Two-line rows of spec 38 §4.6 (56 px), day labels like the History list.
const styles = StyleSheet.create((theme: Theme) => ({
  fill: { flex: 1 },
  listContent: { paddingBottom: theme.spacing[2] },
  loading: { paddingVertical: theme.spacing[6], alignItems: "center" },
  more: { paddingVertical: theme.spacing[3] },
  empty: {
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    alignItems: "center",
    gap: theme.spacing[1],
  },
  emptyTitle: { fontSize: 14, fontWeight: "500", color: theme.colors.foreground },
  emptyBody: { fontSize: 13, color: theme.colors.foregroundMuted, textAlign: "center" },
  day: {
    fontSize: 14,
    fontWeight: "600",
    color: theme.colors.foreground,
    marginTop: 16,
    marginBottom: 4,
    paddingHorizontal: theme.spacing[2],
  },
  dayFirst: { marginTop: 0 },
  row: {
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: 8,
  },
  rowHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotUnread: { backgroundColor: theme.colors.accent },
  icon: { width: 16, height: 16, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: 14, fontWeight: "400", color: theme.colors.foreground },
  rowTitleUnread: { fontWeight: "500" },
  rowBody: { fontSize: 13, color: theme.colors.foregroundMuted },
  time: { fontSize: 12, color: theme.colors.foregroundMuted, flexShrink: 0 },
  actions: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonHovered: { backgroundColor: theme.colors.surfaceSidebarHover },
  tooltip: { fontSize: theme.fontSize.sm, color: theme.colors.popoverForeground },
}));
