import { describe, expect, it } from "vitest";
import type { NotificationFeedItem } from "@jagentdesk/protocol/notification-feed";
import { normalizeNotificationPreferences } from "@jagentdesk/protocol/notification-preferences";
import {
  applyFeedChange,
  applyFeedPage,
  EMPTY_NOTIFICATION_FEED,
  feedBadgeText,
  feedOpenTarget,
  feedRowIcon,
  feedTime,
  groupFeedItems,
  markFeedItemsReadLocally,
  visibleFeedItems,
  visibleUnreadCount,
} from "./model";

const NOW = new Date(2026, 10, 28, 15, 0, 0).getTime();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function row(id: string, createdAtMs: number, extra: Partial<NotificationFeedItem> = {}) {
  return {
    id,
    kind: "agent_finished",
    title: "Agent finished",
    body: "Finished working.",
    target: { type: "agent", agentId: `agent-${id}`, workspaceId: "wks_1" },
    createdAtMs,
    readAtMs: null,
    ...extra,
  } satisfies NotificationFeedItem;
}

function plugin(id: string, pluginId: string): NotificationFeedItem {
  return row(id, NOW, {
    kind: "plugin",
    title: "Deploy",
    body: "Done",
    target: { type: "plugin", pluginId, notificationId: `n-${id}` },
  });
}

describe("notification feed model", () => {
  it("keeps a row a change inserted while the first page was in flight", () => {
    const live = applyFeedChange(
      EMPTY_NOTIFICATION_FEED,
      { appended: [row("c", NOW)], unreadCount: 3 },
      NOW,
    );
    const page = applyFeedPage(
      live,
      {
        requestId: "r",
        items: [row("b", NOW - 1), row("a", NOW - 2)],
        unreadCount: 3,
        hasMore: true,
      },
      { older: false },
    );
    expect(page.items.map((item) => item.id)).toEqual(["c", "b", "a"]);
    expect(page).toMatchObject({ loaded: true, hasMore: true, unreadCount: 3 });
  });

  it("extends with an older page and drops duplicates", () => {
    const first = applyFeedPage(
      EMPTY_NOTIFICATION_FEED,
      { requestId: "r", items: [row("b", NOW - 1)], unreadCount: 2, hasMore: true },
      { older: false },
    );
    const older = applyFeedPage(
      first,
      {
        requestId: "r",
        items: [row("b", NOW - 1), row("a", NOW - 2)],
        unreadCount: 2,
        hasMore: false,
      },
      { older: true },
    );
    expect(older.items.map((item) => item.id)).toEqual(["b", "a"]);
    expect(older.hasMore).toBe(false);
  });

  it("applies read and removed ids from another device", () => {
    const state = applyFeedPage(
      EMPTY_NOTIFICATION_FEED,
      {
        requestId: "r",
        items: [row("b", NOW - 1), row("a", NOW - 2)],
        unreadCount: 2,
        hasMore: false,
      },
      { older: false },
    );
    const next = applyFeedChange(state, { readIds: ["b"], removedIds: ["a"], unreadCount: 0 }, NOW);
    expect(next.items).toEqual([{ ...row("b", NOW - 1), readAtMs: NOW }]);
    expect(next.unreadCount).toBe(0);
  });

  it("marks rows read locally before the host answers", () => {
    const state = applyFeedPage(
      EMPTY_NOTIFICATION_FEED,
      {
        requestId: "r",
        items: [row("b", NOW - 1), row("a", NOW - 2)],
        unreadCount: 5,
        hasMore: true,
      },
      { older: false },
    );
    expect(markFeedItemsReadLocally(state, ["a"], NOW).unreadCount).toBe(4);
    expect(markFeedItemsReadLocally(state, "all", NOW)).toMatchObject({ unreadCount: 0 });
    expect(markFeedItemsReadLocally(state, ["missing"], NOW)).toBe(state);
  });

  it("hides muted plugins on this device and leaves them out of the badge", () => {
    const preferences = normalizeNotificationPreferences({ plugins: { muted: ["ci"] } });
    const items = [plugin("1", "ci"), plugin("2", "deploys"), row("3", NOW)];
    expect(visibleFeedItems(items, preferences).map((item) => item.id)).toEqual(["2", "3"]);
    expect(
      visibleUnreadCount({ unreadCount: 5, unreadPlugins: { ci: 2, deploys: 1 } }, preferences),
    ).toBe(3);
    const pluginsOff = normalizeNotificationPreferences({ plugins: { enabled: false } });
    expect(
      visibleUnreadCount({ unreadCount: 5, unreadPlugins: { ci: 2, deploys: 1 } }, pluginsOff),
    ).toBe(2);
  });

  it("formats the badge like the Browser tabs button", () => {
    expect(feedBadgeText(0)).toBeNull();
    expect(feedBadgeText(4)).toBe("4");
    expect(feedBadgeText(99)).toBe("99");
    expect(feedBadgeText(100)).toBe("99+");
  });

  it("groups by day and gives relative times", () => {
    const items = [
      row("a", NOW - 2 * MINUTE),
      row("b", NOW - 3 * HOUR),
      row("c", NOW - 20 * HOUR),
      row("d", NOW - 4 * 24 * HOUR),
    ];
    expect(groupFeedItems(items, NOW).map((group) => [group.day.kind, group.items.length])).toEqual(
      [
        ["today", 2],
        ["yesterday", 1],
        ["date", 1],
      ],
    );
    expect(feedTime(NOW - 10_000, NOW)).toEqual({ kind: "now" });
    expect(feedTime(NOW - 2 * MINUTE, NOW)).toEqual({ kind: "minutes", count: 2 });
    expect(feedTime(NOW - 3 * HOUR, NOW)).toEqual({ kind: "hours", count: 3 });
    expect(feedTime(NOW - 20 * HOUR, NOW)).toEqual({ kind: "yesterday" });
    expect(feedTime(NOW - 4 * 24 * HOUR, NOW).kind).toBe("date");
  });

  it("maps kinds to icons and rows to what they open", () => {
    expect(
      ["agent_finished", "agent_permission", "agent_error", "bot_needs_you", "plugin", "x"].map(
        feedRowIcon,
      ),
    ).toEqual(["finished", "permission", "error", "bot", "plugin", "generic"]);
    expect(feedOpenTarget(row("a", NOW))).toEqual({
      kind: "agent",
      agentId: "agent-a",
      workspaceId: "wks_1",
    });
    expect(
      feedOpenTarget(
        row("b", NOW, {
          kind: "bot_needs_you",
          target: { type: "bot", botId: "bot-1", itemId: "i" },
        }),
      ),
    ).toEqual({ kind: "bot", botId: "bot-1", itemId: "i", agentId: null });
    expect(feedOpenTarget(row("c", NOW, { kind: "x", target: { type: "terminal" } }))).toEqual({
      kind: "host",
    });
  });
});
