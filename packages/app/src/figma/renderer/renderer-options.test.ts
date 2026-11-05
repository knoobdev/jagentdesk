// Behaviour tests for the renderer options: viewport culling, per-node overrides, missing
// resource reporting and the unsupported-feature list. All drawing runs against the fake
// recording context, no canvas.
import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { createFigmaRenderer } from "./index";
import { RecordingContext } from "./__fixtures__/recording-context";
import { defaultRenderOptions, loadNode } from "./renderer-fixtures.test";
import type { FigmaRenderOptions } from "./types";

interface MissingReport {
  fallbackNodeIds: string[];
  imageRefs: string[];
  fonts: { family: string; style: string }[];
}

function draw(node: FigmaNode, options: Partial<FigmaRenderOptions> = {}): unknown[][] {
  const ctx = new RecordingContext();
  createFigmaRenderer().draw(
    ctx as unknown as CanvasRenderingContext2D,
    node,
    defaultRenderOptions(options),
  );
  return ctx.ops;
}

function drawWithMissing(
  node: FigmaNode,
  options: Partial<FigmaRenderOptions>,
): { records: unknown[][]; reports: MissingReport[] } {
  const ctx = new RecordingContext();
  const reports: MissingReport[] = [];
  createFigmaRenderer().draw(ctx as unknown as CanvasRenderingContext2D, node, {
    ...defaultRenderOptions(options),
    onMissing: (missing) => reports.push(missing as MissingReport),
  });
  return { records: ctx.ops, reports };
}

/** The root always records one scaled setTransform; a second one means a child drew. */
function childTransformCount(records: unknown[][]): number {
  return records.filter((r) => r[0] === "setTransform" && r[1] === 2).length;
}

describe("viewport culling", () => {
  it("skips nodes fully outside the viewport", () => {
    const records = draw(loadNode("viewport-outside"), {
      viewport: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(childTransformCount(records)).toBe(1);
    expect(records.some((r) => r[0] === "fill" || r[0] === "drawImage")).toBe(false);
  });

  it("draws nodes inside the viewport", () => {
    const records = draw(loadNode("viewport-inside"), {
      viewport: { x: 0, y: 0, width: 100, height: 100 },
    });
    expect(childTransformCount(records)).toBeGreaterThan(1);
    expect(records.some((r) => r[0] === "fill")).toBe(true);
  });

  it("culls children of a clipped frame outside the viewport but draws the frame", () => {
    const records = draw(loadNode("frame-clips-children"), {
      viewport: { x: 0, y: 0, width: 60, height: 60 },
    });
    const frame = loadNode("frame-clips-children");
    const drawnChildren = (frame.children ?? []).filter((c) => {
      const box = c.absoluteBoundingBox as { x: number; y: number; width: number; height: number };
      return box.x < 60 && box.y < 60;
    });
    // Root + frame + each intersecting child.
    expect(childTransformCount(records)).toBe(2 + drawnChildren.length);
  });

  it("never culls the root node itself", () => {
    const records = draw(loadNode("viewport-outside"), {
      viewport: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(childTransformCount(records)).toBe(1);
  });
});

describe("per-node overrides", () => {
  it("draws override props instead of the node's own", () => {
    const records = draw(loadNode("rectangle-solid"), {
      overrides: { "1:1": { fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } }] } },
    });
    expect(records).toContainEqual(["set:fillStyle", "rgba(0, 0, 255, 1)"]);
    expect(records.some((r) => r[0] === "set:fillStyle" && r[1] === "rgba(51, 102, 230, 1)")).toBe(
      false,
    );
  });

  it("routes a node whose override introduces an undrawable paint to the fallback raster", () => {
    const records = draw(loadNode("rectangle-solid"), {
      overrides: { "1:1": { fills: [{ type: "CUSTOM_PATTERN" }] } },
    });
    expect(records.some((r) => r[0] === "set:fillStyle" && r[1] === "rgba(51, 102, 230, 1)")).toBe(
      false,
    );
    expect(records).toContainEqual(expect.arrayContaining(["drawImage", "raster:1:1"]));
  });

  it("ignores overrides for other nodes", () => {
    const records = draw(loadNode("rectangle-solid"), {
      overrides: {
        nonexistent: { fills: [{ type: "SOLID", color: { r: 9, g: 9, b: 9, a: 1 } }] },
      },
    });
    expect(records).toContainEqual(["set:fillStyle", "rgba(51, 102, 230, 1)"]);
  });
});

describe("missing resource reporting", () => {
  it("reports image refs that resolve to nothing", () => {
    const { reports } = drawWithMissing(loadNode("image-fill"), { imageForRef: () => null });
    expect(reports).toHaveLength(1);
    expect(reports[0].imageRefs).toEqual(["a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"]);
  });

  it("reports fonts that are not available and renders with the generic family", () => {
    const { records, reports } = drawWithMissing(loadNode("text-basic"), {
      fontAvailable: () => false,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].fonts).toEqual([{ family: "Inter", style: "Bold" }]);
    const fonts = records.filter((r) => r[0] === "set:font");
    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts[0][1]).toContain("sans-serif");
    expect(fonts[0][1]).not.toContain("Inter");
  });

  it("reports raster fallbacks it cannot get for unsupported nodes", () => {
    const { reports } = drawWithMissing(loadNode("background-blur"), {
      fallbackForNode: () => null,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].fallbackNodeIds).toEqual(["9:4"]);
  });

  it("deduplicates repeated missing resources", () => {
    const { reports } = drawWithMissing(loadNode("image-fill-tile"), {
      imageForRef: () => null,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].imageRefs).toEqual(["tile-ref-0001"]);
  });
});

describe("unsupportedFeatures", () => {
  it("lists what the renderer cannot draw", () => {
    const renderer = createFigmaRenderer();
    expect(renderer.unsupportedFeatures(loadNode("background-blur"))).toEqual(["BACKGROUND_BLUR"]);
    expect(renderer.unsupportedFeatures(loadNode("unsupported-section-type"))).toEqual([
      "NODE_TYPE:SECTION",
    ]);
    expect(renderer.unsupportedFeatures(loadNode("unsupported-fill-type"))).toEqual([
      "FILL_TYPE:CUSTOM_PATTERN",
    ]);
    expect(renderer.unsupportedFeatures(loadNode("unsupported-blend-mode"))).toEqual([
      "BLEND_MODE:LINEAR_BURN",
    ]);
    expect(renderer.unsupportedFeatures(loadNode("unsupported-mask-luminosity"))).toEqual([
      "MASK_TYPE:LUMINOSITY",
    ]);
    expect(renderer.unsupportedFeatures(loadNode("rectangle-solid"))).toEqual([]);
  });
});
