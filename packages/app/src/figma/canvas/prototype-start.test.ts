import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { resolvePrototypeStartNode } from "./prototype-start";

// W6 handoff contract (spec 32.5.3 / ADR-0039): the player is started on a real root FRAME,
// never on a selected descendant's subtree, never on a chain that leaves the cache.

const FRAMES = [{ id: "1:1" }, { id: "2:2" }];
const FLOWS = [{ nodeId: "9:9" }];

function node(id: string, type: string): FigmaNode {
  return { id, name: `Node ${id}`, type } as FigmaNode;
}

function chain(map: Record<string, FigmaNode>) {
  return (id: string) => map[id];
}

function resolve(
  selectedNodeId: string | null,
  parentOf: (id: string) => FigmaNode | null | undefined,
  frames = FRAMES,
  flows = FLOWS,
) {
  return resolvePrototypeStartNode({ selectedNodeId, frames, flowStartingPoints: flows, parentOf });
}

describe("resolvePrototypeStartNode", () => {
  it("honors the current page's flow when nothing is selected", () => {
    expect(resolve(null, () => null)).toBe("9:9");
  });

  it("returns null with no selection and no flow so the player can pick", () => {
    expect(resolve(null, () => null, FRAMES, [])).toBeNull();
  });

  it("keeps a selected root frame as-is", () => {
    expect(resolve("2:2", () => null)).toBe("2:2");
  });

  it("preserves a known outline/SECTION start verbatim for the player to resolve", () => {
    expect(resolve("9:9", () => null)).toBe("9:9");
  });

  it("maps a cached descendant up to its actual root FRAME", () => {
    const parents = { "1:5": node("1:4", "GROUP"), "1:4": node("1:1", "FRAME") };
    expect(resolve("1:5", chain(parents))).toBe("1:1");
  });

  it("never plays an uncached button/text subtree as a screen", () => {
    expect(resolve("7:7", () => undefined)).toBe("9:9");
  });

  it("falls back to the page flow when the chain ends at a non-root group", () => {
    const parents = { "1:5": node("1:4", "GROUP") };
    expect(resolve("1:5", chain(parents))).toBe("9:9");
  });

  it("terminates on a parent cycle instead of looping forever", () => {
    const parents = { a: node("b", "GROUP"), b: node("a", "GROUP") };
    expect(resolve("x", chain(parents))).toBe("9:9");
  });
});
