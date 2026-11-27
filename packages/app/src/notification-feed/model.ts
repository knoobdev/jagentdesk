import type {
  NotificationFeedChangedPayload,
  NotificationFeedItem,
  NotificationFeedListPayload,
} from "@jagentdesk/protocol/notification-feed";
import type { NotificationPreferences } from "@jagentdesk/protocol/notification-preferences";

// The bell's list (ADR-0063, spec 14 §8.5). The daemon owns the rows and their read state; this
// module merges its pages and change events and decides what this device shows.

export interface NotificationFeedState {
  /** Newest first, no duplicates. */
  items: NotificationFeedItem[];
  unreadCount: number;
  unreadPlugins: Record<string, number>;
  hasMore: boolean;
  /** False until the first page arrived. */
  loaded: boolean;
}

export const EMPTY_NOTIFICATION_FEED: NotificationFeedState = {
  items: [],
  unreadCount: 0,
  unreadPlugins: {},
  hasMore: false,
  loaded: false,
};

function sortNewestFirst(items: Iterable<NotificationFeedItem>): NotificationFeedItem[] {
  return [...items].toSorted(
    (left, right) => right.createdAtMs - left.createdAtMs || right.id.localeCompare(left.id),
  );
}

/**
 * A page from `notifications.feed.list`. The first page (`older` false) replaces what the device
 * had but keeps rows a change event inserted meanwhile; an older page extends the list.
 */
export function applyFeedPage(
  state: NotificationFeedState,
  page: NotificationFeedListPayload,
  options: { older: boolean },
): NotificationFeedState {
  const byId = new Map<string, NotificationFeedItem>();
  if (options.older) {
    for (const item of state.items) byId.set(item.id, item);
  } else {
    const oldest = page.items.at(-1)?.createdAtMs ?? Number.NEGATIVE_INFINITY;
    for (const item of state.items) if (item.createdAtMs > oldest) byId.set(item.id, item);
  }
  for (const item of page.items) byId.set(item.id, item);
  return {
    items: sortNewestFirst(byId.values()),
    unreadCount: page.unreadCount,
    unreadPlugins: page.unreadPlugins ?? {},
    hasMore: options.older || page.items.length > 0 ? page.hasMore : state.hasMore,
    loaded: true,
  };
}

/** `notifications.feed.changed`: new rows go on top, read and dropped rows update in place. */
export function applyFeedChange(
  state: NotificationFeedState,
  change: NotificationFeedChangedPayload,
  nowMs: number,
): NotificationFeedState {
  const removed = new Set(change.removedIds ?? []);
  const read = new Set(change.readIds ?? []);
  const byId = new Map<string, NotificationFeedItem>();
  for (const item of state.items) {
    if (removed.has(item.id)) continue;
    byId.set(
      item.id,
      read.has(item.id) && item.readAtMs === null ? { ...item, readAtMs: nowMs } : item,
    );
  }
  for (const item of change.appended ?? []) if (!removed.has(item.id)) byId.set(item.id, item);
  return {
    ...state,
    items: sortNewestFirst(byId.values()),
    unreadCount: change.unreadCount,
    unreadPlugins: change.unreadPlugins ?? state.unreadPlugins,
  };
}

/** Rows read on this device before the daemon answers; the change event confirms them. */
export function markFeedItemsReadLocally(
  state: NotificationFeedState,
  ids: readonly string[] | "all",
  nowMs: number,
): NotificationFeedState {
  const selected = ids === "all" ? null : new Set(ids);
  let newlyRead = 0;
  const items = state.items.map((item) => {
    if (item.readAtMs !== null || (selected && !selected.has(item.id))) return item;
    newlyRead += 1;
    return { ...item, readAtMs: nowMs };
  });
  if (newlyRead === 0) return state;
  return {
    ...state,
    items,
    unreadCount: ids === "all" ? 0 : Math.max(0, state.unreadCount - newlyRead),
    unreadPlugins: ids === "all" ? {} : state.unreadPlugins,
  };
}

/** A plugin muted on this device (Settings → This device → Notifications) is hidden here. */
export function isFeedItemHidden(
  item: NotificationFeedItem,
  preferences: NotificationPreferences,
): boolean {
  if (item.kind !== "plugin") return false;
  if (!preferences.plugins.enabled) return true;
  return preferences.plugins.muted.includes(item.target.pluginId ?? "");
}

