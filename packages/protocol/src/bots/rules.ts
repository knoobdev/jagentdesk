// Pure bot rules shared by the daemon, desktop and phone, ported from Orca dfdb4fda (MIT,
// Copyright (c) 2026 Lovecast Inc.): src/shared/bot-avatar.ts:4-35, bots/bot-avatar-color.ts:8-20,
// bots/bot-avatar-outfit.ts:5-15, bots/bot-items.ts:6-24,272-345, bots/bot-item-groups.ts:15-35,
// bots/bot-item-snooze.ts:5, bots/needs-you-fold.ts, bots/bot-look-around.ts:10-50,
// bots/bot-tidy-up.ts:7-21, bot-types.ts:395-410. Times are Unix milliseconds.
import type { Bot, BotItem, BotItemStatus, BotItemsStale, LookAroundEvery } from "./types.js";

export const BOT_MASCOT_IDS = [
  "A1",
  "B1",
  "D1",
  "E1",
  "F1",
  "G1",
  "H1",
  "H2",
  "I1",
  "J1",
  "K2",
  "L2",
  "M1",
  "N1",
  "O1",
  "P3",
  "Q1",
  "R3",
  "S2",
  "T1",
] as const;
export type BotMascotId = (typeof BOT_MASCOT_IDS)[number];
/** Retired from the picker; a bot that already has one keeps it. */
const RETIRED_BOT_MASCOT_IDS: ReadonlySet<BotMascotId> = new Set(["S2"]);
/** The 19 mascots a new picture is picked from, in carousel order. */
export const PICKABLE_BOT_MASCOT_IDS = BOT_MASCOT_IDS.filter(
  (id) => !RETIRED_BOT_MASCOT_IDS.has(id),
);
/** Mascots shown on the empty Bots section card (spec 37.4.1). */
export const BOT_EMPTY_STATE_MASCOTS: readonly BotMascotId[] = ["A1", "E1", "M1"];

export const DEFAULT_BOT_AVATAR_COLOR = "#b3dbf4";
/** The picker's swatches, the default first. */
export const BOT_AVATAR_COLORS = [
  DEFAULT_BOT_AVATAR_COLOR,
  "#ffffff",
  "#c9b8e8",
  "#f4c4cf",
  "#f8cfa8",
  "#f6e3a1",
  "#c5dfb5",
  "#b5e3d8",
  "#8fa3b8",
  "#3a3f4b",
  "#1f2126",
] as const;
/** In the picker's order; ids are never renamed, since bots store them. */
export const BOT_AVATAR_OUTFITS = [
  "tie",
  "detective",
  "hard-hat",
  "reviewer",
  "night-shift",
  "artist",
  "scientist",
  "party",
  "security",
] as const;
/** Uploads: square PNG, 512 to 2000 px, at most 2 MB. */
export const BOT_AVATAR_UPLOAD = {
  minSize: 512,
  maxSize: 2000,
  maxBytes: 2 * 1024 * 1024,
} as const;

export const BOT_NAME_MAX_LENGTH = 64;
/** The New bot dialog's Identity cap; its counter shows from 160 characters (spec 37.5). */
export const BOT_IDENTITY_MAX_LENGTH = 200;
export const BOT_IDENTITY_COUNTER_FROM = 160;
export const BOT_MEMORY_INDEX_LINE_CAP = 200;

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/;
/** `bot-types.ts:395-410`: the folder slug a name asks for, before `-2`, `-3`… suffixes. */
export function botFolderName(botName: string): string {
  const slug = botName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  if (!slug) return "bot";
  return WINDOWS_RESERVED_NAME.test(slug) ? `${slug}-bot` : slug;
}

