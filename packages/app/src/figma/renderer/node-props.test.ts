// Node geometry property reads (spec 32.5.1): real Figma REST responses carry no
// `absoluteTransform` — they have `absoluteBoundingBox` (always, when the node has geometry) and
// `relativeTransform` (parent-relative, only with `geometry=paths`). Positions must come from the
// absolute box; the parent-relative translation must not be added on top of it.
import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { absoluteBoxOf, nodeSize, nodeTransform, textRuns } from "./node-props";
import { loadNode } from "./__fixtures__/render-harness";
import { multiply } from "./matrix";

function findIn(node: FigmaNode, id: string): FigmaNode | null {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findIn(child, id);
    if (found) return found;
  }
  return null;
}

function findById(node: FigmaNode, id: string): FigmaNode {
  const found = findIn(node, id);
  if (!found) throw new Error(`fixture has no node ${id}`);
  return found;
}

describe("nodeTransform", () => {
  it("keeps absoluteTransform when present (Figma Link data)", () => {
    const link = loadNode("rotated-rectangle");
    const t = link.absoluteTransform as number[][];
    expect(nodeTransform(link)).toEqual({
      a: t[0][0],
      b: t[1][0],
      c: t[0][1],
      d: t[1][1],
      e: t[0][2],
      f: t[1][2],
    });
  });

  it("REST fixtures really omit absoluteTransform at every depth", () => {
    const missing: string[] = [];
    const walk = (node: FigmaNode): void => {
      if (node.absoluteTransform !== undefined) missing.push(node.id);
      for (const child of node.children ?? []) walk(child);
    };
    walk(loadNode("rest-frame-group-tree"));
    expect(missing).toEqual([]);
  });

  it("positions REST nodes from absoluteBoundingBox, not the parent-relative translation", () => {
    const group = findById(loadNode("rest-frame-group-tree"), "40:2");
    const rect = findById(group, "40:3");
    // relativeTransform says (10, 40) inside the group; the absolute box says (170, 310). The
    // parent-relative translation must not be stacked on top of the absolute position.
    expect(nodeTransform(rect)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 170, f: 310 });
    expect(nodeTransform(group)?.e).toBe(160);
    expect(nodeTransform(group)?.f).toBe(270);
  });

  it("reproduces parent-absolute ∘ child-relative for every unrotated REST child", () => {
    const root = loadNode("rest-frame-group-tree");
    const frame = nodeTransform(root) as NonNullable<ReturnType<typeof nodeTransform>>;
    const group = findById(root, "40:2");
    const groupMatrix = nodeTransform(group) as NonNullable<ReturnType<typeof nodeTransform>>;
    expect(groupMatrix).toEqual(multiply(frame, readRel(group)));
    for (const child of group.children ?? []) {
      // Holds for every child: the absolute box equals the parent matrix composed with the
      // child's relativeTransform (the rotated child included — its e/f land on (310, 440)).
      expect(nodeTransform(child)).toEqual(multiply(groupMatrix, readRel(child)));
    }
  });

  it("uses the relativeTransform linear part for rotation and anchors it on the absolute box", () => {
    const rotated = findById(loadNode("rest-frame-group-tree"), "40:6");
    const m = nodeTransform(rotated) as NonNullable<ReturnType<typeof nodeTransform>>;
    // Rotation/skew come verbatim from relativeTransform — a true 45° rotation here:
    // cos 45° = sin 45° = √½ (the fixture rounds to four decimals).
    const rel = readRel(rotated);
    expect([m.a, m.b, m.c, m.d]).toEqual([rel.a, rel.b, rel.c, rel.d]);
    expect(m.a).toBeCloseTo(Math.SQRT1_2, 4);
    expect(m.b).toBeCloseTo(Math.SQRT1_2, 4);
    expect(m.c).toBeCloseTo(-Math.SQRT1_2, 4);
    expect(m.d).toBeCloseTo(Math.SQRT1_2, 4);
    // …and the placement anchors the rotated 40×40 shape so its extents land on the
    // absoluteBoundingBox (281.716, 440, 56.568, 56.568): the rotated corners span
    // [-28.284, 28.284] × [0, 56.568], so the unrotated origin must sit at (310, 440).
    expect(m.e).toBeCloseTo(310, 4);
    expect(m.f).toBeCloseTo(440, 4);
  });

  it("falls back to absoluteRenderBounds when the bounding box is absent", () => {
    const node = loadNode("rest-vector-render-bounds");
    expect(absoluteBoxOf(node)).toBeNull();
    // relativeTransform (80, 90) is parent-relative and must not displace the node.
    expect(nodeTransform(node)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 500, f: 600 });
  });
});

describe("nodeSize", () => {
  it("prefers the unrotated size field for REST geometry=paths nodes", () => {
    const rotated = findById(loadNode("rest-frame-group-tree"), "40:6");
    // The bounding box is the rotated extents (56.568); the shape itself is 40×40.
    expect(nodeSize(rotated)).toEqual({ width: 40, height: 40 });
  });

  it("falls back to the bounding box when no size or width/height is present", () => {
    const node: FigmaNode = {
      id: "42:1",
      name: "No size",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 5, y: 6, width: 30, height: 40 },
    };
    expect(nodeSize(node)).toEqual({ width: 30, height: 40 });
  });
});

function readRel(node: FigmaNode): NonNullable<ReturnType<typeof nodeTransform>> {
  const rel = node.relativeTransform;
  if (!Array.isArray(rel)) throw new Error(`node ${node.id} has no relativeTransform`);
  const [[a = 0, c = 0, e = 0], [b = 0, d = 0, f = 0]] = rel as number[][];
  return { a, b, c, d, e, f };
}

describe("textRuns", () => {
  function textNode(characterStyleOverrides: unknown[]): FigmaNode {
    return {
      id: "13:4",
      name: "Mixed",
      type: "TEXT",
      characters: "abBc",
      style: { fontFamily: "Inter", fontStyle: "Regular", fontSize: 16 },
      characterStyleOverrides,
      styleOverrideTable: { "1": { fontStyle: "Bold" } },
    } as unknown as FigmaNode;
  }

  it("splits only on real override ids; the base marker stays one run (spec 32.5.1)", () => {
    // REST documents 0 as the default style; the plugin API spells it -1. Both, and trailing
    // characters past a short array, must merge into the base run. A styleOverrideTable entry
    // under "0" must not hijack them.
    const runs = textRuns(textNode([0, 0, 1]));
    expect(runs.map((run) => run.text)).toEqual(["ab", "B", "c"]);
    expect(runs[0]?.style.fontStyle).toBe("Regular");
    expect(runs[2]?.style.fontStyle).toBe("Regular");
    const legacy = textRuns(textNode([-1, -1, 1]));
    expect(legacy.map((run) => run.text)).toEqual(["ab", "B", "c"]);
    expect(legacy[0]?.style).toBe(legacy[2]?.style); // one base object shared by both base runs
  });

  it("applies the override table entry by id", () => {
    const runs = textRuns(textNode([0, 0, 1, 0]));
    expect(runs.map((run) => run.text)).toEqual(["ab", "B", "c"]);
    expect(runs[1]?.style.fontStyle).toBe("Bold");
  });
});
