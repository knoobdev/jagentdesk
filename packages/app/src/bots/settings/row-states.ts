// Row states and lines of a bot's settings. Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/bot-settings-row-states.ts:1-140,
// src/shared/bots/bot-settings-row-lines.ts:1-80 and src/shared/bots/bot-memory-history-copy.ts:1-120,
// src/renderer/src/components/settings/bots/BotMemoryHistory.tsx:17-28 (day labels),
// BotSoulEditor.tsx:166-167 (stats). Pure: each takes the caller's translate.
import type { LookAroundEvery, TidyUpEvery } from "@jagentdesk/protocol/bots/types";
import type { BotMemoryHistoryRow } from "@jagentdesk/protocol/bots/views";

export type Translate = (key: string, values?: Record<string, unknown>) => string;

const DAY_MS = 24 * 60 * 60 * 1000;

export const LOOK_AROUND_EVERY_CHOICES: readonly LookAroundEvery[] = [
  "every-4h",
  "every-2h",
  "twice-daily",
  "mornings",
];
export const TIDY_UP_EVERY_CHOICES: readonly TidyUpEvery[] = ["night", "week"];
export const ITEMS_STALE_CHOICES = [3, 5, 7, 14, "never"] as const;

const LOOK_AROUND_KEY: Record<LookAroundEvery, string> = {
  "every-4h": "every4h",
  "every-2h": "every2h",
  "twice-daily": "twiceDaily",
  mornings: "mornings",
};

/** "Every 4 hours, 8 AM to 8 PM" (`bots.lookAroundEvery.*`). */
export function lookAroundEveryLabel(every: LookAroundEvery, t: Translate): string {
  return t(`bots.lookAroundEvery.${LOOK_AROUND_KEY[every]}`);
}

/** "Each night after 3 AM" / "Once a week, after 3 AM". */
export function tidyUpEveryLabel(every: TidyUpEvery, t: Translate): string {
  return every === "night"
    ? t("bots.settingsBots.tidyUp.everyNight")
    : t("bots.settingsBots.tidyUp.everyWeek");
}

/** "4h"; null while it is off, as its switch says. */
export function lookAroundValue(
  setting: { on: boolean; every: LookAroundEvery },
  t: Translate,
): string | null {
  return setting.on
    ? t(`bots.settingsView.lookAroundShort.${LOOK_AROUND_KEY[setting.every]}`)
    : null;
}

/** "Nightly" or "Weekly"; null while it is off. */
export function tidyUpValue(
  setting: { on: boolean; every: TidyUpEvery },
  t: Translate,
): string | null {
  if (!setting.on) return null;
  return setting.every === "night"
    ? t("bots.settingsView.tidyUpShort.night")
    : t("bots.settingsView.tidyUpShort.week");
}

/** A count, or "None". */
export function countValue(count: number, t: Translate): string {
  return count > 0 ? String(count) : t("bots.settingsPage.none");
}

/** "Only you", "You and 4 others". */
export function whoCanAskValue(people: number, t: Translate): string {
  return people > 0
    ? t("bots.settingsView.youAndOthers", { count: people })
    : t("bots.settingsPage.onlyYou");
}

export type LookedDay = "today" | "yesterday" | "earlier";

