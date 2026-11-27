// Pure item rules the Items surfaces share. Ported from Orca dfdb4fda (MIT):
// src/shared/bots/bot-item-status-name.ts:1-40, bot-item-snooze.ts:1-60,107-140,
// bot-item-ask.ts:62-72,124-132, bot-item-question-answers.ts (botItemAnswersText),
// bot-items.ts:24-26,92-94,256-258, src/renderer/src/lib/time-format/short-time-ago.ts and
// src/renderer/src/components/bots/items/BotItemsFilter.tsx:22-30 (botItemChatName).
import {
  BOT_ITEM_GROUP_IDS,
  BOT_ITEM_SNOOZE_MAX_MS,
  isOpenBotItemStatus,
  type BotItemGroupId,
} from "@jagentdesk/protocol/bots/rules";
import type { BotNeedsYouRow } from "@jagentdesk/protocol/bots/views";
import type {
  BotItem,
  BotItemDecision,
  BotItemEvent,
  BotItemLink,
  BotItemStatus,
} from "@jagentdesk/protocol/bots/types";

type Translate = (key: string, values?: Record<string, unknown>) => string;

export const BOT_ITEM_STATUSES: readonly BotItemStatus[] = [
  "planned",
  "working",
  "waiting",
  "needs_you",
  "done",
  "canceled",
];
/** What the owner's status pickers offer: not Waiting, whose wait text they don't ask for. */
export const BOT_ITEM_PICKER_STATUSES: readonly BotItemStatus[] = BOT_ITEM_STATUSES.filter(
  (status) => status !== "waiting",
);

const STATUS_KEYS: Record<BotItemStatus, string> = {
  planned: "bots.items.status.planned",
  working: "bots.items.status.working",
  waiting: "bots.items.status.waiting",
  needs_you: "bots.items.status.needsYou",
  done: "bots.items.status.done",
  canceled: "bots.items.status.canceled",
};

export function botItemStatusName(status: BotItemStatus, t: Translate): string {
  return t(STATUS_KEYS[status]);
}

/** A group's title: a status's name, or Snoozed, Stale or Closed. */
export function botItemGroupName(id: BotItemGroupId, t: Translate): string {
  if (id === "snoozed") return t("bots.items.group.snoozed");
  if (id === "stale") return t("bots.items.group.stale");
  if (id === "closed") return t("bots.items.group.closed");
  return botItemStatusName(id, t);
}

/** The item's uid (`uid`, same as `id`; older daemons send only `id`). */
export function botItemUid(item: Pick<BotItem, "id" | "uid">): string {
  return item.uid ?? item.id;
}

export function formatBotItemNumber(number: number | undefined): string {
  return number === undefined ? "" : `#${number}`;
}

/** A linked worker still running (or of unknown state): the row draws a spinner. */
export function isBotItemLive(item: Pick<BotItem, "links">): boolean {
  return (item.links ?? []).some(
    (link) => link.kind === "dispatch" && (link.state === "working" || link.state === "unknown"),
  );
}

/** Reviews (spec 37.3.7) still to pass before the item can be done. */
export function isBotItemAwaitingReview(item: Pick<BotItem, "review" | "status">): boolean {
  return (
    isOpenBotItemStatus(item.status) && item.review !== undefined && item.review.state !== "passed"
  );
}

/** Changed since the owner last looked at Items (`bot.itemsSeen_ms`). */
export function isBotItemUnseen(
  item: Pick<BotItem, "lastActivityAt_ms" | "updatedAt_ms">,
  seen_ms: number | undefined,
): boolean {
  if (seen_ms === undefined) return false;
  return (item.lastActivityAt_ms ?? item.updatedAt_ms) > seen_ms;
}

