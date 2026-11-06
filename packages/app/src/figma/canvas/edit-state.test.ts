import { describe, expect, it } from "vitest";
import type { FigmaEditOp } from "@jagentdesk/protocol/figma/rpc-schemas";
import { makeNode, makePendingOp } from "./__fixtures__/figma";
import { nodeEditState } from "./edit-state";

function queue(...ops: FigmaEditOp[]) {
  return ops.map((op) => makePendingOp(op));
}

describe("nodeEditState", () => {
  it("returns the raw node untouched when nothing is queued", () => {
    const node = makeNode({ name: "Card" });
    const state = nodeEditState(node, []);
    expect(state.node).toBe(node);
    expect(state.pendingFields.size).toBe(0);
    expect(state.pendingCount).toBe(0);
  });

  it("layers queued values over the raw node and flags exactly those fields", () => {
    const node = makeNode({ id: "1:1", name: "Card", type: "TEXT", characters: "Hello" });
    const state = nodeEditState(
      node,
      queue(
        { op: "rename", nodeId: "1:1", name: "Ticket" },
        { op: "set_text", nodeId: "1:1", characters: "Queued label" },
      ),
    );
    expect(state.node.name).toBe("Ticket");
    expect(state.node.characters).toBe("Queued label");
    expect(state.pendingFields).toEqual(new Set(["name", "characters"]));
    expect(state.pendingCount).toBe(2);
  });

  it("lets a later queued op win for the same field", () => {
    const node = makeNode({ id: "1:1", name: "Card" });
    const state = nodeEditState(
      node,
      queue(
        { op: "rename", nodeId: "1:1", name: "First" },
        { op: "rename", nodeId: "1:1", name: "Second" },
      ),
    );
    expect(state.node.name).toBe("Second");
    expect(state.pendingCount).toBe(2);
  });

  it("merges only the geometry a queued set_geometry carries", () => {
    const node = makeNode({
      id: "1:1",
      absoluteBoundingBox: { x: 10, y: 20, width: 100, height: 50 },
    });
    const state = nodeEditState(node, queue({ op: "set_geometry", nodeId: "1:1", width: 640 }));
    expect(state.node.absoluteBoundingBox).toEqual({ x: 10, y: 20, width: 640, height: 50 });
    expect(state.pendingFields).toEqual(new Set(["width"]));
  });

  it("flags all four padding fields for one queued padding change", () => {
    const node = makeNode({ id: "1:1", layoutMode: "HORIZONTAL", itemSpacing: 8 });
    const state = nodeEditState(
      node,
      queue({
        op: "set_auto_layout",
        nodeId: "1:1",
        layoutMode: "VERTICAL",
        itemSpacing: 24,
        padding: { top: 4, right: 8, bottom: 4, left: 8 },
      }),
    );
    expect(state.node.layoutMode).toBe("VERTICAL");
    expect(state.node.itemSpacing).toBe(24);
    expect(state.node.paddingTop).toBe(4);
    expect(state.node.paddingLeft).toBe(8);
    expect([...state.pendingFields].sort()).toEqual(
      ["itemSpacing", "layoutMode", "padding"].sort(),
    );
  });

  it("previews delete as hidden and locked, never as a name change", () => {
    const node = makeNode({ id: "1:1", name: "Card" });
    const state = nodeEditState(node, queue({ op: "delete", nodeId: "1:1" }));
    expect(state.node.visible).toBe(false);
    expect(state.node.name).toBe("Card");
    expect(state.pendingFields).toEqual(new Set(["visible"]));
  });

  it("ignores ops queued for another node", () => {
    const node = makeNode({ id: "1:1", name: "Card" });
    const state = nodeEditState(
      node,
      queue(
        { op: "rename", nodeId: "9:9", name: "Elsewhere" },
        { op: "rename", nodeId: "1:1", name: "Ticket" },
      ),
    );
    expect(state.node.name).toBe("Ticket");
    expect(state.pendingCount).toBe(1);
  });

  it("counts only pending entries: applied, conflict and failed ops are history", () => {
    const node = makeNode({ id: "1:1", name: "Card" });
    const state = nodeEditState(node, [
      makePendingOp({ op: "rename", nodeId: "1:1", name: "Done" }, { state: "applied" }),
      makePendingOp({ op: "rename", nodeId: "1:1", name: "Clash" }, { state: "conflict" }),
      makePendingOp({ op: "rename", nodeId: "1:1", name: "Broke" }, { state: "failed" }),
      makePendingOp({ op: "rename", nodeId: "1:1", name: "Queued" }),
    ]);
    expect(state.node.name).toBe("Queued");
    expect(state.pendingCount).toBe(1);
  });

  it("previews a queued solid fill", () => {
    const node = makeNode({ id: "1:1" });
    const state = nodeEditState(
      node,
      queue({ op: "set_fill", nodeId: "1:1", color: { r: 1, g: 0.5, b: 0, a: 1 } }),
    );
    expect(state.pendingFields).toEqual(new Set(["fillColor"]));
    expect(state.node.fills?.[0]).toMatchObject({
      type: "SOLID",
      color: { r: 1, g: 0.5, b: 0, a: 1 },
    });
  });

  it("does not fabricate fields for ops the panel cannot preview", () => {
    const node = makeNode({ id: "1:1", name: "Card" });
    const state = nodeEditState(node, queue({ op: "duplicate", nodeId: "1:1", tempId: "tmp-1" }));
    expect(state.pendingCount).toBe(1);
    expect(state.pendingFields.size).toBe(0);
    expect(state.node.name).toBe("Card");
  });
});
