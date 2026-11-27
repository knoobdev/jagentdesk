// A bot row's second line and status mark (spec 37.4.1), ported from Orca dfdb4fda (MIT)
// `src/shared/bots/bot-row-line.ts` selectBotRowLine + botRowLineText: Paused, else what needs the
// owner, else what is replying, else what is working, else what it waits for, else Idle. JAgentDesk
// reads it from the daemon's Needs you rows, chat tree and items instead of Orca's agent rows; an
// agent's own status line ("trạng thái agent tự báo") is not in the bots contract, so it never shows.
import type { TFunction } from "i18next";
import type { BotChatTree } from "@jagentdesk/protocol/bots/views";
import type { BotItem } from "@jagentdesk/protocol/bots/types";

export interface BotRowPlace {
  label: string;
  source: "chat" | "thread";
}
export type BotRowLine =
  | { kind: "paused" }
  | { kind: "replying"; place: BotRowPlace | null }
  | { kind: "needYou"; count: number }
  | { kind: "working"; count: number }
  | { kind: "wait"; label: string; by: number | null; more: number }
  | { kind: "idle" };
export type BotRowMark = "needs_input" | "running" | null;

export interface BotRowLineInput {
  paused: boolean;
  needsYou: number;
  tree: BotChatTree | undefined;
  items: readonly BotItem[] | undefined;
  now: number;
}

/** Workers running and chats replying, across the bot's chats. */
export function botWorkingCount(tree: BotChatTree | undefined): number {
  if (!tree) return 0;
  const chats = [...(tree.home ? [tree.home] : []), ...tree.chats];
  return chats.reduce(
    (total, chat) => total + chat.workers.filter((worker) => worker.state === "running").length,
    0,
  );
}

export function selectBotRowLine(input: BotRowLineInput): BotRowLine {
  if (input.paused) return { kind: "paused" };
  if (input.needsYou > 0) return { kind: "needYou", count: input.needsYou };
  const tree = input.tree;
  if (tree?.home?.live === "replying") return { kind: "replying", place: null };
  const replying = tree?.chats.find((chat) => chat.live === "replying");
  if (replying)
    return {
      kind: "replying",
      place: {
        label: replying.title,
        source: replying.kind === "side" || replying.kind === "automation" ? "chat" : "thread",
      },
    };
  const working = botWorkingCount(tree);
  if (working > 0) return { kind: "working", count: working };
  // A deadline that has passed is the wait's end, not a wait.
  const waits = (input.items ?? []).filter(
    (item) => item.status === "waiting" && item.wait && item.wait.at_ms > input.now,
  );
  const first = waits.length > 0 ? waits[0] : undefined;
  if (first?.wait)
    return { kind: "wait", label: first.wait.text, by: first.wait.at_ms, more: waits.length - 1 };
  return { kind: "idle" };
}

export function botRowMark(line: BotRowLine): BotRowMark {
  if (line.kind === "needYou") return "needs_input";
  if (line.kind === "replying" || line.kind === "working") return "running";
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `botWaitTimeFormat`: "2:14 AM" today, "Fri 5 PM" within the week, "Nov 14, 5 PM" further. */
export function formatBotWaitTime(at: number, now: number): string {
  const date = new Date(at);
  const time: Intl.DateTimeFormatOptions =
    date.getMinutes() === 0 ? { hour: "numeric" } : { hour: "numeric", minute: "2-digit" };
  if (date.toDateString() === new Date(now).toDateString())
    return date.toLocaleTimeString(undefined, time);
  return date.toLocaleString(
    undefined,
    Math.abs(at - now) < 6 * DAY_MS
      ? { weekday: "short", ...time }
      : { month: "short", day: "numeric", ...time },
  );
}

export function botRowLineText(line: BotRowLine, t: TFunction, now: number): string {
  switch (line.kind) {
    case "paused":
      return t("bots.row.paused");
    case "replying":
      if (!line.place) return t("bots.row.replying");
      return line.place.source === "chat"
        ? t("bots.row.replyingIn", { place: line.place.label })
        : t("bots.row.replyingOn", { place: line.place.label });
    case "needYou":
      return t("bots.panel.needYou", { count: line.count });
    case "working":
      return t("bots.panel.working", { count: line.count });
    case "wait":
      if (line.more > 0) return t("bots.row.waitingCount", { count: line.more + 1 });
      return line.by === null
        ? t("bots.row.waitingFor", { label: line.label })
        : t("bots.row.waitingForUntil", {
            label: line.label,
            time: formatBotWaitTime(line.by, now),
          });
    case "idle":
      return t("bots.row.idle");
  }
}