/** Compact "now / 5m / 3h / 2d" age label shared by agent rows and activity threads. */
export function formatShortTimeAgo(ts: number, now: number): string {
  const delta = now - ts;
  if (delta < 60_000) return "now";
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A chat's name as rows say it: Home Chat, else its title. */
export function botItemChatName(chat: BotItem["chat"] | undefined, t: Translate): string {
  if (!chat || chat.kind === "home") return t("bots.items.homeChat");
  return chat.title ?? t("bots.items.chatFallback");
}

// ── Snooze ──────────────────────────────────────────────────────────────────────────────────────

export type BotItemSnoozePresetId = "later" | "tomorrow" | "monday" | "week";
export interface BotItemSnoozePreset {
  id: BotItemSnoozePresetId;
  at: number;
  /** Later today in the evening reads "In 3 hours"; otherwise the preset's own name. */
  inHours?: number;
}

const MORNING_HOUR = 9;
const EVENING_HOUR = 18;
// Past this hour, 6 PM is too close to be "later", so Later today is three hours out.
const LATER_CUTOFF_HOUR = 17;
const LATER_HOURS = 3;

function atHour(day: Date, hour: number): number {
  const time = new Date(day);
  time.setHours(hour, 0, 0, 0);
  return time.getTime();
}

/** Later today, Tomorrow 9 AM and Monday 9 AM (next Monday on a Monday), from `now` local time. */
export function botItemSnoozePresets(now: number): BotItemSnoozePreset[] {
  const today = new Date(now);
  const later: BotItemSnoozePreset =
    today.getHours() < LATER_CUTOFF_HOUR
      ? { id: "later", at: atHour(today, EVENING_HOUR) }
      : {
          id: "later",
          at: atHour(today, today.getHours() + LATER_HOURS + (today.getMinutes() > 0 ? 1 : 0)),
          inHours: LATER_HOURS,
        };
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const monday = new Date(today);
  monday.setDate(today.getDate() + ((8 - today.getDay()) % 7 || 7));
  return [
    later,
    { id: "tomorrow", at: atHour(tomorrow, MORNING_HOUR) },
    { id: "monday", at: atHour(monday, MORNING_HOUR) },
  ];
}

/** The menu's three, then the same time of morning a week out (spec 37.4.5 "In a week"). */
export function botItemSnoozePickerPresets(now: number): BotItemSnoozePreset[] {
  const week = new Date(now);
  week.setDate(week.getDate() + 7);
  const inAWeek = atHour(week, MORNING_HOUR);
  return [
    ...botItemSnoozePresets(now).filter((preset) => preset.at !== inAWeek),
    { id: "week", at: inAWeek },
  ];
}

export function botItemSnoozePresetName(preset: BotItemSnoozePreset, t: Translate): string {
  switch (preset.id) {
    case "later":
      return preset.inHours
        ? t("bots.items.snooze.inHours", { count: preset.inHours })
        : t("bots.items.snooze.later");
    case "tomorrow":
      return t("bots.items.snooze.tomorrow");
    case "monday":
      return t("bots.items.snooze.monday");
    case "week":
      return t("bots.items.snooze.week");
  }
}

/** How a wake time reads: "6:00 PM" today, "Thu 9:00 AM" within the week, else "Nov 30, 9:00 AM". */
export function botItemSnoozeTimeFormat(until: number, now: number): Intl.DateTimeFormatOptions {
  const time = { hour: "numeric", minute: "2-digit" } as const;
  if (new Date(until).toDateString() === new Date(now).toDateString()) return time;
  return until - now < 6 * 24 * 60 * 60_000
    ? { weekday: "short", ...time }
    : { month: "short", day: "numeric", ...time };
}

export function formatBotItemSnoozeTime(until: number, now: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, botItemSnoozeTimeFormat(until, now)).format(until);
}

/** A picked wake time is in the future and within the 366-day cap. */
export function isValidBotItemSnooze(until: number, now: number): boolean {
  return Number.isFinite(until) && until > now && until <= now + BOT_ITEM_SNOOZE_MAX_MS;
}

/** "YYYY-MM-DD" and "HH:MM" in local time, or null when either doesn't parse. */
export function parseBotItemSnoozeInput(date: string, time: string): number | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const clock = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!day || !clock) return null;
  const [year, month, dayOfMonth] = [Number(day[1]), Number(day[2]), Number(day[3])];
  const [hour, minute] = [Number(clock[1]), Number(clock[2])];
  if (month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  const at = new Date(year, month - 1, dayOfMonth, hour, minute);
  return at.getMonth() === month - 1 && at.getDate() === dayOfMonth ? at.getTime() : null;
}

// ── Questions ───────────────────────────────────────────────────────────────────────────────────

/** A question's first line, its Markdown marks dropped: what "Question → answer" shows. */
export function botItemQuestionLine(text: string): string {
  const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
  return first
    .trim()
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .trim();
}

/**
 * The one comment an ask's answers post as: a single question posts the reply's words; several
 * post one "Question → answer" line each (Orca `botItemAnswersText`).
 */
