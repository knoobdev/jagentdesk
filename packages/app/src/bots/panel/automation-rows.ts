// The Automations card's order and words, ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/bot-automation-card.ts:12,131-158 (rank, cap),
// bot-upcoming-copy.ts:13-81 (when it runs) and BotUpcomingRows.tsx:150-160 (row state).
import type { BotAutomation } from "@jagentdesk/protocol/bots/views";

/** Automations the card lists before "All {{count}} automations"; Look around and Tidy memory always show. */
export const AUTOMATION_CARD_CAP = 5;

function rank(row: BotAutomation): number {
  if (row.state === "failed") return 0;
  if (row.state === "running") return 1;
  if (!row.enabled) return 4;
  return row.nextAt_ms === undefined ? 3 : 2;
}

/** Failed, running, then soonest next; rows with no next keep their order, paused ones last. */
export function rankAutomationRows(rows: readonly BotAutomation[]): BotAutomation[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort(
      (a, b) =>
        rank(a.row) - rank(b.row) ||
        (a.row.nextAt_ms ?? Infinity) - (b.row.nextAt_ms ?? Infinity) ||
        a.index - b.index,
    )
    .map(({ row }) => row);
}

/** The built-ins (outside the cap), then the first five of the rest. */
export function automationCardView(rows: readonly BotAutomation[]): {
  shown: BotAutomation[];
  listed: number;
} {
  const ranked = rankAutomationRows(rows);
  const builtIn = ranked.filter((row) => row.kind === "look_around" || row.kind === "tidy_up");
  const listedRows = ranked.filter((row) => row.kind !== "look_around" && row.kind !== "tidy_up");
  return {
    shown: [...builtIn, ...listedRows.slice(0, AUTOMATION_CARD_CAP)],
    listed: listedRows.length,
  };
}

export type AutomationRowState = "failed" | "running" | "stopped" | "paused" | null;

export function automationRowState(row: BotAutomation): AutomationRowState {
  if (row.state === "failed") return "failed";
  if (row.state === "running") return "running";
  if (row.state === "stopped") return "stopped";
  return row.enabled ? null : "paused";
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** `lookedDay` of `bot-look-around.ts`: today, yesterday, or earlier, by the local calendar. */
export function lookedDay(at: number, now: number): "today" | "yesterday" | "earlier" {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS);
  if (days === 0) return "today";
  return days === 1 ? "yesterday" : "earlier";
}

type Translate = (key: string, values?: Record<string, unknown>) => string;

const CLOCK: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

/** "Today at 4:00 PM", "Tomorrow at 9:00 AM", then the day: "Fri 5 PM", "Nov 14, 5 PM". */
export function upcomingAt(t: Translate, at: number, now: number): string {
  const time = new Intl.DateTimeFormat(undefined, CLOCK).format(at);
  if (lookedDay(at, now) === "today") return t("bots.upcoming.today", { time });
  if (lookedDay(now, at) === "yesterday") return t("bots.upcoming.tomorrow", { time });
  const options: Intl.DateTimeFormatOptions =
    Math.abs(at - now) < 6 * DAY_MS
      ? { weekday: "short", ...CLOCK }
      : { month: "short", day: "numeric", ...CLOCK };
  return new Intl.DateTimeFormat(undefined, options).format(at);
}

/** "Looked 4:12 PM" today, "Looked yesterday 4:12 PM", then "Looked Oct 29". */
export function lookedText(t: Translate, at: number, now: number): string {
  const day = lookedDay(at, now);
  if (day === "earlier") {
    return t("bots.upNext.looked", {
      time: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at),
    });
  }
  const time = new Intl.DateTimeFormat(undefined, CLOCK).format(at);
  return day === "today"
    ? t("bots.upNext.looked", { time })
    : t("bots.upNext.lookedYesterday", { time });
}

/** The row's second line: when it runs next, or for a wait how long it waits. */
export function automationRowDetail(t: Translate, row: BotAutomation, now: number): string | null {
  if (row.kind === "tidy_up") {
    const from = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(
      new Date(2000, 0, 1, 3),
    );
    return row.when === "week"
      ? t("bots.upcoming.tidyWeekAfter", { from })
      : t("bots.upcoming.tidyNightAfter", { from });
  }
  if (row.kind === "wait") {
    return row.nextAt_ms === undefined
      ? t("bots.waits.noDeadline")
      : t("bots.waits.until", { time: upcomingAt(t, row.nextAt_ms, now) });
  }
  if (row.nextAt_ms !== undefined && row.enabled) {
    return row.nextAt_ms <= now ? t("bots.upcoming.dueNow") : upcomingAt(t, row.nextAt_ms, now);
  }
  return row.when ?? null;
}