export function visibleFeedItems(
  items: readonly NotificationFeedItem[],
  preferences: NotificationPreferences,
): NotificationFeedItem[] {
  return items.filter((item) => !isFeedItemHidden(item, preferences));
}

/** The badge count: the host's unread rows minus those of plugins this device hides. */
export function visibleUnreadCount(
  state: Pick<NotificationFeedState, "unreadCount" | "unreadPlugins">,
  preferences: NotificationPreferences,
): number {
  let hidden = 0;
  for (const [pluginId, count] of Object.entries(state.unreadPlugins)) {
    if (!preferences.plugins.enabled || preferences.plugins.muted.includes(pluginId)) {
      hidden += count;
    }
  }
  return Math.max(0, state.unreadCount - hidden);
}

/** Badge text like the Browser tabs button (spec 04 §27d.1): none at 0, `99+` above 99. */
export function feedBadgeText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

export type FeedRowIcon = "finished" | "permission" | "error" | "bot" | "plugin" | "generic";

export function feedRowIcon(kind: string): FeedRowIcon {
  switch (kind) {
    case "agent_finished":
      return "finished";
    case "agent_permission":
      return "permission";
    case "agent_error":
      return "error";
    case "bot_needs_you":
    case "bot_task_complete":
    case "bot_could_not_finish":
      return "bot";
    case "plugin":
      return "plugin";
    default:
      return "generic";
  }
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export type FeedDay = { kind: "today" } | { kind: "yesterday" } | { kind: "date"; dayMs: number };

export function feedDay(createdAtMs: number, nowMs: number): FeedDay {
  const day = startOfDay(createdAtMs);
  const today = startOfDay(nowMs);
  if (day >= today) return { kind: "today" };
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day >= yesterday.getTime()) return { kind: "yesterday" };
  return { kind: "date", dayMs: day };
}

export interface FeedGroup {
  key: string;
  day: FeedDay;
  items: NotificationFeedItem[];
}

/** Day groups like the History list (spec 38 §4.6): Today, Yesterday, then dates. */
export function groupFeedItems(items: readonly NotificationFeedItem[], nowMs: number): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const item of items) {
    const day = feedDay(item.createdAtMs, nowMs);
    const key = day.kind === "date" ? `date:${day.dayMs}` : day.kind;
    const last = groups.at(-1);
    if (last?.key === key) last.items.push(item);
    else groups.push({ key, day, items: [item] });
  }
  return groups;
}

export type FeedTime =
  | { kind: "now" }
  | { kind: "minutes"; count: number }
  | { kind: "hours"; count: number }
  | { kind: "yesterday" }
  | { kind: "date"; dayMs: number };

/** Relative time at the row's right edge: `2m`, `3h`, `Yesterday`, then the date. */
export function feedTime(createdAtMs: number, nowMs: number): FeedTime {
  const elapsed = Math.max(0, nowMs - createdAtMs);
  if (elapsed < 60_000) return { kind: "now" };
  if (elapsed < 60 * 60_000) return { kind: "minutes", count: Math.floor(elapsed / 60_000) };
  const day = feedDay(createdAtMs, nowMs);
  if (day.kind === "today") return { kind: "hours", count: Math.floor(elapsed / (60 * 60_000)) };
  return day;
}

export type FeedOpenTarget =
  | { kind: "agent"; agentId: string; workspaceId: string | null }
  | { kind: "bot"; botId: string; itemId: string | null; agentId: string | null }
  | {
      kind: "plugin";
      pluginId: string;
      notificationId: string;
      open: NonNullable<NotificationFeedItem["target"]["open"]> | null;
    }
  | { kind: "host" };

/** Where tapping a row goes; a target this client cannot read opens the host. */
export function feedOpenTarget(item: NotificationFeedItem): FeedOpenTarget {
  const { target } = item;
  if (target.type === "agent" && target.agentId) {
    return { kind: "agent", agentId: target.agentId, workspaceId: target.workspaceId ?? null };
  }
  if (target.type === "bot" && target.botId) {
    return {
      kind: "bot",
      botId: target.botId,
      itemId: target.itemId ?? null,
      agentId: target.agentId ?? null,
    };
  }
  if (target.type === "plugin" && target.pluginId && target.notificationId) {
    return {
      kind: "plugin",
      pluginId: target.pluginId,
      notificationId: target.notificationId,
      open: target.open ?? null,
    };
  }
  return { kind: "host" };
}
