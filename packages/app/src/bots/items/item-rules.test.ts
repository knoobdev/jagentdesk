import { describe, expect, it } from "vitest";
import type { BotItem, BotItemEvent } from "@jagentdesk/protocol/bots/types";
import { needsYouFold } from "@jagentdesk/protocol/bots/rules";
import type { BotNeedsYouRow } from "@jagentdesk/protocol/bots/views";
import {
  botNeedsYouRows,
  botItemActivity,
  botItemAnswersText,
  botItemChats,
  botItemLinkName,
  botItemLinkedEventName,
  botItemPrNumber,
  botItemQuestionLine,
  botItemSnoozePickerPresets,
  botItemSnoozePresets,
  filterBotItems,
  formatShortTimeAgo,
  isBotItemAwaitingReview,
  isValidBotItemSnooze,
  parseBotItemSnoozeInput,
} from "./item-rules";

function item(patch: Partial<BotItem>): BotItem {
  return {
    id: "i1",
    botId: "b1",
    title: "Fix the flaky test",
    doneMeans: "CI green",
    status: "planned",
    workerAgentIds: [],
    comments: [],
    reviewRounds: 0,
    reviews: [],
    createdAt_ms: 0,
    updatedAt_ms: 0,
    ...patch,
  };
}

describe("snooze presets", () => {
  it("offers Later today at 6 PM before 5 PM, then Tomorrow and Monday at 9 AM", () => {
    const wednesdayNoon = new Date(2026, 10, 25, 12, 0).getTime();
    const [later, tomorrow, monday] = botItemSnoozePresets(wednesdayNoon);
    expect(new Date(later.at).getHours()).toBe(18);
    expect(later.inHours).toBeUndefined();
    expect(new Date(tomorrow.at).getDate()).toBe(26);
    expect(new Date(monday.at).getDay()).toBe(1);
    expect(new Date(monday.at).getHours()).toBe(9);
  });

  it("makes Later today three hours out in the evening", () => {
    const evening = new Date(2026, 10, 25, 18, 30).getTime();
    const [later] = botItemSnoozePresets(evening);
    expect(later.inHours).toBe(3);
    expect(new Date(later.at).getHours()).toBe(22);
  });

  it("keeps only In a week on a Monday, where Monday lands on the same day", () => {
    const monday = new Date(2026, 10, 23, 10, 0).getTime();
    const ids = botItemSnoozePickerPresets(monday).map((preset) => preset.id);
    expect(ids).toEqual(["later", "tomorrow", "week"]);
  });

  it("caps a picked time at 366 days", () => {
    const now = new Date(2026, 0, 1).getTime();
    expect(isValidBotItemSnooze(now + 1000, now)).toBe(true);
    expect(isValidBotItemSnooze(now - 1000, now)).toBe(false);
    expect(isValidBotItemSnooze(now + 367 * 24 * 60 * 60_000, now)).toBe(false);
  });

  it("parses a local date and time", () => {
    const at = parseBotItemSnoozeInput("2026-12-03", "9:15");
    expect(at).toBe(new Date(2026, 11, 3, 9, 15).getTime());
    expect(parseBotItemSnoozeInput("2026-02-31", "09:00")).toBeNull();
    expect(parseBotItemSnoozeInput("tomorrow", "09:00")).toBeNull();
  });
});

describe("answers", () => {
  const decisions = [
    { prompt: "**Which** branch?", options: [{ label: "main" }], recommended: 0 },
    { prompt: "Ship today?", options: [{ label: "Yes" }, { label: "No" }] },
  ];

  it("posts one line per question when there are several", () => {
    expect(botItemAnswersText(decisions, ["main", "No"])).toBe(
      "Which branch? → main\nShip today? → No",
    );
  });

  it("posts the words alone for a single question", () => {
    expect(botItemAnswersText(decisions.slice(0, 1), ["  main  "])).toBe("main");
  });

  it("strips Markdown marks from a question line", () => {
    expect(botItemQuestionLine("\n## Pick `one` of [these](http://x)\nmore")).toBe(
      "Pick one of these",
    );
  });
});

describe("filters and links", () => {
  const home = { id: "home", kind: "home" as const, title: null };
  const side = { id: "side", kind: "chat" as const, title: "Release" };
  const items = [
    item({ id: "a", status: "needs_you", chat: home }),
    item({ id: "b", status: "working", chat: side }),
  ];

  it("filters by Needs you and by chat", () => {
    expect(filterBotItems(items, { needsYouOnly: true, chatId: null }).map((i) => i.id)).toEqual([
      "a",
    ]);
    expect(filterBotItems(items, { needsYouOnly: false, chatId: "side" }).map((i) => i.id)).toEqual(
      ["b"],
    );
    expect(botItemChats(items).map((chat) => chat.id)).toEqual(["home", "side"]);
  });

  it("reads a PR number", () => {
    expect(botItemPrNumber("acme/app#42")).toBe(42);
    expect(botItemPrNumber("acme/app")).toBeNull();
  });

  it("waits for review until the reviews pass", () => {
    expect(
      isBotItemAwaitingReview(item({ status: "working", review: { state: "running", round: 1 } })),
    ).toBe(true);
    expect(
      isBotItemAwaitingReview(item({ status: "working", review: { state: "passed", round: 1 } })),
    ).toBe(false);
    expect(isBotItemAwaitingReview(item({ status: "working" }))).toBe(false);
  });

  it("formats ages", () => {
    expect(formatShortTimeAgo(0, 30_000)).toBe("now");
    expect(formatShortTimeAgo(0, 5 * 60_000)).toBe("5m");
    expect(formatShortTimeAgo(0, 3 * 3_600_000)).toBe("3h");
    expect(formatShortTimeAgo(0, 50 * 3_600_000)).toBe("2d");
  });
});

