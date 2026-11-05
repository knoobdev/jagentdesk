import { describe, expect, it } from "vitest";

import { overlayHitRect, placeOverlay } from "./overlay-placement";
import type { OverlayPosition } from "./state-machine";

// G5 bug 1: the overlay sheet rendered at its own fit (the whole stage box → scale ~1.0) while
// the base frame underneath fitted at ~0.67. Placement must reuse the base frame's scale and
// its centred origin mapping (FrameStage boxStyle), then position per the overlay settings.

const stage = { stageWidth: 600, stageHeight: 900 };

function place(overrides: {
  baseWidth: number;
  baseHeight: number;
  overlayWidth: number;
  overlayHeight: number;
  position: OverlayPosition;
  baseScale?: number;
}) {
  return placeOverlay({ ...stage, ...overrides });
}

describe("placeOverlay", () => {
  it("places a bottom-centred sheet at the base frame's scale inside the base rect", () => {
    // The brief's scenario: base 375x812 shown at 0.67 in a 600x900 stage; overlay 375x260
    // BOTTOM_CENTER. Expected: the sheet at 0.67 scale, horizontally centred on the BASE rect,
    // its bottom edge flush with the base rect's bottom edge.
    const placed = place({
      baseWidth: 375,
      baseHeight: 812,
      overlayWidth: 375,
      overlayHeight: 260,
      position: "BOTTOM_CENTER",
      baseScale: 0.67,
    });
    expect(placed).not.toBeNull();
    const baseScale = 0.67;
    const baseDrawnWidth = 375 * baseScale; // 251.25
    const baseDrawnHeight = 812 * baseScale; // 544.04
    expect(placed!.scale).toBeCloseTo(baseScale, 6);
    expect(placed!.width).toBeCloseTo(375 * baseScale, 6);
    expect(placed!.height).toBeCloseTo(260 * baseScale, 6);
    expect(placed!.x).toBeCloseTo((600 - baseDrawnWidth) / 2, 6);
    expect(placed!.y).toBeCloseTo(
      (900 - baseDrawnHeight) / 2 + baseDrawnHeight - 260 * baseScale,
      6,
    );
  });

  it("fits the sheet to the base frame's own stage fit when no scale is given", () => {
    // Base 900x1600 into 600x900 fits at 0.5625 — the old layer handed the overlay the whole
    // stage and it clamped to 1.0 instead.
    const placed = place({
      baseWidth: 900,
      baseHeight: 1600,
      overlayWidth: 375,
      overlayHeight: 260,
      position: "CENTER",
    });
    expect(placed).not.toBeNull();
    const scale = Math.min(600 / 900, 900 / 1600); // 0.5625
    expect(placed!.scale).toBeCloseTo(scale, 6);
    expect(placed!.width).toBeCloseTo(375 * scale, 6);
    expect(placed!.height).toBeCloseTo(260 * scale, 6);
    // Centred on the base rect, which is itself centred on the stage.
    expect(placed!.x).toBeCloseTo((600 - 900 * scale) / 2 + (900 * scale - 375 * scale) / 2, 6);
    expect(placed!.y).toBeCloseTo((900 - 1600 * scale) / 2 + (1600 * scale - 260 * scale) / 2, 6);
  });

  it("centres the sheet on the base rect by default", () => {
    // Stage 800x800, base 400x600 at scale 1 (fits): base rect is (200,100,400,600).
    const placed = placeOverlay({
      stageWidth: 800,
      stageHeight: 800,
      baseWidth: 400,
      baseHeight: 600,
      overlayWidth: 100,
      overlayHeight: 50,
      position: "CENTER",
    });
    expect(placed).not.toBeNull();
    expect(placed!.x).toBe(200 + (400 - 100) / 2);
    expect(placed!.y).toBe(100 + (600 - 50) / 2);
  });

  it("anchors each known position to the matching base-rect corner or edge", () => {
    // scale 1: base rect (200,100)–(600,700) in an 800x800 stage; sheet 100x50.
    const positions: Array<[OverlayPosition, number, number]> = [
      ["TOP_LEFT", 200, 100],
      ["TOP_CENTER", 200 + 150, 100],
      ["TOP_RIGHT", 600 - 100, 100],
      ["BOTTOM_LEFT", 200, 700 - 50],
      ["BOTTOM_CENTER", 200 + 150, 700 - 50],
      ["BOTTOM_RIGHT", 600 - 100, 700 - 50],
    ];
    for (const [position, x, y] of positions) {
      const placed = placeOverlay({
        stageWidth: 800,
        stageHeight: 800,
        baseWidth: 400,
        baseHeight: 600,
        overlayWidth: 100,
        overlayHeight: 50,
        position,
      });
      expect(placed, position).not.toBeNull();
      expect(placed!.x, position).toBe(x);
      expect(placed!.y, position).toBe(y);
      expect(placed!.width, position).toBe(100);
      expect(placed!.height, position).toBe(50);
    }
  });

  it("returns null for unusable geometry instead of a NaN rect", () => {
    const valid = {
      overlayWidth: 100,
      overlayHeight: 50,
      position: "CENTER" as const,
    };
    expect(placeOverlay({ ...stage, baseWidth: 0, baseHeight: 812, ...valid })).toBeNull();
    expect(placeOverlay({ ...stage, baseWidth: 375, baseHeight: -1, ...valid })).toBeNull();
    expect(
      placeOverlay({
        ...stage,
        stageWidth: Number.NaN,
        stageHeight: 900,
        baseWidth: 375,
        baseHeight: 812,
        ...valid,
      }),
    ).toBeNull();
    expect(
      placeOverlay({
        ...stage,
        baseWidth: 375,
        baseHeight: 812,
        overlayWidth: 0,
        overlayHeight: 50,
        position: "CENTER",
      }),
    ).toBeNull();
  });

  // G5 r2: hotspots inside the sheet map through the overlay placement — same scale, same
  // origin, so a hit target lands on the pixel its visual is painted at.
  describe("overlayHitRect", () => {
    const basePlaced = placeOverlay({
      stageWidth: 600,
      stageHeight: 900,
      baseWidth: 375,
      baseHeight: 812,
      overlayWidth: 375,
      overlayHeight: 260,
      position: "BOTTOM_CENTER",
      baseScale: 0.67,
    })!;

    it("maps a node through the placement: base scale + sheet origin", () => {
      // Sheet lives off-canvas at (1200, 900); "View cart" button 16/140 into it, 343x44.
      const hit = overlayHitRect(
        { x: 1216, y: 1040, width: 343, height: 44 },
        { x: 1200, y: 900 },
        basePlaced,
      );
      expect(hit.scale).toBe(basePlaced.scale);
      expect(hit.scale).toBeCloseTo(0.67, 6);
      // Offset within the sheet is frame-local (absolute origin subtracted), then scaled.
      expect(hit.x - basePlaced.x).toBeCloseTo(16 * 0.67, 6);
      expect(hit.y - basePlaced.y).toBeCloseTo(140 * 0.67, 6);
      expect(hit.width).toBeCloseTo(343 * 0.67, 6);
      expect(hit.height).toBeCloseTo(44 * 0.67, 6);
    });

    it("reproduces the placement exactly for the sheet root itself", () => {
      const hit = overlayHitRect(
        { x: 1200, y: 900, width: 375, height: 260 },
        { x: 1200, y: 900 },
        basePlaced,
      );
      expect(hit.x).toBeCloseTo(basePlaced.x, 6);
      expect(hit.y).toBeCloseTo(basePlaced.y, 6);
      expect(hit.width).toBeCloseTo(basePlaced.width, 6);
      expect(hit.height).toBeCloseTo(basePlaced.height, 6);
    });
  });
});