export const BOT_ITEM_OPEN_STATUSES: readonly BotItemStatus[] = [
  "planned",
  "working",
  "waiting",
  "needs_you",
];
export function isOpenBotItemStatus(status: BotItemStatus): boolean {
  return BOT_ITEM_OPEN_STATUSES.includes(status);
}
/** UI labels (`bots.items.status.*`). */
export const BOT_ITEM_STATUS_LABELS: Record<BotItemStatus, string> = {
  planned: "Planned",
  working: "In progress",
  waiting: "Waiting",
  needs_you: "Needs you",
  done: "Done",
  canceled: "Canceled",
};
export const BOT_ITEM_LIMITS = {
  title: 200,
  description: 20_000,
  doneMeans: 2_000,
  text: 8_000,
  wait: 200,
  links: 50,
} as const;
export const BOT_ITEM_ASK_LIMITS = { questions: 5, options: 8 } as const;
export const BOT_ITEM_SNOOZE_MAX_MS = 366 * 24 * 60 * 60_000;
export const BOT_ITEM_DEFAULT_STALE_DAYS = 5;
/** Planned items wait this many times longer before they are stale. */
export const BOT_ITEM_PLANNED_STALE_FACTOR = 3;
const DAY_MS = 24 * 60 * 60_000;

/** The bot's stale setting in days; null: never. */
export function botItemStaleDays(stale: BotItemsStale | undefined): number | null {
  return stale === "never" ? null : (stale ?? BOT_ITEM_DEFAULT_STALE_DAYS);
}

type ItemClock = Pick<BotItem, "status" | "snoozedUntil_ms" | "lastActivityAt_ms" | "updatedAt_ms">;
function lastActivity(item: ItemClock): number {
  return item.lastActivityAt_ms ?? item.updatedAt_ms;
}
/** Snoozed is derived, never a status: an open item whose wake time hasn't come. */
export function isBotItemSnoozed(item: ItemClock, now: number): boolean {
  return (
    isOpenBotItemStatus(item.status) &&
    item.snoozedUntil_ms !== undefined &&
    item.snoozedUntil_ms > now
  );
}
/** Last activity, or the time it came back from a snooze when that is later. */
export function botItemActivityAt(item: ItemClock, now: number): number {
  return item.snoozedUntil_ms !== undefined && item.snoozedUntil_ms <= now
    ? Math.max(lastActivity(item), item.snoozedUntil_ms)
    : lastActivity(item);
}
function hasLiveWorker(item: Pick<BotItem, "links">): boolean {
  return (item.links ?? []).some(
    (link) => link.kind === "dispatch" && (link.state === "working" || link.state === "unknown"),
  );
}
/**
 * Stale is derived, never a status: Needs you, or In progress or Waiting with no live linked worker,
 * untouched for the bot's stale days; Planned for three times that. A snoozed item is not stale.
 */
export function isBotItemStale(
  item: ItemClock & Pick<BotItem, "links">,
  staleDays: number | null,
  now: number,
): boolean {
  if (staleDays === null || isBotItemSnoozed(item, now)) return false;
  const idle = now - botItemActivityAt(item, now);
  switch (item.status) {
    case "needs_you":
      return idle >= staleDays * DAY_MS;
    case "working":
    case "waiting":
      return idle >= staleDays * DAY_MS && !hasLiveWorker(item);
    case "planned":
      return idle >= staleDays * BOT_ITEM_PLANNED_STALE_FACTOR * DAY_MS;
    case "done":
    case "canceled":
      return false;
  }
}

/** Rows a group shows before "Show {{count}} more". */
export const BOT_ITEM_GROUP_ROWS = 5;
export const BOT_ITEM_GROUP_IDS = [
  "needs_you",
  "working",
  "waiting",
  "planned",
  "snoozed",
  "stale",
  "closed",
] as const;
export type BotItemGroupId = (typeof BOT_ITEM_GROUP_IDS)[number];
export const BOT_ITEM_GROUPS_FOLDED_BY_DEFAULT: ReadonlySet<BotItemGroupId> = new Set([
  "planned",
  "snoozed",
  "stale",
  "closed",
]);
export function botItemGroupOf(
  item: BotItem,
  staleDays: number | null,
  now: number,
): BotItemGroupId {
  if (item.status === "done" || item.status === "canceled") return "closed";
  if (isBotItemSnoozed(item, now)) return "snoozed";
  return isBotItemStale(item, staleDays, now) ? "stale" : item.status;
}
/** Items by group; rows newest activity first, Snoozed soonest back first. */
export function groupBotItems(
  items: readonly BotItem[],
  staleDays: number | null,
  now: number,
): Record<BotItemGroupId, BotItem[]> {
  const groups: Record<BotItemGroupId, BotItem[]> = {
    needs_you: [],
    working: [],
    waiting: [],
    planned: [],
    snoozed: [],
    stale: [],
    closed: [],
  };
  for (const item of items) groups[botItemGroupOf(item, staleDays, now)].push(item);
  for (const [id, rows] of Object.entries(groups)) {
    rows.sort(
      id === "snoozed"
        ? (a, b) =>
            (a.snoozedUntil_ms ?? 0) - (b.snoozedUntil_ms ?? 0) || (b.number ?? 0) - (a.number ?? 0)
        : (a, b) =>
            botItemActivityAt(b, now) - botItemActivityAt(a, now) ||
            (b.number ?? 0) - (a.number ?? 0),
    );
  }
  return groups;
}

