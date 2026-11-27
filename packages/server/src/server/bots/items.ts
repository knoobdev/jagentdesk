// Item rules, after Orca dfdb4fda (MIT): src/shared/bots/bot-items.ts, bot-item-ask.ts,
// src/main/bots/bot-memory-journal.ts:1-55. The store keeps the record; these are pure.
import { randomUUID } from "node:crypto";
import type {
  BotItem,
  BotItemAsk,
  BotItemLink,
  BotItemPatch,
  BotItemStatus,
} from "@jagentdesk/protocol/bots/types";
import { BotItemAskSchema, BotItemPatchSchema } from "@jagentdesk/protocol/bots/types";
import { BOT_ITEM_SNOOZE_MAX_MS, isOpenBotItemStatus } from "@jagentdesk/protocol/bots/rules";
import { BotsError } from "./home.js";

export type ItemActorKind = "bot" | "owner" | "daemon";

/** Moves a bot may make. The owner may also reopen a closed item ("Move to"). */
const TRANSITIONS: Record<BotItemStatus, readonly BotItemStatus[]> = {
  planned: ["working", "waiting", "needs_you", "done", "canceled"],
  working: ["planned", "waiting", "needs_you", "done", "canceled"],
  waiting: ["planned", "working", "needs_you", "done", "canceled"],
  needs_you: ["planned", "working", "waiting", "done", "canceled"],
  done: [],
  canceled: [],
};

export function assertTransition(item: BotItem, to: BotItemStatus, actor: ItemActorKind): void {
  if (to === item.status) return;
  if (!isOpenBotItemStatus(item.status)) {
    if (actor === "owner" && isOpenBotItemStatus(to) && to !== "waiting") return;
    throw new BotsError("item_closed", "Item is closed");
  }
  if (!TRANSITIONS[item.status].includes(to))
    throw new BotsError("invalid_argument", `Invalid item transition ${item.status} → ${to}`);
}

/** Done is blocked while a Review-before-done item has not passed review (spec 37.3.7 step 5). */
export function assertReviewAllowsDone(item: BotItem, reviewBeforeDone: boolean): void {
  if (!reviewBeforeDone || item.workerAgentIds.length === 0) return;
  if (item.review?.state !== "passed") throw new BotsError("review_pending", "Waiting for review");
}

/** The status change applied to the record; `wait` text is required for Waiting. */
export function withStatus(
  item: BotItem,
  status: BotItemStatus,
  now: number,
  extra: { waitText?: string; closeNote?: string } = {},
): BotItem {
  const closed = status === "done" || status === "canceled";
  const next: BotItem = {
    ...item,
    status,
    lastActivityAt_ms: now,
    ...(closed ? { closedAt_ms: now } : { closedAt_ms: undefined }),
    ...(extra.closeNote ? { closeNote: extra.closeNote } : {}),
  };
  if (status !== "waiting") {
    next.wait = undefined;
    next.waitFor = undefined;
  } else {
    const text = extra.waitText ?? item.wait?.text ?? item.waitFor?.condition;
    if (!text) throw new BotsError("invalid_argument", "Waiting needs what it waits on");
    next.wait = { text, at_ms: now };
  }
  if (status !== "needs_you") {
    next.questions = undefined;
    next.question = undefined;
  }
  if (!closed) next.closeNote = extra.closeNote ?? item.closeNote;
  return next;
}

/** Round-1 `bot_item_set` patch, kept for bots whose sessions still call it. */
export function patchItem(item: BotItem, raw: BotItemPatch, now: number): BotItem {
  const patch = BotItemPatchSchema.parse(raw);
  const status = patch.status ?? item.status;
  if (status === "waiting" && !(patch.waitFor ?? item.waitFor))
    throw new BotsError("invalid_argument", "Waiting needs a condition and wake deadline");
  for (const q of patch.questions ?? []) {
    if (q.recommended !== undefined && q.recommended >= q.options.length)
      throw new BotsError("invalid_argument", "Recommended option is out of range");
  }
  const base: BotItem = {
    ...item,
    ...(patch.title ? { title: patch.title } : {}),
    ...(patch.doneMeans ? { doneMeans: patch.doneMeans } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.waitFor ? { waitFor: patch.waitFor } : {}),
  };
  const next = withStatus(base, status, now, { waitText: patch.waitFor?.condition });
  if (status === "needs_you" && patch.questions?.length) {
    return withAsk(
      next,
      {
        questions: patch.questions.map((q) => decisionOf(q.text, q.options, q.recommended)),
      },
      randomUUID(),
    );
  }
  return next;
}

