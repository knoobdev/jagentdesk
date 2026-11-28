import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  NotificationFeed,
  type NotificationFeedChange,
  type NotificationFeedEntry,
} from "./feed.js";

const logger = pino({ level: "silent" });
const DAY_MS = 24 * 60 * 60 * 1000;

function finished(agentId: string): NotificationFeedEntry {
  return {
    kind: "agent_finished",
    title: "Agent finished",
    body: "Finished working.",
    target: { type: "agent", agentId, workspaceId: "wks_1" },
  };
}

describe("NotificationFeed", () => {
  let dir: string;
  let filePath: string;
  let clock: number;
  const now = () => clock;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "notification-feed-"));
    filePath = path.join(dir, "notification-feed.json");
    clock = 1_800_000_000_000;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function open(options: { maxItems?: number } = {}) {
    return new NotificationFeed({ logger, filePath, now, ...options });
  }

  test("lists newest first in pages with a before cursor", () => {
    const feed = open();
    for (let index = 0; index < 120; index += 1) {
      clock += 1000;
      feed.append(finished(`agent-${index}`));
    }
    const first = feed.list();
    expect(first.items).toHaveLength(50);
    expect(first.items[0]?.target.agentId).toBe("agent-119");
    expect(first.hasMore).toBe(true);
    const second = feed.list({ before: first.items.at(-1)?.id });
    expect(second.items[0]?.target.agentId).toBe("agent-69");
    const third = feed.list({ before: second.items.at(-1)?.id });
    expect(third.items).toHaveLength(20);
    expect(third.items.at(-1)?.target.agentId).toBe("agent-0");
    expect(third.hasMore).toBe(false);
  });

  test("keeps 500 items: the 501st drops the oldest", () => {
    const feed = open();
    const changes: NotificationFeedChange[] = [];
    let firstId = "";
    for (let index = 0; index < 501; index += 1) {
      clock += 1;
      const item = feed.append(finished(`agent-${index}`));
      if (index === 0) firstId = item.id;
      if (index === 499) feed.onChange((change) => changes.push(change));
    }
    expect(feed.state().unreadCount).toBe(500);
    expect(changes.at(-1)?.removedIds).toEqual([firstId]);
    const stored = JSON.parse(readFileSync(filePath, "utf8")) as { items: { id: string }[] };
    expect(stored.items).toHaveLength(500);
    expect(stored.items.some((item) => item.id === firstId)).toBe(false);
  });

  test("drops items older than 30 days", () => {
    const feed = open();
    feed.append(finished("old"));
    clock += 10 * DAY_MS;
    feed.append(finished("recent"));
    clock += 21 * DAY_MS;
    expect(feed.list().items.map((item) => item.target.agentId)).toEqual(["recent"]);
  });

  test("survives a restart with read state", () => {
    const feed = open();
    const first = feed.append(finished("a"));
    clock += 1;
    feed.append(finished("b"));
    feed.markRead({ ids: [first.id] });

    const reopened = open();
    const items = reopened.list().items;
    expect(items.map((item) => item.target.agentId)).toEqual(["b", "a"]);
    expect(items[1]?.readAtMs).toBe(clock);
    expect(reopened.state().unreadCount).toBe(1);
  });

  test("an unreadable file starts an empty feed instead of failing", () => {
    writeFileSync(filePath, "{not json");
    expect(open().list().items).toEqual([]);
  });

  test("mark all read reports only the ids that were unread", () => {
    const feed = open();
    const a = feed.append(finished("a"));
    const b = feed.append(finished("b"));
    expect(feed.markRead({ ids: [a.id] })).toEqual([a.id]);
    const changes: NotificationFeedChange[] = [];
    feed.onChange((change) => changes.push(change));
    expect(feed.markRead({ all: true })).toEqual([b.id]);
    expect(feed.markRead({ all: true })).toEqual([]);
    expect(changes).toEqual([{ readIds: [b.id] }]);
    expect(feed.state().unreadCount).toBe(0);
  });

  test("opening an agent or a bot item marks its rows read", () => {
    const feed = open();
    const a1 = feed.append(finished("a"));
    feed.append(finished("b"));
    const a2 = feed.append({
      kind: "agent_permission",
      title: "Agent needs permission",
      body: "Permission requested.",
      target: { type: "agent", agentId: "a", workspaceId: "wks_1" },
    });
    const botItem = feed.append({
      kind: "bot_needs_you",
      title: "Scout asked you",
      body: "Ship it?",
      target: { type: "bot", botId: "bot-1", itemId: "item-1" },
    });
    feed.append({
      kind: "bot_needs_you",
      title: "Scout asked you",
      body: "Other",
      target: { type: "bot", botId: "bot-1", itemId: "item-2" },
    });
    expect(feed.markOpened({ agentId: "a" }).toSorted()).toEqual([a1.id, a2.id].toSorted());
    expect(feed.markOpened({ botId: "bot-1", itemId: "item-1" })).toEqual([botItem.id]);
    expect(feed.state().unreadCount).toBe(2);
  });

  test("counts unread plugin rows per plugin", () => {
    const feed = open();
    for (const pluginId of ["deploys", "deploys", "ci"]) {
      feed.append({
        kind: "plugin",
        title: "Deploy",
        body: "Done",
        target: { type: "plugin", pluginId, notificationId: `n-${pluginId}` },
      });
    }
    feed.append(finished("a"));
    expect(feed.state()).toEqual({ unreadCount: 4, unreadPlugins: { deploys: 2, ci: 1 } });
  });
});
