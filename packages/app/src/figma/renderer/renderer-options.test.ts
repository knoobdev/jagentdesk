// Behaviour tests for the renderer options: viewport culling, per-node overrides, missing
// resource reporting and the unsupported-feature list. All drawing runs against the fake
// recording context, no canvas.
import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { createFigmaRenderer } from "./index";
import type { TextStyle } from "./node-props";
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

/** The root always records one baseline setTransform (the camera); more means children drew. */
function childTransformCount(records: unknown[][]): number {
  return records.filter((r) => r[0] === "setTransform").length;
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

  it("reports the node id for the raster fallback when an unavailable font has no raster yet", () => {
    // Spec 32.5.1: a TEXT node whose required family/style cannot be drawn faithfully is
    // replaced by Figma's render of that node — the generic-sans-serif approximation was a
    // fake. While no raster exists the node id goes to onMissing.fallbackNodeIds, and the
    // font stays on the report so the caller can load it and re-render as vector.
    const { records, reports } = drawWithMissing(loadNode("text-basic"), {
      fontAvailable: () => false,
      fallbackForNode: () => null,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].fonts).toEqual([{ family: "Inter", style: "Bold" }]);
    expect(reports[0].fallbackNodeIds).toEqual(["13:1"]);
    expect(records.some((r) => r[0] === "set:font")).toBe(false);
    expect(records.some((r) => r[0] === "fillText")).toBe(false);
  });

  it("draws the supplied fallback raster for a text node with an unavailable font", () => {
    // With the raster supplied it draws at the node box instead of the fake approximate text,
    // and the font report is kept so W6 still loads it.
    const { records, reports } = drawWithMissing(loadNode("text-basic"), {
      fontAvailable: () => false,
    });
    expect(records).toContainEqual(
      expect.arrayContaining(["drawImage", "raster:13:1", 0, 0, 320, 40]),
    );
    expect(records.some((r) => r[0] === "fillText")).toBe(false);
    expect(records.some((r) => r[0] === "set:font")).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0].fonts).toEqual([{ family: "Inter", style: "Bold" }]);
    expect(reports[0].fallbackNodeIds).toEqual([]); // resolved: nothing left to request
  });

  it("keeps drawing vector text while the font is available", () => {
    const { records, reports } = drawWithMissing(loadNode("text-basic"), {
      fontAvailable: () => true,
    });
    expect(records).toContainEqual(expect.arrayContaining(["set:font"]));
    expect(records.find((r) => r[0] === "set:font")?.[1]).toContain("Inter");
    expect(records.some((r) => r[0] === "drawImage")).toBe(false);
    expect(reports).toHaveLength(0); // nothing missing: no report at all
  });

  it("rasterizes the whole node when only a mixed-run override font is unavailable", () => {
    // text-style-overrides: base run is Inter Regular, one override run is Inter Bold. With
    // only Bold unavailable the node still cannot be drawn faithfully, so the single raster
    // replaces it; the unavailable face stays reported for the caller to load.
    const { records, reports } = drawWithMissing(loadNode("text-style-overrides"), {
      fontAvailable: (_family, style) => style !== "Bold",
    });
    expect(records).toContainEqual(expect.arrayContaining(["drawImage", "raster:13:4", 0, 0]));
    expect(records.some((r) => r[0] === "fillText")).toBe(false);
    expect(records.some((r) => r[0] === "set:font")).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0].fallbackNodeIds).toEqual([]); // raster supplied: drawn, not requested
    expect(reports[0].fonts).toEqual([{ family: "Inter", style: "Bold" }]);
  });

  it("draws empty text as text even when its font is unavailable", () => {
    // Nothing to approximate for a text-less node: it must not steal raster fallback bandwidth.
    const { records, reports } = drawWithMissing(loadNode("text-empty"), {
      fontAvailable: () => false,
    });
    expect(reports).toHaveLength(0);
    expect(records.some((r) => r[0] === "drawImage")).toBe(false);
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

describe("drawn font descriptors", () => {
  // The renderer asks ctx.font for exactly the face font-loading.ts loaded, because both sides
  // share figma/font-style.ts. The old local matcher started at 400 and Math.max'd substring
  // hits, so "Light" drew 400 and "SemiBold"/"Semi Bold" drew 700 (via "bold"). Assert the
  // actual recorded font string, not just that the vector path drew at all.
  const drawnFontsFor = (styleName: string): string[] => {
    const node = loadNode("text-basic");
    const style = node.style as TextStyle | undefined;
    node.style = { ...style, fontStyle: styleName };
    const records = draw(node, { fontAvailable: () => true });
    const fonts = records.filter((r) => r[0] === "set:font").map((r) => String(r[1]));
    expect(fonts.length).toBeGreaterThan(0);
    return fonts;
  };

  it.each([
    ["Thin", '100 32px "Inter"'],
    ["Light", '300 32px "Inter"'],
    ["SemiBold", '600 32px "Inter"'],
    ["Semi Bold", '600 32px "Inter"'],
    ["ExtraBold", '800 32px "Inter"'],
    ["Thin Italic", 'italic 100 32px "Inter"'],
  ] as const)("style %s draws the real %s face", (styleName, font) => {
    // Every segment of one run must carry the identical descriptor — a per-word drift would
    // mean the token list is consulted twice with different results.
    expect(new Set(drawnFontsFor(styleName))).toEqual(new Set([font]));
  });
});

describe("unsupportedFeatures", () => {
  const textNode = (name: string, extra: Record<string, unknown>): FigmaNode =>
    ({
      id: "1:1",
      name,
      type: "TEXT",
      absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
      characters: "hi",
      ...extra,
    }) as unknown as FigmaNode;
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
      "MASK_TYPE:LUMINANCE",
    ]);
    expect(renderer.unsupportedFeatures(loadNode("text-list-styles"))).toEqual(["TEXT_LIST"]);
    // Real Figma REST list data uses top-level lineTypes/lineIndentations, and hyperlinks live
    // on TypeStyle.hyperlink (base style or any override) — both must reach the fallback list.
    expect(
      renderer.unsupportedFeatures(textNode("List", { lineTypes: ["NONE", "UNORDERED"] })),
    ).toEqual(["TEXT_LIST"]);
    expect(
      renderer.unsupportedFeatures(
        textNode("Linked", { style: { hyperlink: { type: "URL", url: "https://figma.com" } } }),
      ),
    ).toEqual(["TEXT_HYPERLINKS"]);
    expect(
      renderer.unsupportedFeatures(
        textNode("PartlyLinked", {
          styleOverrideTable: { "1": { hyperlink: { type: "NODE", nodeId: "2:3" } } },
        }),
      ),
    ).toEqual(["TEXT_HYPERLINKS"]);
    expect(renderer.unsupportedFeatures(textNode("Plain", {}))).toEqual([]);
    expect(renderer.unsupportedFeatures(loadNode("rectangle-solid"))).toEqual([]);
  });
});