export function botItemAnswersText(
  decisions: readonly BotItemDecision[],
  answers: readonly (string | null)[],
): string {
  return decisions
    .flatMap((decision, index) => {
      const words = answers[index]?.replace(/\s+/g, " ").trim();
      if (!words) return [];
      return [decisions.length > 1 ? `${botItemQuestionLine(decision.prompt)} → ${words}` : words];
    })
    .join("\n");
}

// ── Filters and order ───────────────────────────────────────────────────────────────────────────

export interface BotItemFilterState {
  needsYouOnly: boolean;
  chatId: string | null;
}

export function isBotItemFilterOn(filter: BotItemFilterState): boolean {
  return filter.needsYouOnly || filter.chatId !== null;
}

export function filterBotItems(items: readonly BotItem[], filter: BotItemFilterState): BotItem[] {
  return items.filter(
    (item) =>
      (!filter.needsYouOnly || item.status === "needs_you") &&
      (filter.chatId === null || item.chat?.id === filter.chatId),
  );
}

/** The chats the items came from, in first-seen order: the Chat filter's choices. */
export function botItemChats(items: readonly BotItem[]): NonNullable<BotItem["chat"]>[] {
  const chats = new Map<string, NonNullable<BotItem["chat"]>>();
  for (const item of items)
    if (item.chat && !chats.has(item.chat.id)) chats.set(item.chat.id, item.chat);
  return [...chats.values()];
}

/** Every row in the list's order, groups first to last: Previous / Next walk it. */
export function botItemsInListOrder(groups: Record<BotItemGroupId, BotItem[]>): BotItem[] {
  return BOT_ITEM_GROUP_IDS.flatMap((id) => groups[id]);
}

// ── Links and activity ──────────────────────────────────────────────────────────────────────────

/** `owner/repo#12` → 12. */
export function botItemPrNumber(ref: string): number | null {
  const match = /#(\d+)$/.exec(ref);
  return match ? Number(match[1]) : null;
}

export type BotItemActivityEntry =
  | { kind: "event"; key: string; at: number; event: BotItemEvent }
  | {
      kind: "worker";
      key: string;
      at: number;
      phase: "started" | "settled";
      link: Extract<BotItemLink, { kind: "dispatch" }>;
    };

/**
 * The item's Activity: its events, and for each worker it dispatched a "Worker started:" line and,
 * once settled, "Worker finished:" / "Worker stopped:", in time order (Orca `botItemActivity`).
 */
export function botItemActivity(
  item: Pick<BotItem, "links">,
  events: readonly BotItemEvent[],
): BotItemActivityEntry[] {
  const entries: BotItemActivityEntry[] = events.map((event) => ({
    kind: "event",
    key: event.id,
    at: event.at_ms,
    event,
  }));
  for (const link of item.links ?? []) {
    if (link.kind !== "dispatch") continue;
    if (link.startedAt_ms !== null)
      entries.push({
        kind: "worker",
        key: `${link.ref}:started`,
        at: link.startedAt_ms,
        phase: "started",
        link,
      });
    if (link.settledAt_ms !== null)
      entries.push({
        kind: "worker",
        key: `${link.ref}:settled`,
        at: link.settledAt_ms,
        phase: "settled",
        link,
      });
  }
  return entries.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

export function isBotItemWorkerFailed(link: Extract<BotItemLink, { kind: "dispatch" }>): boolean {
  return link.state === "failed" || link.state === "stopped";
}

// ── Needs you ───────────────────────────────────────────────────────────────────────────────────

export type BotNeedsYouFoldRow =
  | { key: string; kind: "approval" | "question" | "connector"; need: BotNeedsYouRow }
  | { key: string; kind: "item"; item: BotItem };

/** The rows the fold orders: the asks (not their item rows), then the Needs you items. */
export function botNeedsYouRows(
  asks: readonly BotNeedsYouRow[],
  items: readonly BotItem[],
): BotNeedsYouFoldRow[] {
  return [
    ...asks.flatMap((need): BotNeedsYouFoldRow[] =>
      need.kind === "item" ? [] : [{ key: need.key, kind: need.kind, need }],
    ),
    ...items.map((item): BotNeedsYouFoldRow => ({ key: `item:${item.id}`, kind: "item", item })),
  ];
}