function decisionOf(prompt: string, labels: readonly string[], recommended: number | undefined) {
  const decision: BotItemAsk["questions"][number] = {
    prompt,
    options: labels.map((label) => ({ label })),
  };
  if (recommended !== undefined) decision.recommended = recommended;
  return decision;
}

function round1Question(text: string, options: string[], recommended: number | undefined) {
  const question: NonNullable<BotItem["questions"]>[number] = { text, options };
  if (recommended !== undefined) question.recommended = recommended;
  return question;
}

/** `bot-item-ask.ts`: an ask is one comment with up to 5 decisions of up to 8 quick replies. */
export function withAsk(item: BotItem, raw: BotItemAsk, eventId: string): BotItem {
  const ask = BotItemAskSchema.parse(raw);
  for (const q of ask.questions) {
    if (q.recommended !== undefined && q.recommended >= q.options.length)
      throw new BotsError("invalid_argument", "The recommended option is not one of its options.");
    if (new Set(q.options.map((o) => o.label)).size !== q.options.length)
      throw new BotsError("invalid_argument", "Each option of a decision needs its own label.");
  }
  if (new Set(ask.questions.map((q) => q.prompt)).size !== ask.questions.length)
    throw new BotsError("invalid_argument", "Each decision needs its own question.");
  return {
    ...item,
    status: "needs_you",
    question: { eventId, text: ask.context ?? "", decisions: ask.questions },
    // COMPAT(botsRound1Questions): round-1 apps answer `questions` by index.
    questions: ask.questions.map((q) =>
      round1Question(
        q.prompt,
        q.options.map((o) => o.label),
        q.recommended,
      ),
    ),
  };
}

export function commentItem(item: BotItem, text: string, author: string, now: number): BotItem {
  if (!text.trim() || text.length > 40000)
    throw new BotsError("invalid_argument", "Comment must contain 1–40000 characters");
  return {
    ...item,
    lastActivityAt_ms: now,
    comments: [...item.comments, { id: randomUUID(), text, author, createdAt_ms: now }],
  };
}

export function withLink(item: BotItem, link: BotItemLink): BotItem {
  const links = item.links ?? [];
  if (links.some((entry) => entry.kind === link.kind && entry.ref === link.ref)) {
    return {
      ...item,
      links: links.map((entry) =>
        entry.kind === link.kind && entry.ref === link.ref ? link : entry,
      ),
    };
  }
  if (links.length >= 50) throw new BotsError("invalid_argument", "An item takes up to 50 links");
  return { ...item, links: [...links, link] };
}

export function assertSnooze(until: number | null, now: number): void {
  if (until === null) return;
  if (until <= now) throw new BotsError("invalid_argument", "Snooze until a time ahead");
  if (until > now + BOT_ITEM_SNOOZE_MAX_MS)
    throw new BotsError("invalid_argument", "Snooze at most 366 days");
}

/** `owner/repo#n` for a GitHub pull request URL; null for anything else. */
export function prRefOfUrl(url: string): string | null {
  const match = /^https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(
    url.trim(),
  );
  return match ? `${match[1]}#${match[2]}` : null;
}

function localDate(now: number): { day: string; month: string } {
  const date = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const month = `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  return { month, day: `${month}-${pad(date.getDate())}` };
}

/**
 * `main/bots/bot-memory-journal.ts`: the line a closed item leaves in `memory/journal/YYYY-MM.md`,
 * written by the daemon without a model call.
 */
export function journalLine(item: BotItem, now: number): { file: string; line: string } {
  const { day, month } = localDate(now);
  const pr = (item.links ?? []).find((link) => link.kind === "pr");
  const status = item.status === "done" ? "done" : "canceled";
  const what = pr ? `${status}, ${pr.ref}` : status;
  const title = item.title.replace(/\s+/g, " ").trim();
  return { file: `${month}.md`, line: `- ${day} | item #${item.number ?? 0} | ${what} | ${title}` };
}
