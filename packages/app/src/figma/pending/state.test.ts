import { describe, expect, it } from "vitest";
import type { FigmaPendingOp } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  buildResolutions,
  canApplyPending,
  conflictsResolved,
  describePendingOp,
  isPendingBarVisible,
  summarizePending,
} from "./state";

// The pending bar's decision logic (spec 32.6.1) is pure: the review list, the Apply gate, and
// the conflict resolutions are testable without a daemon or React.

function op(overrides: Partial<FigmaPendingOp> & { id: string }): FigmaPendingOp {
  return {
    op: { op: "rename", nodeId: "1:2", name: "Hero" },
    baseVersion: "v1",
    previous: {},
    createdAt_ms: 1,
    origin: "user",
    state: "pending",
    ...overrides,
  };
}

const pendingRename = op({ id: "fpo_1" });
const pendingDelete = op({ id: "fpo_2", op: { op: "delete", nodeId: "1:3" } });
const applied = op({ id: "fpo_3", state: "applied" });
const conflict = op({ id: "fpo_4", state: "conflict", origin: "agent" });

describe("summarizePending", () => {
  it("counts ops and collects distinct op kinds once", () => {
    const summary = summarizePending([pendingRename, pendingDelete, pendingRename]);
    expect(summary.count).toBe(3);
    expect(summary.byType).toEqual(["rename", "delete"]);
  });

  it("separates conflicts and origins", () => {
    const summary = summarizePending([pendingRename, conflict, applied]);
    expect(summary.conflicts).toEqual([conflict]);
    expect(summary.hasUserOrigin).toBe(true);
    expect(summary.hasAgentOrigin).toBe(true);
  });
});

describe("isPendingBarVisible", () => {
  it("hides when every op is already applied", () => {
    expect(isPendingBarVisible([applied])).toBe(false);
    expect(isPendingBarVisible([])).toBe(false);
  });

  it("shows for pending or conflicted ops", () => {
    expect(isPendingBarVisible([applied, pendingDelete])).toBe(true);
    expect(isPendingBarVisible([conflict])).toBe(true);
  });
});

describe("canApplyPending", () => {
  it("needs a linked file", () => {
    expect(canApplyPending([pendingRename], false)).toBe(false);
  });

  it("needs at least one actionable op", () => {
    expect(canApplyPending([applied], true)).toBe(false);
    expect(canApplyPending([pendingRename], true)).toBe(true);
  });

  it("blocks Apply until every conflict has a choice", () => {
    const ops = [pendingRename, conflict];
    expect(canApplyPending(ops, true, {})).toBe(false);
    expect(canApplyPending(ops, true, { fpo_4: "keep_mine" })).toBe(true);
  });

  it("allows Apply with only resolved conflicts", () => {
    expect(canApplyPending([conflict], true, { fpo_4: "keep_figma" })).toBe(true);
  });
});

describe("buildResolutions", () => {
  it("returns undefined while any conflict lacks a choice", () => {
    expect(buildResolutions([pendingRename, conflict], {})).toBeUndefined();
  });

  it("returns the map once resolved, and undefined when there are no conflicts", () => {
    expect(buildResolutions([pendingRename, conflict], { fpo_4: "keep_mine" })).toEqual({
      fpo_4: "keep_mine",
    });
    expect(buildResolutions([pendingRename], {})).toBeUndefined();
  });
});

describe("conflictsResolved", () => {
  it("is true when nothing conflicts", () => {
    expect(conflictsResolved([pendingRename], {})).toBe(true);
  });

  it("requires a choice for every conflicted op", () => {
    const ops = [conflict, op({ id: "fpo_5", state: "conflict" })];
    expect(conflictsResolved(ops, { fpo_4: "keep_mine" })).toBe(false);
    expect(conflictsResolved(ops, { fpo_4: "keep_mine", fpo_5: "keep_figma" })).toBe(true);
  });
});

describe("describePendingOp", () => {
  it("names the operation and its target", () => {
    expect(describePendingOp(pendingRename)).toContain("Rename");
    expect(describePendingOp(pendingRename)).toContain("Hero");
    expect(describePendingOp(pendingDelete)).toContain("Delete 1:3");
    expect(
      describePendingOp(op({ id: "x", op: { op: "set_text", nodeId: "2:1", characters: "Hi" } })),
    ).toContain("Hi");
  });
});
