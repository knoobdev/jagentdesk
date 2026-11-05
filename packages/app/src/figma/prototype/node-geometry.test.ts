import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { createFigmaRenderer } from "../renderer";
import { RecordingContext } from "../renderer/__fixtures__/recording-context";
import { findNodeById, nodeBounds, toFrameLocalNodes } from "./node-geometry";
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
    expect(nodeBounds(card)).toEqual({ x: 20, y: 20, width: 100, height: 40 });
  });

  it("leaves the source tree untouched", () => {
    toFrameLocalNodes(home, origin);
    expect(nodeBounds(home)).toEqual(origin);
    expect(nodeBounds(findNodeById(home, "1:2"))).toEqual({
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
