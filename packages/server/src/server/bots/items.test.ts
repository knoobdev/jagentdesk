import { describe, expect, it } from "vitest";
import type { BotItem } from "@jagentdesk/protocol/bots/types";
import {
  BOT_ITEM_SNOOZE_MAX_MS,
  botItemGroupOf,
  groupBotItems,
  isBotItemStale,
  needsYouFold,
} from "@jagentdesk/protocol/bots/rules";
import {
  assertReviewAllowsDone,
  assertSnooze,
  assertTransition,
  journalLine,
  patchItem,
  withAsk,
  withStatus,
} from "./items.js";

const DAY = 24 * 60 * 60_000;
const item: BotItem = {
  id: "i",
  uid: "i",
  number: 4,
  botId: "b",
  title: "Fix the retry counter",
  doneMeans: "Tests pass",
  status: "working",
  workerAgentIds: ["w"],
  comments: [],
  reviewRounds: 0,
  reviews: [],
  links: [],
  createdAt_ms: 0,
  updatedAt_ms: 0,
  lastActivityAt_ms: 0,
};

describe("item state machine", () => {
  it("needs a wait text, keeps quick replies in range, and clears the wait on resume", () => {
    expect(() => patchItem(item, { status: "waiting" }, 1)).toThrow("Waiting needs");
    expect(() =>
      patchItem(
        item,
        { status: "needs_you", questions: [{ text: "Which?", options: ["A"], recommended: 1 }] },
        1,
      ),
    ).toThrow("out of range");
    const waiting = patchItem(
      item,
      { status: "waiting", waitFor: { condition: "CI", until_ms: 1000 } },
      1,
    );
    expect(waiting.wait).toEqual({ text: "CI", at_ms: 1 });
    const resumed = patchItem(waiting, { status: "working" }, 2);
    expect(resumed.waitFor).toBeUndefined();
    expect(resumed.wait).toBeUndefined();
  });

  it("closes items for the bot, and lets only the owner reopen one", () => {
    const done = withStatus(item, "done", 5);
    expect(done.closedAt_ms).toBe(5);
    expect(() => assertTransition(done, "working", "bot")).toThrow("Item is closed");
    expect(() => assertTransition(done, "working", "owner")).not.toThrow();
    expect(() => assertTransition(done, "waiting", "owner")).toThrow();
  });

  it("refuses done with review_pending while Review before done has not passed", () => {
    expect(() => assertReviewAllowsDone(item, false)).not.toThrow();
    expect(() => assertReviewAllowsDone(item, true)).toThrow("Waiting for review");
    expect(() =>
      assertReviewAllowsDone({ ...item, review: { state: "passed", round: 1 } }, true),
    ).not.toThrow();
    expect(() => assertReviewAllowsDone({ ...item, workerAgentIds: [] }, true)).not.toThrow();
  });

  it("records an ask as decisions and as round-1 questions", () => {
    const asked = withAsk(
      item,
      {
        context: "Two ways to fix it.",
        questions: [
          {
            prompt: "Reset on success or on timeout?",
            options: [{ label: "On success" }, { label: "On timeout" }],
            recommended: 0,
          },
          { prompt: "Add a test?", options: [{ label: "Yes" }, { label: "No" }] },
        ],
      },
      "e1",
    );
    expect(asked.status).toBe("needs_you");
    expect(asked.question?.decisions?.[0]?.recommended).toBe(0);
    expect(asked.questions?.map((q) => q.text)).toEqual([
      "Reset on success or on timeout?",
      "Add a test?",
    ]);
    expect(() =>
      withAsk(
        item,
        { questions: [{ prompt: "Same?", options: [{ label: "A" }, { label: "A" }] }] },
        "e",
      ),
    ).toThrow("own label");
  });

  it("caps a snooze at 366 days and refuses one in the past", () => {
    expect(() => assertSnooze(10, 20)).toThrow();
    expect(() => assertSnooze(20 + BOT_ITEM_SNOOZE_MAX_MS + 1, 20)).toThrow("366");
    expect(() => assertSnooze(null, 20)).not.toThrow();
  });

  it("writes one journal line per closed item", () => {
    const at = new Date(2026, 10, 27, 12).getTime();
    expect(
      journalLine({ ...item, status: "done", links: [{ kind: "pr", ref: "o/r#12" }] }, at),
    ).toEqual({
      file: "2026-11.md",
      line: "- 2026-11-27 | item #4 | done, o/r#12 | Fix the retry counter",
    });
  });
});

describe("shared rules", () => {
  it("derives Stale and Snoozed groups from activity and the bot's days", () => {
    const now = 10 * DAY;
    const needsYou: BotItem = { ...item, status: "needs_you", lastActivityAt_ms: now - 3 * DAY };
    expect(isBotItemStale(needsYou, 3, now)).toBe(true);
    expect(isBotItemStale(needsYou, 5, now)).toBe(false);
    expect(isBotItemStale(needsYou, null, now)).toBe(false);
    const live: BotItem = {
      ...needsYou,
      status: "working",
      links: [
        {
          kind: "dispatch",
          ref: "w",
          title: null,
          state: "working",
          startedAt_ms: 0,
          settledAt_ms: null,
          report: null,
        },
      ],
    };
    expect(isBotItemStale(live, 3, now)).toBe(false);
    const planned: BotItem = { ...item, status: "planned", lastActivityAt_ms: now - 6 * DAY };
    expect(isBotItemStale(planned, 3, now)).toBe(false);
    expect(botItemGroupOf({ ...needsYou, snoozedUntil_ms: now + DAY }, 3, now)).toBe("snoozed");
    const groups = groupBotItems([needsYou, planned, { ...item, status: "done" }], 3, now);
    expect(groups.stale.map((i) => i.status)).toEqual(["needs_you"]);
    expect(groups.planned).toHaveLength(1);
    expect(groups.closed).toHaveLength(1);
  });

  it("folds Needs you: approvals never hidden, five rows, no footer for one", () => {
    const rows = (approvals: number, others: number) => [
      ...Array.from({ length: others }, (_, i) => ({ key: `i${i}`, kind: "item" })),
      ...Array.from({ length: approvals }, (_, i) => ({ key: `a${i}`, kind: "approval" })),
    ];
    const seven = needsYouFold(rows(7, 3), { expanded: false });
    expect(seven.visible).toHaveLength(7);
    expect(seven.hidden).toBe(3);
    expect(seven.ordered[0]?.kind).toBe("approval");
    expect(needsYouFold(rows(0, 6), { expanded: false }).hidden).toBe(0);
    const many = needsYouFold(rows(0, 7), { expanded: false });
    expect(many.visible).toHaveLength(5);
    expect(many.hidden).toBe(2);
  });
});