/** Which Needs you rows show: approvals first and never hidden, then the first five, then a footer. */
export const NEEDS_YOU_CAP = 5;
export function needsYouFold<Row extends { key: string; kind: string }>(
  rows: readonly Row[],
  { expanded, focusedKey = null }: { expanded: boolean; focusedKey?: string | null },
): { ordered: Row[]; visible: string[]; hidden: number; folds: boolean } {
  const approvals = rows.filter((row) => row.kind === "approval");
  const ordered = [...approvals, ...rows.filter((row) => row.kind !== "approval")];
  const shown = Math.max(NEEDS_YOU_CAP, approvals.length);
  // One hidden row isn't worth a footer.
  const folds = ordered.length - shown >= 2;
  const visible = ordered
    .filter((row, index) => !folds || expanded || index < shown || row.key === focusedKey)
    .map((row) => row.key);
  return { ordered, visible, hidden: ordered.length - visible.length, folds };
}

/** Look around and Tidy memory run only on these providers (`bot-look-around.ts:10`). */
export const LOOK_AROUND_PROVIDERS = ["claude", "codex"] as const;
export function lookAroundSupported(provider: string): boolean {
  return LOOK_AROUND_PROVIDERS.some((entry) => entry === provider);
}
/** Local hours each preset looks at; nothing runs at night. */
export const LOOK_AROUND_EVERY: Record<LookAroundEvery, readonly number[]> = {
  "every-4h": [8, 12, 16, 20],
  "every-2h": [8, 10, 12, 14, 16, 18, 20],
  "twice-daily": [8, 13],
  mornings: [8],
};
export const LOOK_AROUND_EVERY_LABELS: Record<LookAroundEvery, string> = {
  "every-4h": "Every 4 hours, 8 AM to 8 PM",
  "every-2h": "Every 2 hours, 8 AM to 8 PM",
  "twice-daily": "Twice a day, 8 AM and 1 PM",
  mornings: "Each morning at 8 AM",
};
export const LOOK_AROUND_LIMITS = {
  perRun: 5,
  dismissHiddenMs: 30 * DAY_MS,
  timeoutMs: 600_000,
  failuresBeforeOff: 10,
  /** The host must be awake this long after a wake before a background run starts. */
  awakeMs: 120_000,
} as const;
export const TIDY_UP_EVERY_LABELS = {
  night: "Each night after 3 AM",
  week: "Once a week, after 3 AM",
} as const;
/** Local hours a tidy-up starts in; a host asleep through them catches up when awake. */
export const TIDY_UP_HOURS = { from: 3, until: 8 } as const;
export const TIDY_UP_LIMITS = {
  timeoutMs: 600_000,
  targetFacts: 60,
  failuresBeforeOff: 10,
} as const;

/** Look around as a bot has it (defaults: on, every 4 hours, weekdays only). */
export function botLookAround(bot: Pick<Bot, "lookAround">): {
  on: boolean;
  every: LookAroundEvery;
  weekdaysOnly: boolean;
  focus: string;
} {
  return {
    on: bot.lookAround.on ?? bot.lookAround.enabled,
    every: bot.lookAround.every ?? "every-4h",
    weekdaysOnly: bot.lookAround.weekdaysOnly ?? true,
    focus: bot.lookAround.focus ?? "",
  };
}
