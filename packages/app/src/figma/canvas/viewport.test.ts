import { describe, expect, it } from "vitest";
import type { FigmaNode, FigmaPage } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  centerCameraOn,
  clampZoom,
  cameraAt100,
  cameraToFit,
  formatZoomReadout,
  type Camera,
  figmaToScreen,
  framesBoundingRect,
  framesInViewport,
  lodMode,
  nodeFocusBounds,
  pageBoundingRect,
  panBy,
  planRootLoad,
  MIN_DETAIL_PROJECTED_PX,
  screenToFigma,
  THUMBNAIL_ZOOM,
  visibleRect,
  zoomAroundPoint,
  MAX_ZOOM,
  MIN_ZOOM,
} from "./viewport";
import { makeFrameSummary, makeNode } from "./__fixtures__/figma";

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

describe("projected-detail load plan (ADR-0039)", () => {
  const box = (width: number, height: number) => ({ x: 0, y: 0, width, height });

  it("plans metadata when the longest projected edge is under the detail threshold", () => {
    // Fit on a thousand-screen file: every frame is a few pixels wide → zero subtree requests.
    expect(planRootLoad(box(100, 80), THUMBNAIL_ZOOM / 2)).toBe("metadata");
    expect(planRootLoad(box(40, 30), 1)).toBe("metadata"); // also at vector zoom
    expect(planRootLoad(box(375, 812), 0.02)).toBe("metadata");
  });

  it("plans thumbnail rasters in overview LOD once projected detail exists", () => {
    expect(planRootLoad(box(1000, 800), 0.1)).toBe("thumbnail");
  });

  it("plans full subtrees only above the thumbnail zoom with real projected size", () => {
    expect(planRootLoad(box(100, 80), 1)).toBe("full");
    expect(planRootLoad(box(1000, 800), THUMBNAIL_ZOOM)).toBe("full");
  });

  it("judges the longest edge, so tall-narrow screens reach detail on height alone", () => {
    expect(planRootLoad(box(10, 2000), 0.05)).toBe("thumbnail"); // 100px on the vertical edge
  });

  it("treats exactly MIN_DETAIL_PROJECTED_PX as detail-worthy, one less is not", () => {
    expect(planRootLoad(box(MIN_DETAIL_PROJECTED_PX, 10), 1)).toBe("full");
    expect(planRootLoad(box(MIN_DETAIL_PROJECTED_PX - 0.01, 10), 1)).toBe("metadata");
  });
});

function makePage(id: string, frames: ReturnType<typeof makeFrameSummary>[]): FigmaPage {
  return { id, name: `Page ${id}`, frames, flowStartingPoints: [] };
}

describe("page-scoped fit (Fit / 100% buttons)", () => {
  const onPage = makePage("0:1", [makeFrameSummary("1:1", 0, 0, 300, 200)]);
  const otherPage = makePage("0:2", [makeFrameSummary("2:1", 5000, 4000, 400, 300)]);

  it("unions only the selected page's top-level frames", () => {
    // Regression: Fit used every page's frames, so a page of tiny frames on a far-away page
    // zoomed the current page out to 31% and left frames off-screen.
    expect(pageBoundingRect([onPage, otherPage], "0:1")).toEqual({
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });
  });

  it("is null for an unknown page", () => {
    expect(pageBoundingRect([onPage, otherPage], "nope")).toBeNull();
    expect(pageBoundingRect([onPage, otherPage], null)).toBeNull();
  });

  it("fits every top-level frame centred with a margin", () => {
    const fitted = cameraToFit(pageBoundingRect([onPage, otherPage], "0:1"), 760, 560);
    // Both frames on the page (union at 0,0..300,200) land inside the viewport, centred.
    const topLeft = figmaToScreen(fitted, { x: 0, y: 0 });
    const bottomRight = figmaToScreen(fitted, { x: 300, y: 200 });
    expect(topLeft.x).toBeGreaterThanOrEqual(0);
    expect(topLeft.y).toBeGreaterThanOrEqual(0);
    expect(bottomRight.x).toBeLessThanOrEqual(760);
    expect(bottomRight.y).toBeLessThanOrEqual(560);
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(380, 6);
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo(280, 6);
  });
});

describe("node focus resolution (deep links / comment focus)", () => {
  const page = makePage("0:1", [makeFrameSummary("1:1", 100, 100, 800, 600)]);
  const nested: FigmaNode = makeNode({
    id: "1:1",
    children: [
      makeNode({ id: "1:61", absoluteBoundingBox: { x: 320, y: 240, width: 180, height: 60 } }),
    ],
  });
  const reader = {
    get: (id: string) => (id === "1:1" ? nested : undefined),
    loadedIds: () => ["1:1"],
  };

  it("returns the summary bounds for a top-level frame", () => {
    expect(nodeFocusBounds(null, page, "1:1")).toEqual({ x: 100, y: 100, width: 800, height: 600 });
  });

  it("returns the loaded subtree's absolute box for a nested layer", () => {
    expect(nodeFocusBounds(reader, page, "1:61")).toEqual({
      x: 320,
      y: 240,
      width: 180,
      height: 60,
    });
  });

  it("is null while the containing frame is not loaded", () => {
    expect(nodeFocusBounds({ get: () => undefined, loadedIds: () => [] }, page, "1:61")).toBeNull();
    expect(nodeFocusBounds(reader, page, "9:9")).toBeNull();
  });

  it("centers a nested layer in the canvas viewport at the current zoom", () => {
    const bounds = nodeFocusBounds(reader, page, "1:61") as NonNullable<
      ReturnType<typeof nodeFocusBounds>
    >;
    const camera = centerCameraOn(BASE, bounds, 400, 800);
    expect(camera.zoom).toBe(BASE.zoom);
    const center = figmaToScreen(camera, { x: 320 + 90, y: 240 + 30 });
    expect(center.x).toBeCloseTo(200, 6);
    expect(center.y).toBeCloseTo(400, 6);
  });
});

describe("formatZoomReadout (unified readout/reset control)", () => {
  it("renders the rounded percentage the readout button shows", () => {
    expect(formatZoomReadout(1)).toBe("100%");
    expect(formatZoomReadout(0.15)).toBe("15%");
    expect(formatZoomReadout(0.7249)).toBe("72%");
    expect(formatZoomReadout(0.7251)).toBe("73%");
  });

  it("clamps like the camera does at both extremes", () => {
    expect(formatZoomReadout(0.0001)).toBe(`${MIN_ZOOM * 100}%`);
    expect(formatZoomReadout(999)).toBe(`${MAX_ZOOM * 100}%`);
    expect(formatZoomReadout(NaN)).toBe(`${MIN_ZOOM * 100}%`);
  });
});
