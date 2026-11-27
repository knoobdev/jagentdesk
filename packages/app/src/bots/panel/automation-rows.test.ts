import { describe, expect, it } from "vitest";
import type { BotAutomation } from "@jagentdesk/protocol/bots/views";
import {
  automationCardView,
  automationRowDetail,
  automationRowState,
  lookedDay,
  rankAutomationRows,
} from "./automation-rows";

const t = (key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key;
const row = (patch: Partial<BotAutomation> & { id: string }): BotAutomation => ({
  kind: "schedule",
  name: patch.id,
  state: "idle",
  enabled: true,
  ...patch,
});

describe("automation card", () => {
  it("ranks failed, running, soonest next, no next, paused", () => {
    const rows = [
      row({ id: "paused", enabled: false, nextAt_ms: 1 }),
      row({ id: "later", nextAt_ms: 200 }),
      row({ id: "none" }),
      row({ id: "soon", nextAt_ms: 100 }),
      row({ id: "running", state: "running" }),
      row({ id: "failed", state: "failed" }),
    ];
    expect(rankAutomationRows(rows).map((entry) => entry.id)).toEqual([
      "failed",
      "running",
      "soon",
      "later",
      "none",
      "paused",
    ]);
  });

  it("always shows the built-ins and caps the rest at five", () => {
    const rows = [
      row({ id: "look_around", kind: "look_around" }),
      row({ id: "tidy_up", kind: "tidy_up" }),
      ...Array.from({ length: 7 }, (_, index) => row({ id: `s${index}` })),
    ];
    const view = automationCardView(rows);
    expect(view.listed).toBe(7);
    expect(view.shown.map((entry) => entry.id)).toEqual([
      "look_around",
      "tidy_up",
      "s0",
      "s1",
      "s2",
      "s3",
      "s4",
    ]);
  });

  it("names the row state", () => {
    expect(automationRowState(row({ id: "a", state: "failed" }))).toBe("failed");
    expect(automationRowState(row({ id: "a", enabled: false }))).toBe("paused");
    expect(automationRowState(row({ id: "a", state: "stopped" }))).toBe("stopped");
    expect(automationRowState(row({ id: "a" }))).toBeNull();
  });

  it("words a wait and Tidy memory", () => {
    const now = new Date(2026, 10, 27, 10).getTime();
    expect(automationRowDetail(t, row({ id: "w", kind: "wait" }), now)).toBe(
      "bots.waits.noDeadline",
    );
    expect(automationRowDetail(t, row({ id: "t", kind: "tidy_up", when: "week" }), now)).toMatch(
      /^bots.upcoming.tidyWeekAfter/,
    );
    expect(automationRowDetail(t, row({ id: "s", nextAt_ms: now + 60 * 60 * 1000 }), now)).toMatch(
      /^bots.upcoming.today/,
    );
    expect(automationRowDetail(t, row({ id: "s", nextAt_ms: now - 1 }), now)).toBe(
      "bots.upcoming.dueNow",
    );
  });

  it("reads the local calendar day", () => {
    const now = new Date(2026, 10, 27, 1).getTime();
    expect(lookedDay(new Date(2026, 10, 26, 23).getTime(), now)).toBe("yesterday");
    expect(lookedDay(new Date(2026, 10, 27, 0, 5).getTime(), now)).toBe("today");
    expect(lookedDay(new Date(2026, 10, 20).getTime(), now)).toBe("earlier");
  });
});
