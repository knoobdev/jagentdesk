// Stroke/gradient fidelity against the same-version Figma exports (PNG4 + node JSON at
// evidence/render-quality): a linear gradient's stops are parameterized in the NORMALIZED
// handle space — the third handle is a basis vector, not decoration — so a skewed handle set
// must not degrade to the pixel diagonal; and a baked `strokeGeometry` band spans ±weight
// around the outline, so `strokeAlign` must clip it (Figma's own exports show a 1px INSIDE
// border occupying only the inner half). Neutral inline nodes; live pixel proof is the
// headless harness in /tmp, not this file.
import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { recordedOps } from "./__fixtures__/render-harness";

function gradientNode(handles: { x: number; y: number }[]): FigmaNode {
  return {
    id: "1:1",
    name: "gradient",
    type: "RECTANGLE",
    absoluteBoundingBox: { x: 0, y: 0, width: 366, height: 48 },
    fills: [
      {
        type: "GRADIENT_LINEAR",
        gradientHandlePositions: handles,
        gradientStops: [
          { position: 0, color: { r: 0.357, g: 0.753, b: 1, a: 1 } },
          { position: 1, color: { r: 0.165, g: 0.42, b: 0.949, a: 1 } },
        ],
      },
    ],
  } as unknown as FigmaNode;
}

function firstOp(ops: unknown[][], name: string): unknown[] {
  const hit = ops.find((op) => op[0] === name);
  expect(hit, `${name} never recorded`).toBeDefined();
  return hit as unknown[];
}

describe("linear gradient parameterization (same-version sign-in proof)", () => {
  it("maps stops through the handle transform, not the pixel diagonal", () => {
    // Real source values: the Sign-in button's fill, handles (0,0)->(1,1) with basis (-0.5,0.5).
    const ops = recordedOps(
      gradientNode([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: -0.5, y: 0.5 },
      ]),
    );
    const [, x0, y0, x1, y1] = firstOp(ops, "createLinearGradient");
    // Figma's own export encodes this axis as (12.3775, 94.3775) local px (rounded to the
    // 2-decimal SVG coordinates) and its PNG4 pixels fit the ramp t = (x/366 + y/48) / 2;
    // the naive (366, 48) pixel diagonal contradicts both.
    expect([x0, y0]).toEqual([0, 0]);
    expect(x1).toBeCloseTo(12.3775, 2);
    expect(y1).toBeCloseTo(94.3775, 2);
  });

  it("keeps orthogonal handle bases unchanged (aspect-corrected, not skewed)", () => {
    // A plain left-to-right gradient must stay (0,0)->(width,0) in pixels.
    const ops = recordedOps(
      gradientNode([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ]),
    );
    const [, , , x1, y1] = firstOp(ops, "createLinearGradient");
    expect(x1).toBeCloseTo(366, 6);
    expect(y1).toBeCloseTo(0, 6);
  });

  it("falls back to the plain h0->h1 axis when no basis handle is present", () => {
    // Two-handle gradients carry no second basis vector: old pixel-diagonal semantics stand.
    const ops = recordedOps(
      gradientNode([
        { x: 0, y: 0.5 },
        { x: 1, y: 0.5 },
      ]),
    );
    const [, x0, y0, x1, y1] = firstOp(ops, "createLinearGradient");
    expect([x0, y0]).toEqual([0, 24]);
    expect([x1, y1]).toEqual([366, 24]);
  });
});

const OUTLINE_D = "M0 0H100V50H0Z";
const RING_D = "M0 -1H100V1H0Z"; // Figma's own shape: the band spans -weight..+weight around the edge

function bakedStrokeNode(align: string): FigmaNode {
  return {
    id: "1:2",
    name: "baked",
    type: "RECTANGLE",
    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 50 },
    fills: [],
    strokes: [{ type: "SOLID", color: { r: 0.122, g: 0.31, b: 0.847, a: 1 } }],
    strokeWeight: 1,
    strokeAlign: align,
    fillGeometry: [{ path: OUTLINE_D, windingRule: "NONZERO" }],
    strokeGeometry: [{ path: RING_D, windingRule: "NONZERO" }],
  } as unknown as FigmaNode;
}

describe("baked strokeGeometry honors strokeAlign (PNG4 border proof)", () => {
  it("clips a baked INSIDE stroke to the node outline so only the inner half paints", () => {
    // Source truth: the English/日本語 button and Email input borders are 1px INSIDE
    // (PNG4 shows 4px of solid border at scale 4, only within the bounds), while the
    // baked ring covers -1..+1. Without the clip the app draws a 2px border straddling
    // the edge — the "visibly heavier" residual.
    const ops = recordedOps(bakedStrokeNode("INSIDE"));
    const fillIndex = ops.findIndex((op) => op[0] === "fill");
    expect(fillIndex).toBeGreaterThan(-1);
    const clipIndex = ops.findIndex(
      (op, i) =>
        i < fillIndex && op[0] === "clip" && (op[1] as { svg?: string })?.svg === OUTLINE_D,
    );
    expect(
      clipIndex,
      "baked INSIDE stroke must clip to the node outline before filling",
    ).toBeGreaterThan(-1);
  });

  it("clips a baked OUTSIDE stroke to the complement of the outline", () => {
    const ops = recordedOps(bakedStrokeNode("OUTSIDE"));
    const fillIndex = ops.findIndex((op) => op[0] === "fill");
    const clip = ops.find((op, i) => i < fillIndex && op[0] === "clip");
    expect(clip, "baked OUTSIDE stroke must clip to the inverse of the node outline").toBeDefined();
    expect((clip as unknown[])[2]).toBe("evenodd");
  });

  it("leaves baked CENTER strokes unclipped", () => {
    const ops = recordedOps(bakedStrokeNode("CENTER"));
    const fillIndex = ops.findIndex((op) => op[0] === "fill");
    const clip = ops.find((op, i) => i < fillIndex && op[0] === "clip");
    expect(clip, "CENTER strokes fill the baked band as-is").toBeUndefined();
  });
});