/** `shared/bots/bot-look-around.ts` lookedDay: which day `at` was, as of `now`, in local time. */
export function lookedDay(at: number, now: number): LookedDay {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (at >= start) return "today";
  return at >= start - DAY_MS ? "yesterday" : "earlier";
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

function format(at: number, options: Intl.DateTimeFormatOptions, locale?: string): string {
  return new Intl.DateTimeFormat(locale, options).format(at);
}

/** "Every 4 hours, 8 AM to 8 PM · last looked 12:04 PM", "Off". */
export function lookAroundLine(
  setting: { on: boolean; every: LookAroundEvery },
  lastLookedAt: number | undefined,
  t: Translate,
  now = Date.now(),
  locale?: string,
): string {
  if (!setting.on) return t("bots.settingsPage.off");
  const every = lookAroundEveryLabel(setting.every, t);
  if (!lastLookedAt) return every;
  const day = lookedDay(lastLookedAt, now);
  const time = format(lastLookedAt, CLOCK, locale);
  let when = time;
  if (day === "yesterday") when = t("bots.settingsPage.yesterdayAt", { time });
  else if (day === "earlier") when = format(lastLookedAt, DATE, locale);
  return `${every} · ${t("bots.settingsPage.lastLooked", { when })}`;
}

/** "Each night after 3 AM, or once this computer is awake · last tidied today", "Off". */
export function tidyUpLine(
  setting: { on: boolean; every: TidyUpEvery },
  lastTidiedAt: number | undefined,
  t: Translate,
  now = Date.now(),
  locale?: string,
): string {
  if (!setting.on) return t("bots.settingsPage.off");
  const every =
    setting.every === "night"
      ? t("bots.settingsBots.tidyUp.everyNightLine")
      : t("bots.settingsBots.tidyUp.everyWeekLine");
  if (!lastTidiedAt) return every;
  const day = lookedDay(lastTidiedAt, now);
  let when = format(lastTidiedAt, DATE, locale);
  if (day === "today") when = t("bots.settingsPage.today");
  else if (day === "yesterday") when = t("bots.settingsPage.yesterday");
  return `${every} · ${t("bots.settingsPage.lastTidied", { when })}`;
}

/** "Today, 12:04 PM" style stamp for a run (`formatAutomationDateTime`). */
export function runStamp(at: number, locale?: string): string {
  return format(at, { ...DATE, ...CLOCK }, locale);
}

/** The minutes a run took, at least one. */
export function runMinutes(tookMs: number): number {
  return Math.max(1, Math.round(tookMs / 60_000));
}

/** `BotSoulEditor.tsx:166-167`: lines and words of the draft. */
export function soulStats(text: string): { lines: number; words: number } {
  return {
    lines: text ? text.split("\n").length : 0,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
  };
}

/** "Today", "Yesterday", then "Nov 14" (`BotMemoryHistory.tsx:17-28`). */
export function historyDayLabel(at: number, now: number, t: Translate, locale?: string): string {
  const day = lookedDay(at, now);
  if (day === "today") return t("bots.settingsBots.memoryHistory.today");
  if (day === "yesterday") return t("bots.settingsBots.memoryHistory.yesterday");
  return format(at, DATE, locale);
}

/** Rows (newest first) grouped by the day they were made, in order. */
export function groupHistoryByDay(
  rows: readonly BotMemoryHistoryRow[],
  now: number,
  t: Translate,
  locale?: string,
): { day: string; rows: BotMemoryHistoryRow[] }[] {
  const groups: { day: string; rows: BotMemoryHistoryRow[] }[] = [];
  for (const row of rows) {
    const day = historyDayLabel(row.at_ms, now, t, locale);
    const last = groups.at(-1);
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

export type MemoryHistoryKind = "tidy-up" | "undo" | "edit" | "forget" | "add";

export function memoryHistoryKind({ by, change }: BotMemoryHistoryRow): MemoryHistoryKind {
  if (by.kind === "tidy-up") return "tidy-up";
  if (by.kind === "undo" || by.kind === "kept") return "undo";
  if (change.added.length > 0 && change.removed.length > 0) return "edit";
  return change.removed.length > 0 ? "forget" : "add";
}

const DATED_TEXT = /^(\d{4}-\d{2}-\d{2})(?:\s*[:–—-]\s*|\s+)(.*)$/;
const SOURCE_SEPARATOR = " · from: ";

/** The line without its bullet, for the opened change. */
export function memoryHistoryLine(line: string): string {
  return line.replace(/^\s*[-*]\s+/, "").trim();
}

/** The fact's words: no bullet, date or source (`bot-memory-lines.ts` factParts). */
export function memoryFactText(line: string): string {
  const body = memoryHistoryLine(line);
  const dated = DATED_TEXT.exec(body);
  const text = dated ? dated[2].trim() : body;
  const at = text.lastIndexOf(SOURCE_SEPARATOR);
  return at > 0 ? text.slice(0, at).trim() : text;
}

/** What changed, in a few words. */
export function memoryHistorySummary(t: Translate, { by, change }: BotMemoryHistoryRow): string {
  const { added, removed } = change;
  if (by.kind === "tidy-up") {
    return t("bots.settingsBots.memoryHistory.tidied", { count: added.length + removed.length });
  }
  if (by.kind === "kept") {
    return added.length === 1
      ? t("bots.settingsBots.memoryHistory.keptOne")
      : t("bots.settingsBots.memoryHistory.keptMany", { count: added.length });
  }
  if (added.length === 1 && removed.length <= 1) {
    const fact = memoryFactText(added[0].line);
    return removed.length === 0
      ? t("bots.settingsBots.memoryHistory.added", { fact })
      : t("bots.settingsBots.memoryHistory.edited", { fact });
  }
  if (added.length === 0 && removed.length === 1) {
    return t("bots.settingsBots.memoryHistory.forgot", { fact: memoryFactText(removed[0].line) });
  }
  if (removed.length === 0) {
    return t("bots.settingsBots.memoryHistory.addedMany", { count: added.length });
  }
  return added.length === 0
    ? t("bots.settingsBots.memoryHistory.forgotMany", { count: removed.length })
    : t("bots.settingsBots.memoryHistory.changedMany", { count: added.length + removed.length });
}

function memoryAuthorOf(t: Translate, { by }: BotMemoryHistoryRow): string {
  const title = by.kind === "chat" ? by.title : undefined;
  const named = title
    ? t("bots.settingsBots.memoryHistory.chat", { title })
    : t("bots.settingsBots.memoryHistory.aChat");
  switch (by.kind) {
    case "chat":
      return named;
    case "kept":
      return t("bots.settingsBots.memoryHistory.kept", { chat: named });
    case "owner":
      return t("bots.settingsBots.memoryHistory.owner");
    case "bot":
      return t("bots.settingsBots.memoryHistory.bot", { chat: named });
    case "undo":
      return t("bots.settingsBots.memoryHistory.undo");
    case "tidy-up":
      return t("bots.settingsBots.memoryHistory.tidyUp");
  }
}

/** Who made it, and whether it can be undone. */
export function memoryHistoryAuthor(t: Translate, row: BotMemoryHistoryRow): string {
  const author = memoryAuthorOf(t, row);
  return row.undoable ? author : t("bots.settingsBots.memoryHistory.secret", { author });
}

/** A mode that runs tools without asking (spec 37.3.3): the provider marks it dangerous. */
export function isBypassMode(mode: { colorTier?: string } | undefined): boolean {
  return mode?.colorTier === "dangerous";
}
