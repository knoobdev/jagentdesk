import { computeFitScale } from "./node-geometry";
import type { OverlayPosition } from "./state-machine";

// Overlay placement for the prototype player (spec 32.5.3, G5 bug 1). An overlay sheet renders
// at the SAME scale and origin mapping as the base frame beneath it: the old layer handed the
// overlay's FrameStage the whole stage box, so a 375x260 sheet fitted itself independently
// (computeFitScale caps at 1.0) while the 375x812 base on screen sat at its own fit, and the
// sheet's flexbox alignment centred it on the stage instead of on the frame it dims.
//
// FrameStage centers a fitted frame inside its box, so the base's visible rect is the stage
// centre box at the base's fit scale; the sheet is positioned inside THAT rect, per the overlay
// position (default CENTER; BOTTOM_CENTER etc. when the wire/Link says so; MANUAL centers).

export interface OverlayPlacementInput {
  /** Measured stage (the area PlayerStage draws into). */
  stageWidth: number;
  stageHeight: number;
  /** Figma dimensions of the frame the overlay opens on top of. */
  baseWidth: number;
  baseHeight: number;
  /** Figma dimensions of the overlay frame itself. */
  overlayWidth: number;
  overlayHeight: number;
  /** Where the sheet sits inside the base frame, from the overlay settings. */
  position: OverlayPosition;
  /**
   * The base frame's on-screen scale. Tests and callers that already know it pass it here;
   * omitted, it is computed with the exact call FrameStage makes for the base frame.
   */
  baseScale?: number;
}

export interface PlacedOverlay {
  /** Sheet rect in stage coordinates (css pixels from the stage origin). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** The shared scale — the base frame's own fit, never the overlay's. */
  scale: number;
}

function positiveFinite(...values: number[]): boolean {
  return values.every((value) => Number.isFinite(value) && value > 0);
}

export function placeOverlay(input: OverlayPlacementInput): PlacedOverlay | null {
  const {
    stageWidth,
    stageHeight,
    baseWidth,
    baseHeight,
    overlayWidth,
    overlayHeight,
    position,
    baseScale,
  } = input;
  if (
    !positiveFinite(stageWidth, stageHeight, baseWidth, baseHeight, overlayWidth, overlayHeight)
  ) {
    return null;
  }
  // Same call, same arguments FrameStage makes when it fits the base into the stage box — so
  // the sheet lands pixel-exact on the frame under it.
  const scale =
    baseScale ??
    computeFitScale(
      { x: 0, y: 0, width: baseWidth, height: baseHeight },
      { width: stageWidth, height: stageHeight },
    );
  if (!Number.isFinite(scale) || scale <= 0) return null;

  const baseDrawnWidth = baseWidth * scale;
  const baseDrawnHeight = baseHeight * scale;
  // FrameStage's boxStyle centers the fitted canvas in the stage box.
  const baseX = (stageWidth - baseDrawnWidth) / 2;
  const baseY = (stageHeight - baseDrawnHeight) / 2;

  const width = overlayWidth * scale;
  const height = overlayHeight * scale;
  const centerX = baseX + (baseDrawnWidth - width) / 2;
  const centerY = baseY + (baseDrawnHeight - height) / 2;
  const left = baseX;
  const right = baseX + baseDrawnWidth - width;
  const top = baseY;
  const bottom = baseY + baseDrawnHeight - height;

  switch (position) {
    case "TOP_LEFT":
      return { x: left, y: top, width, height, scale };
    case "TOP_CENTER":
      return { x: centerX, y: top, width, height, scale };
    case "TOP_RIGHT":
      return { x: right, y: top, width, height, scale };
    case "BOTTOM_LEFT":
      return { x: left, y: bottom, width, height, scale };
    case "BOTTOM_CENTER":
      return { x: centerX, y: bottom, width, height, scale };
    case "BOTTOM_RIGHT":
      return { x: right, y: bottom, width, height, scale };
    case "CENTER":
    default:
      return { x: centerX, y: centerY, width, height, scale };
  }
}

/**
 * Hit mapping for hotspots INSIDE an overlay sheet (G5 r2): a node's absolute Figma rect maps
 * through the overlay placement to a rect in stage coordinates — the base frame's scale
 * (`placement.scale`) and the sheet's origin (`placement.x/y`), i.e. exactly the pixel the node
 * is painted at. `node` and `overlayRoot` are absolute; the origin subtraction keeps the mapping
 * frame-local, matching what FrameStage's stage space produces for the sheet, so hit targets
 * track the visuals at any placement.
 */
export function overlayHitRect(
  node: { x: number; y: number; width: number; height: number },
  overlayRoot: { x: number; y: number },
  placement: PlacedOverlay,
): PlacedOverlay {
  return {
    x: placement.x + (node.x - overlayRoot.x) * placement.scale,
    y: placement.y + (node.y - overlayRoot.y) * placement.scale,
    width: node.width * placement.scale,
    height: node.height * placement.scale,
    scale: placement.scale,
  };
}
