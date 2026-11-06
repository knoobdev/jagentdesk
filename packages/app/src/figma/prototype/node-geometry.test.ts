import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { createFigmaRenderer } from "../renderer";
import { fakeImage, RecordingContext } from "../renderer/__fixtures__/recording-context";
import { findNodeById, nodeBounds, nodeRenderBounds, toFrameLocalNodes } from "./node-geometry";
import { node } from "./test-support/frames";

describe("toFrameLocalNodes", () => {
  // The brief's repro: a frame parked at x=1200, y=-300 with children. REST nodes have no
  // absoluteTransform — only absoluteBoundingBox — and a stale one must not survive either.
  const home = node({
    id: "1:1",
    name: "Home",
    x: 1200,
    y: -300,
    width: 375,
    height: 600,
    color: [1, 1, 1, 1],
    children: [
      node({
        id: "1:2",
        name: "Card",
        type: "RECTANGLE",
        x: 1220,
        y: -280,
        width: 100,
        height: 40,
        color: [0, 0, 1, 1],
      }),
    ],
  });
  const origin = { x: 1200, y: -300, width: 375, height: 600 };

  it("draws children at frame-local positions", () => {
    const local = toFrameLocalNodes(home, origin);
    expect(nodeBounds(local)).toEqual({ x: 0, y: 0, width: 375, height: 600 });
    const card = findNodeById(local, "1:2");
    expect(card).not.toBeNull();
    expect(card && nodeBounds(card)).toEqual({ x: 20, y: 20, width: 100, height: 40 });
  });

  it("leaves the source tree untouched", () => {
    toFrameLocalNodes(home, origin);
    expect(nodeBounds(home)).toEqual(origin);
    expect(nodeBounds(findNodeById(home, "1:2")!)).toEqual({
      x: 1220,
      y: -280,
      width: 100,
      height: 40,
    });
  });

  it("replaces a stale absoluteTransform with the frame-local placement", () => {
    const withStale: FigmaNode = {
      ...home,
      absoluteTransform: [
        [1, 0, 9000],
        [0, 1, 9000],
      ],
    };
    const local = toFrameLocalNodes(withStale, origin);
    const card = findNodeById(local, "1:2");
    expect(card?.absoluteTransform).toEqual([
      [1, 0, 20],
      [0, 1, 20],
    ]);
  });

  it("renders the localized subtree at local coordinates through the player's renderer", () => {
    const local = toFrameLocalNodes(home, origin);
    const ctx = new RecordingContext();
    // The player installs its camera (scale · dpr) before drawing, like frame-content.web.tsx.
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    createFigmaRenderer().draw(ctx as unknown as CanvasRenderingContext2D, local, {
      scale: 2,
      viewport: { x: 0, y: 0, width: 375, height: 600 },
      imageForRef: () => null,
      fallbackForNode: () => null,
      fontAvailable: () => true,
    });
    // scale 2 → the card at frame-local (20, 20) lands on the canvas at (40, 40), not at its
    // document position (2440, -560), which is what made the next frame blank.
    expect(ctx.ops).toContainEqual(["setTransform", 2, 0, 0, 2, 40, 40]);
    expect(ctx.ops.some((op) => op[1] === 2440)).toBe(false);
  });
});

