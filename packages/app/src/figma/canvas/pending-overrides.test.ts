import { describe, expect, it } from "vitest";
import { pendingToOverrides } from "./pending-overrides";
import { makePendingOp } from "./__fixtures__/figma";

describe("pendingToOverrides (32.6.1)", () => {
  it("turns queued edits into per-node renderer overrides", () => {
    const overrides = pendingToOverrides([
      makePendingOp({ op: "rename", nodeId: "1:2", name: "Queued" }),
      makePendingOp({ op: "set_visible", nodeId: "1:3", visible: false }),
      makePendingOp({ op: "set_fill", nodeId: "1:2", color: { r: 1, g: 0, b: 0, a: 1 } }),
      makePendingOp({ op: "set_corner_radius", nodeId: "1:2", radius: 6 }),
    ]);
    expect(overrides["1:2"]).toEqual({
      name: "Queued",
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 }, visible: true }],
      cornerRadius: 6,
    });
    expect(overrides["1:3"]).toEqual({ visible: false });
  });

  it("later ops win for the same property", () => {
    const overrides = pendingToOverrides([
      makePendingOp({ op: "rename", nodeId: "1:1", name: "First" }),
      makePendingOp({ op: "rename", nodeId: "1:1", name: "Second" }),
    ]);
    expect(overrides["1:1"]).toEqual({ name: "Second" });
  });

  it("merges partial geometry over the previous override", () => {
    const overrides = pendingToOverrides([
      makePendingOp({ op: "set_geometry", nodeId: "1:1", x: 10, y: 20, width: 100, height: 50 }),
      makePendingOp({ op: "set_geometry", nodeId: "1:1", width: 200 }),
    ]);
    expect(overrides["1:1"]).toEqual({
      absoluteBoundingBox: { x: 10, y: 20, width: 200, height: 50 },
    });
  });

  it("marks deletions hidden and deleted", () => {
    expect(pendingToOverrides([makePendingOp({ op: "delete", nodeId: "1:1" })])["1:1"]).toEqual({
      visible: false,
      deleted: true,
    });
  });

  it("skips ops without an existing node to override", () => {
    const overrides = pendingToOverrides([
      makePendingOp({ op: "duplicate", nodeId: "1:1", tempId: "t" }),
      makePendingOp({
        op: "create_node",
        parentId: "0:1",
        kind: "FRAME",
        tempId: "t2",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      }),
      makePendingOp({
        op: "set_reaction",
        nodeId: "1:4",
        trigger: "ON_CLICK",
        destinationId: "2:2",
      }),
    ]);
    expect(overrides).toEqual({});
  });

  it("ignores applied, conflicted and failed queue entries", () => {
    const overrides = pendingToOverrides([
      makePendingOp({ op: "rename", nodeId: "1:1", name: "Done" }, { state: "applied" }),
      makePendingOp({ op: "set_visible", nodeId: "1:2", visible: false }, { state: "conflict" }),
      makePendingOp({ op: "set_text", nodeId: "1:3", characters: "x" }, { state: "failed" }),
    ]);
    expect(overrides).toEqual({});
  });
});
