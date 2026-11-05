import { describe, expect, it } from "vitest";
import {
  centerCameraOn,
  clampZoom,
  cameraAt100,
  cameraToFit,
  type Camera,
  figmaToScreen,
  framesBoundingRect,
  framesInViewport,
  lodMode,
  panBy,
  screenToFigma,
  THUMBNAIL_ZOOM,
  visibleRect,
  zoomAroundPoint,
  MAX_ZOOM,
  MIN_ZOOM,
} from "./viewport";
import { makeFrameSummary } from "./__fixtures__/figma";

const BASE: Camera = { zoom: 1, offsetX: 100, offsetY: 50 };

describe("zoom around the cursor", () => {
  it("keeps the Figma point under the cursor fixed", () => {
    const cursor = { x: 320, y: 210 };
    const before = screenToFigma(BASE, cursor);
    const zoomed = zoomAroundPoint(BASE, 2.5, cursor);
    const after = figmaToScreen(zoomed, before);
    expect(after.x).toBeCloseTo(cursor.x, 6);
    expect(after.y).toBeCloseTo(cursor.y, 6);
  });

  it("multiplies the zoom and clamps to the bounds", () => {
    const cursor = { x: 10, y: 10 };
    expect(zoomAroundPoint(BASE, 2, cursor).zoom).toBe(2);
    expect(zoomAroundPoint(BASE, 1000, cursor).zoom).toBe(MAX_ZOOM);
    expect(zoomAroundPoint(BASE, 0.0001, cursor).zoom).toBe(MIN_ZOOM);
  });
});

describe("screen ↔ figma mapping", () => {
  it("round-trips", () => {
    const point = { x: -420.5, y: 933.25 };
    const screen = figmaToScreen(BASE, point);
    expect(screen.x).toBeCloseTo(point.x + BASE.offsetX, 9);
    expect(screen.y).toBeCloseTo(point.y + BASE.offsetY, 9);
    const back = screenToFigma(BASE, screen);
    expect(back.x).toBeCloseTo(point.x, 9);
    expect(back.y).toBeCloseTo(point.y, 9);
  });

  it("scales with the zoom", () => {
    const camera: Camera = { zoom: 3, offsetX: 0, offsetY: 0 };
    expect(figmaToScreen(camera, { x: 10, y: 20 })).toEqual({ x: 30, y: 60 });
  });
});

describe("visible frame computation", () => {
  const camera: Camera = { zoom: 1, offsetX: 0, offsetY: 0 };
  const inView = makeFrameSummary("1:1", 10, 10, 100, 100);
  const outRight = makeFrameSummary("1:2", 600, 10, 100, 100);
  const overlapping = makeFrameSummary("1:3", 480, 10, 100, 100);

  it("returns the viewport rect in Figma space", () => {
    const rect = visibleRect(camera, 800, 600);
    expect(rect).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(visibleRect({ zoom: 2, offsetX: 50, offsetY: 0 }, 800, 600)).toEqual({
      x: -25,
      y: 0,
      width: 400,
      height: 300,
    });
  });

  it("includes intersecting frames and excludes distant ones", () => {
    expect(
      framesInViewport([inView, outRight, overlapping], camera, 500, 400).map((f) => f.id),
    ).toEqual(["1:1", "1:3"]);
  });

  it("grows the viewport by the screen-pixel margin, scaled by zoom", () => {
    expect(framesInViewport([outRight], camera, 500, 400, 120).map((f) => f.id)).toEqual(["1:2"]);
    // At zoom 2 the same 120 px margin only reaches 60 figma units, and 600 - 500/2 = 350 away.
    expect(framesInViewport([outRight], { ...camera, zoom: 2 }, 500, 400, 120)).toEqual([]);
  });
});

describe("fit and 100% buttons", () => {
  const frames = [
    makeFrameSummary("1:1", 0, 0, 800, 600),
    makeFrameSummary("1:2", 400, 100, 200, 100),
  ];
  const rect = framesBoundingRect(frames) as {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  it("computes the union of frame bounds", () => {
    expect(rect).toEqual({ x: 0, y: 0, width: 800, height: 600 });
    expect(framesBoundingRect([])).toBeNull();
  });

  it("fits the content into the viewport with padding", () => {
    const fitted = cameraToFit(rect, 760, 560, 20);
    expect(fitted.zoom).toBeCloseTo(Math.min((760 - 40) / 800, (560 - 40) / 600), 6);
    // Content center lands on viewport center.
    const center = figmaToScreen(fitted, { x: 400, y: 300 });
    expect(center.x).toBeCloseTo(380, 6);
    expect(center.y).toBeCloseTo(280, 6);
  });

  it("falls back to zoom 1 when there is nothing to fit", () => {
    expect(cameraToFit(null, 500, 500)).toEqual({ zoom: 1, offsetX: 250, offsetY: 250 });
    expect(cameraAt100(null, 500, 500)).toEqual({ zoom: 1, offsetX: 250, offsetY: 250 });
  });

  it("centers content at zoom 1 for the 100% button", () => {
    const full = cameraAt100({ x: 100, y: 100, width: 400, height: 300 }, 800, 600);
    expect(full.zoom).toBe(1);
    expect(full.offsetX).toBe(800 / 2 - 300);
    expect(full.offsetY).toBe(600 / 2 - 250);
  });

  it("centers a rect at the current zoom", () => {
    const centered = centerCameraOn(BASE, { x: 0, y: 0, width: 200, height: 100 }, 800, 600);
    expect(centered.zoom).toBe(BASE.zoom);
    expect(centered.offsetX).toBe(800 / 2 - 100);
    expect(centered.offsetY).toBe(600 / 2 - 50);
  });
});

describe("pan", () => {
  it("moves the offset by the screen delta", () => {
    expect(panBy(BASE, 30, -20)).toEqual({ zoom: 1, offsetX: 130, offsetY: 30 });
  });
});

describe("LOD switch", () => {
  it("draws thumbnails below the threshold and vectors above it", () => {
    expect(lodMode(THUMBNAIL_ZOOM / 2)).toBe("thumbnail");
    expect(lodMode(0.02)).toBe("thumbnail");
    expect(lodMode(THUMBNAIL_ZOOM)).toBe("vector");
    expect(lodMode(1)).toBe("vector");
    expect(lodMode(64)).toBe("vector");
  });

  it("clamps zoom without NaN surprises", () => {
    expect(clampZoom(Number.NaN)).toBe(MIN_ZOOM);
    expect(clampZoom(-5)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
  });
});
