import { describe, expect, it } from "vitest";
import type { BotMemoryHistoryRow } from "@jagentdesk/protocol/bots/views";
import { i18n } from "@/i18n/i18next";
import {
  groupHistoryByDay,
  isBypassMode,
  lookAroundLine,
  lookAroundValue,
  memoryFactText,
  memoryHistoryAuthor,
  memoryHistoryKind,
  memoryHistorySummary,
  soulStats,
  tidyUpLine,
  whoCanAskValue,
  type Translate,
} from "./row-states";

const t: Translate = (key, values) => i18n.t(key, values);

function row(
  at_ms: number,
  by: BotMemoryHistoryRow["by"],
  added: string[],
  removed: string[] = [],
): BotMemoryHistoryRow {
  return {
    id: `${at_ms}`,
    at_ms,
    by,
    change: {
      added: added.map((line) => ({ line, after: null })),
      removed: removed.map((line) => ({ line, after: null })),
    },
    undoable: true,
  };
}

describe("bot settings row states", () => {
  it("counts SOUL.md lines and words", () => {
    expect(soulStats("")).toEqual({ lines: 0, words: 0 });
    expect(soulStats("# Me\n\nI review PRs carefully.")).toEqual({ lines: 3, words: 6 });
  });

  it("groups memory history by day, newest first, in Orca's labels", () => {
    const now = new Date(2026, 10, 27, 15, 0).getTime();
    const today = new Date(2026, 10, 27, 9, 0).getTime();
    const yesterday = new Date(2026, 10, 26, 22, 0).getTime();
    const earlier = new Date(2026, 10, 14, 10, 0).getTime();
    const groups = groupHistoryByDay(
      [
        row(today, { kind: "owner" }, ["- a"]),
        row(today - 1, { kind: "owner" }, ["- b"]),
        row(yesterday, { kind: "tidy-up" }, ["- c"], ["- d"]),
        row(earlier, { kind: "owner" }, ["- e"]),
      ],
      now,
      t,
      "en-US",
    );
    expect(groups.map((group) => [group.day, group.rows.length])).toEqual([
      ["Today", 2],
      ["Yesterday", 1],
      ["Nov 14", 1],
    ]);
  });

  it("words each change and its author", () => {
    const added = row(1, { kind: "owner" }, ["- 2026-11-27 Prefers squash merges · from: Slack"]);
    expect(memoryHistorySummary(t, added)).toBe("Added: Prefers squash merges");
    expect(memoryHistoryAuthor(t, added)).toBe("You, in Settings");
    expect(memoryHistoryKind(added)).toBe("add");
    const forgot = row(1, { kind: "bot", agentId: "a" }, [], ["- Rule: ship on Fridays"]);
    expect(memoryHistorySummary(t, forgot)).toBe("Forgot: Rule: ship on Fridays");
    expect(memoryHistoryAuthor(t, forgot)).toBe("Forget, from A chat");
    const chat = row(1, { kind: "chat", agentId: "a", title: "Release" }, ["- x"], ["- y"]);
    expect(memoryHistoryKind(chat)).toBe("edit");
    expect(memoryHistoryAuthor(t, chat)).toBe('Chat "Release"');
    const tidied = row(1, { kind: "tidy-up" }, ["- a", "- b"], ["- c"]);
    expect(memoryHistorySummary(t, tidied)).toBe("Tidied 3 lines");
    expect(memoryHistoryAuthor(t, { ...tidied, undoable: false })).toContain("Can’t be undone");
  });

  it("strips bullet, date and source from a fact line", () => {
    expect(memoryFactText("- 2026-11-01: Fact: default repository is /src · from: chat")).toBe(
      "Fact: default repository is /src",
    );
  });

  it("says Look around and Memory upkeep as Orca does", () => {
    const now = new Date(2026, 10, 27, 15, 0).getTime();
    expect(lookAroundValue({ on: true, every: "every-4h" }, t)).toBe("4h");
    expect(lookAroundValue({ on: false, every: "every-4h" }, t)).toBeNull();
    expect(lookAroundLine({ on: false, every: "mornings" }, undefined, t, now)).toBe("Off");
    expect(lookAroundLine({ on: true, every: "every-4h" }, undefined, t, now)).toBe(
      "Every 4 hours, 8 AM to 8 PM",
    );
    expect(tidyUpLine({ on: true, every: "night" }, now - 60_000, t, now)).toBe(
      "Each night after 3 AM, or once this computer is awake · last tidied today",
    );
  });

  it("names who can ask and bypass modes", () => {
    expect(whoCanAskValue(0, t)).toBe("Only you");
    expect(whoCanAskValue(1, t)).toBe("You and 1 other");
    expect(isBypassMode({ colorTier: "dangerous" })).toBe(true);
    expect(isBypassMode({ colorTier: "safe" })).toBe(false);
  });
});