// ── absoluteRenderBounds localization (ADR-0042 boundary defect) ─────────────────────────
// W8's renderer places default-crop fallbacks and shadow outsets on `absoluteRenderBounds`
// FIRST (renderer/nodes.ts fallbackPlacementBox). The wire carries that box in document
// coordinates, so leaving it unshifted while the layout box goes local rides the fallback
// off the one-frame canvas — placed far away or culled offstage.
describe("toFrameLocalNodes render-bounds localization", () => {
  // A card whose DROP_SHADOW outset makes the export ink box 4px wider/taller than its
  // layout box — the real REST shape, and exactly what the fallback placement consults.
  const card: FigmaNode = {
    ...node({
      id: "1:2",
      name: "Card",
      type: "RECTANGLE",
      x: 1220,
      y: -280,
      width: 100,
      height: 40,
      color: [0, 0, 1, 1],
    }),
    absoluteRenderBounds: { x: 1216, y: -284, width: 108, height: 48 },
    effects: [
      {
        // BACKGROUND_BLUR (visible) is the renderer's per-node raster route (unsupported.ts),
        // and its export ink box carries the outset — the exact shape fallbackPlacementBox
        // consults `absoluteRenderBounds` for.
        type: "BACKGROUND_BLUR",
        visible: true,
        radius: 8,
      },
    ],
  };
  const home: FigmaNode = node({
    id: "1:1",
    name: "Home",
    x: 1200,
    y: -300,
    width: 375,
    height: 600,
    color: [1, 1, 1, 1],
    children: [card],
  });
  const origin = { x: 1200, y: -300, width: 375, height: 600 };

  it("localizes valid finite render bounds by the frame origin and preserves the ink extent", () => {
    const local = toFrameLocalNodes(home, origin);
    const copy = findNodeById(local, "1:2")!;
    // Origin subtracted, dimensions VERBATIM (108×48 export, not clamped to the 100×40 box).
    expect(copy.absoluteRenderBounds).toEqual({ x: 16, y: 16, width: 108, height: 48 });
    expect(nodeRenderBounds(copy)).toEqual({ x: 16, y: 16, width: 108, height: 48 });
    // Recurses: every node with render bounds moves, not just direct children.
    expect(findNodeById(local, "1:2")!.absoluteRenderBounds).toEqual({
      x: 16,
      y: 16,
      width: 108,
      height: 48,
    });
  });

  it("leaves the source tree — render bounds included — untouched", () => {
    const before = structuredClone(home);
    toFrameLocalNodes(home, origin);
    expect(home).toEqual(before);
    expect(card.absoluteRenderBounds).toEqual({ x: 1216, y: -284, width: 108, height: 48 });
  });

  it("never fabricates local bounds for an absent, null or non-finite box", () => {
    const absent = node({ id: "2:1", name: "A", x: 1220, y: -280, width: 20, height: 20 });
    const nullish: FigmaNode = { ...absent, id: "2:2", absoluteRenderBounds: null };
    const broken: FigmaNode = {
      ...absent,
      id: "2:3",
      absoluteRenderBounds: { x: Number.NaN, y: -280, width: 22, height: 22 },
    };
    const frame: FigmaNode = node({
      id: "2:0",
      name: "F",
      x: 1200,
      y: -300,
      width: 375,
      height: 600,
      color: [1, 1, 1, 1],
      children: [absent, nullish, broken],
    });
    const local = toFrameLocalNodes(frame, origin);
    expect("absoluteRenderBounds" in findNodeById(local, "2:1")!).toBe(false);
    expect(findNodeById(local, "2:2")!.absoluteRenderBounds).toBeNull();
    // Non-finite is left UNTOUCHED (document coords, not shifted): the renderer's own
    // validated read then falls back to the localized layout box.
    expect(findNodeById(local, "2:3")!.absoluteRenderBounds).toEqual({
      x: Number.NaN,
      y: -280,
      width: 22,
      height: 22,
    });
  });

  it("keeps a shadowed non-TEXT fallback on the local viewport through the real renderer", () => {
    const local = toFrameLocalNodes(home, origin);
    const raster = fakeImage("card-ink", 108, 48);
    const ctx = new RecordingContext();
    // The player installs its camera (scale · dpr) before drawing, like frame-content.web.tsx.
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    createFigmaRenderer().draw(ctx as unknown as CanvasRenderingContext2D, local, {
      scale: 2,
      viewport: { x: 0, y: 0, width: 375, height: 600 },
      imageForRef: () => null,
      fallbackForNode: (id) => (id === "1:2" ? (raster as unknown as CanvasImageSource) : null),
      fontAvailable: () => true,
    });
    // The BACKGROUND_BLUR card routes through the per-node fallback, which places the bytes on
    // the LOCALIZED ink box: camera 2 × (16, 16) = canvas (32, 32). Pre-fix the box stayed at
    // document (1216, -284) → the raster rode off-stage at (2432, -568), outside the whole
    // 750×1200 player canvas — the real placement/cull defect.
    expect(ctx.ops).toContainEqual(["setTransform", 2, 0, 0, 2, 32, 32]);
    expect(ctx.ops.some((op) => op[0] === "setTransform" && op[4] === 2432)).toBe(false);
    // Painted with the export's own 108×48 ink dimensions onto the local transform.
    expect(ctx.ops).toContainEqual(["drawImage", "card-ink", 0, 0, 108, 48]);
  });
});