describe("activity", () => {
  it("interleaves worker starts and finishes with events by time", () => {
    const events: BotItemEvent[] = [
      {
        id: "e1",
        itemId: "i1",
        kind: "made",
        actor: { kind: "bot", botId: "b1" },
        data: {},
        at_ms: 10,
      },
      {
        id: "e2",
        itemId: "i1",
        kind: "commented",
        actor: { kind: "owner" },
        data: { text: "thanks" },
        at_ms: 40,
      },
    ];
    const entries = botItemActivity(
      item({
        links: [
          {
            kind: "dispatch",
            ref: "agent-1",
            title: "Fix test",
            state: "completed",
            startedAt_ms: 20,
            settledAt_ms: 30,
            report: null,
          },
        ],
      }),
      events,
    );
    expect(entries.map((entry) => entry.key)).toEqual([
      "e1",
      "agent-1:started",
      "agent-1:settled",
      "e2",
    ]);
  });
});

describe("linked things by name (Orca bot-item-link-names)", () => {
  const worker = {
    kind: "dispatch" as const,
    ref: "1af7e410-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
    title: "Fix the flaky test",
    state: "working" as const,
    startedAt_ms: 20,
    settledAt_ms: null,
    report: null,
  };

  it("shows a worker's link only as its Worker started line, never its agent id", () => {
    const events: BotItemEvent[] = [
      {
        id: "e1",
        itemId: "i1",
        kind: "linked",
        actor: { kind: "bot", botId: "b1" },
        data: { link: { kind: "dispatch", ref: worker.ref } },
        at_ms: 20,
      },
      {
        id: "e2",
        itemId: "i1",
        kind: "linked",
        actor: { kind: "bot", botId: "b1" },
        data: { link: { kind: "pr", ref: "acme/shop#42" } },
        at_ms: 30,
      },
    ];
    const entries = botItemActivity(item({ links: [worker] }), events);
    expect(entries.map((entry) => entry.key)).toEqual([`${worker.ref}:started`, "e2"]);
    expect(botItemLinkedEventName(events[1]!, [worker])).toBe("#42");
  });

  it.each([
    [{ kind: "pr", ref: "acme/shop#42" }, "#42"],
    [{ kind: "url", ref: "https://github.com/acme/shop/issues/7" }, "#7"],
    [{ kind: "url", ref: "https://linear.app/acme/issue/eng-12/fix" }, "ENG-12"],
    [{ kind: "url", ref: "https://www.example.org/docs?a=1" }, "example.org"],
    [{ kind: "file", ref: "/Users/me/code/shop/src/login.ts" }, "login.ts"],
    [{ kind: "dispatch", ref: "1af7e410-1c2d-4e5f-8a9b-0c1d2e3f4a5b" }, "Fix the flaky test"],
    [{ kind: "dispatch", ref: "0b2c-gone" }, null],
    [{ kind: "automation", ref: "auto-1" }, null],
  ])("names %o as %s", (link, name) => {
    expect(botItemLinkName(link, [worker])).toBe(name);
  });
});

describe("Needs you fold (A37.7.10, A37.7.11)", () => {
  const ask = (key: string, kind: BotNeedsYouRow["kind"]): BotNeedsYouRow => ({
    key,
    kind,
    title: key,
    at_ms: 0,
  });

  it("keeps approval, question, connector, then the items", () => {
    const rows = botNeedsYouRows(
      [ask("q", "question"), ask("a", "approval"), ask("c", "connector"), ask("i", "item")],
      [item({ id: "x", status: "needs_you" })],
    );
    const { ordered } = needsYouFold(rows, { expanded: false });
    expect(ordered.map((row) => row.key)).toEqual(["a", "q", "c", "item:x"]);
  });

  it("shows every approval and folds the rest past five", () => {
    const approvals = Array.from({ length: 7 }, (_, i) => ask(`a${i}`, "approval"));
    const items = Array.from({ length: 3 }, (_, i) => item({ id: `i${i}`, status: "needs_you" }));
    const fold = needsYouFold(botNeedsYouRows(approvals, items), { expanded: false });
    expect(fold.visible).toHaveLength(7);
    expect(fold.hidden).toBe(3);
  });

  it("shows six plain rows whole and folds seven to five", () => {
    const six = Array.from({ length: 6 }, (_, i) => item({ id: `i${i}`, status: "needs_you" }));
    expect(needsYouFold(botNeedsYouRows([], six), { expanded: false }).hidden).toBe(0);
    const seven = [...six, item({ id: "i6", status: "needs_you" })];
    const fold = needsYouFold(botNeedsYouRows([], seven), { expanded: false });
    expect(fold.visible).toHaveLength(5);
    expect(fold.hidden).toBe(2);
  });
});
