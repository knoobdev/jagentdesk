import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type pino from "pino";
import { z } from "zod";
import {
  NOTIFICATION_FEED_MAX_AGE_MS,
  NOTIFICATION_FEED_MAX_ITEMS,
  NOTIFICATION_FEED_PAGE_SIZE,
  NotificationFeedItemSchema,
  type NotificationFeedItem,
  type NotificationFeedKind,
  type NotificationFeedTarget,
} from "@jagentdesk/protocol/notification-feed";
import { writePrivateFileAtomicSync } from "../private-files.js";

export interface NotificationFeedEntry {
  kind: NotificationFeedKind;
  title: string;
  body: string;
  target: NotificationFeedTarget;
}

export interface NotificationFeedChange {
  appended?: NotificationFeedItem[];
  readIds?: string[];
  removedIds?: string[];
}

export interface NotificationFeedState {
  unreadCount: number;
  unreadPlugins: Record<string, number>;
}

/** What opening something in a client marks read: an agent, or a bot item. */
export type NotificationFeedOpenedTarget = { agentId: string } | { botId: string; itemId: string };

const StoredFeedSchema = z.object({
  version: z.literal(1),
  items: z.array(z.unknown()),
});

/**
 * The host's notification list (ADR-0063, spec 14 §8.5). Every source the daemon notifies about
 * appends here whether or not anyone was told; read state belongs to the host, so every device
 * sees the same unread items. Kept to 500 items or 30 days, whichever comes first, in one JSON
 * file under JAGENTDESK_HOME that is rewritten on each change (the file stays under ~200 KB).
 */
export class NotificationFeed {
  /** Newest first. */
  private items: NotificationFeedItem[] = [];
  private readonly listeners = new Set<(change: NotificationFeedChange) => void>();
  private readonly logger: pino.Logger;
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly maxItems: number;
  private readonly maxAgeMs: number;
  private readonly write: typeof writePrivateFileAtomicSync;

  constructor(options: {
    logger: pino.Logger;
    filePath: string;
    now?: () => number;
    maxItems?: number;
    maxAgeMs?: number;
    write?: typeof writePrivateFileAtomicSync;
  }) {
    this.logger = options.logger.child({ component: "notification-feed" });
    this.filePath = options.filePath;
    this.now = options.now ?? Date.now;
    this.maxItems = options.maxItems ?? NOTIFICATION_FEED_MAX_ITEMS;
    this.maxAgeMs = options.maxAgeMs ?? NOTIFICATION_FEED_MAX_AGE_MS;
    this.write = options.write ?? writePrivateFileAtomicSync;
    this.load();
  }

  onChange(listener: (change: NotificationFeedChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  append(entry: NotificationFeedEntry): NotificationFeedItem {
    const createdAtMs = this.now();
    const item: NotificationFeedItem = {
      id: `nf_${createdAtMs.toString(36)}_${randomUUID().slice(0, 8)}`,
      kind: entry.kind,
      title: entry.title,
      body: entry.body,
      target: entry.target,
      createdAtMs,
      readAtMs: null,
    };
    this.items = [item, ...this.items];
    const removedIds = this.prune();
    this.persist();
    this.notify({ appended: [item], ...(removedIds.length > 0 ? { removedIds } : {}) });
    return item;
  }

  /** A page, newest first, starting after the item `before` (the oldest one the client has). */
  list(options: { before?: string; limit?: number } = {}): {
    items: NotificationFeedItem[];
    hasMore: boolean;
  } {
    const removedIds = this.prune();
    if (removedIds.length > 0) {
      this.persist();
      this.notify({ removedIds });
    }
    const limit = Math.min(
      Math.max(1, options.limit ?? NOTIFICATION_FEED_PAGE_SIZE),
      NOTIFICATION_FEED_PAGE_SIZE,
    );
    let start = 0;
    if (options.before) {
      const index = this.items.findIndex((item) => item.id === options.before);
      // A cursor that aged out: nothing older than it is left either.
      if (index === -1) return { items: [], hasMore: false };
      start = index + 1;
    }
    const items = this.items.slice(start, start + limit);
    return { items, hasMore: start + limit < this.items.length };
  }

  state(): NotificationFeedState {
    let unreadCount = 0;
    const unreadPlugins: Record<string, number> = {};
    for (const item of this.items) {
      if (item.readAtMs !== null) continue;
      unreadCount += 1;
      const pluginId = item.kind === "plugin" ? item.target.pluginId : undefined;
      if (pluginId) unreadPlugins[pluginId] = (unreadPlugins[pluginId] ?? 0) + 1;
    }
    return { unreadCount, unreadPlugins };
  }

  hasUnread(match: { kind: string; agentId: string }): boolean {
    return this.items.some(
      (item) =>
        item.readAtMs === null && item.kind === match.kind && item.target.agentId === match.agentId,
    );
  }

  /** Marks the given items (or every item) read. Returns the ids that were unread. */
  markRead(selection: { ids?: readonly string[]; all?: boolean }): string[] {
    const ids = selection.all ? null : new Set(selection.ids ?? []);
    return this.markWhere((item) => ids === null || ids.has(item.id));
  }

  /** Someone opened this agent or bot item on any client: its unread rows are read. */
  markOpened(target: NotificationFeedOpenedTarget): string[] {
    if ("agentId" in target) {
      return this.markWhere((item) => item.target.agentId === target.agentId);
    }
    return this.markWhere(
      (item) => item.target.botId === target.botId && item.target.itemId === target.itemId,
    );
  }

  private markWhere(matches: (item: NotificationFeedItem) => boolean): string[] {
    const readAtMs = this.now();
    const readIds: string[] = [];
    this.items = this.items.map((item) => {
      if (item.readAtMs !== null || !matches(item)) return item;
      readIds.push(item.id);
      return { ...item, readAtMs };
    });
    if (readIds.length === 0) return readIds;
    this.persist();
    this.notify({ readIds });
    return readIds;
  }

  private prune(): string[] {
    const oldestKept = this.now() - this.maxAgeMs;
    const kept: NotificationFeedItem[] = [];
    const removedIds: string[] = [];
    for (const item of this.items) {
      if (kept.length < this.maxItems && item.createdAtMs >= oldestKept) kept.push(item);
      else removedIds.push(item.id);
    }
    if (removedIds.length > 0) this.items = kept;
    return removedIds;
  }

  private notify(change: NotificationFeedChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        this.logger.warn({ err }, "Notification feed listener failed");
      }
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const stored = StoredFeedSchema.parse(JSON.parse(readFileSync(this.filePath, "utf8")));
      const items: NotificationFeedItem[] = [];
      for (const raw of stored.items) {
        const parsed = NotificationFeedItemSchema.safeParse(raw);
        if (parsed.success) items.push(parsed.data);
      }
      this.items = items.toSorted((left, right) => right.createdAtMs - left.createdAtMs);
      if (this.prune().length > 0) this.persist();
    } catch (err) {
      this.logger.warn({ err, filePath: this.filePath }, "Notification feed file is unreadable");
    }
  }

  private persist(): void {
    try {
      this.write(this.filePath, JSON.stringify({ version: 1, items: this.items }));
    } catch (err) {
      this.logger.warn({ err, filePath: this.filePath }, "Failed to save the notification feed");
    }
  }
}
