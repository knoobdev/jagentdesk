// ADR-0042 renderer-fidelity behaviour: the W10 shared fallback interface (textFallbackNodeIds,
// fallbackForNode nodeType, fallbackTextUsesAbsoluteBounds), the G1 proof that Figma-exported
// bytes already bake node opacity, the CONTAINER_OPACITY boundary (group compositing ≠ per-child
// alpha), and the G2 proof binding export crop to absoluteRenderBounds (absolute flag to
// absoluteBoundingBox). Neutral inline nodes; live pixel proof is root's integration lane.
import { describe, expect, it } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { createFigmaRenderer } from "./index";
import { RecordingContext } from "./__fixtures__/recording-context";
import { defaultRenderOptions, loadNode } from "./renderer-fixtures.test";
import type { FigmaRenderOptions } from "./types";

interface FidelityReport {
  fallbackNodeIds: string[];
  imageRefs: string[];
  fonts: { family: string; style: string }[];
  textFallbackNodeIds?: string[];
}

function drawOps(node: FigmaNode, options: Partial<FigmaRenderOptions> = {}): unknown[][] {
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
): { ops: unknown[][]; reports: FidelityReport[] } {
  const ctx = new RecordingContext();
  const reports: FidelityReport[] = [];
  createFigmaRenderer().draw(ctx as unknown as CanvasRenderingContext2D, node, {
    ...defaultRenderOptions(options),
    onMissing: (missing) => reports.push(missing as FidelityReport),
  });
  return { ops: ctx.ops, reports };
}

const SOLID = [{ type: "SOLID", color: { r: 0.2, g: 0.4, b: 0.9, a: 1 } }];
const BAKED_OWN_OPACITY_FILL = [{ type: "CUSTOM_PATTERN" }];

function rect(
  id: string,
  box: Record<string, number>,
  extra: Record<string, unknown> = {},
): FigmaNode {
  return {
    id,
    name: id,
    type: "RECTANGLE",
    absoluteBoundingBox: box,
    fills: SOLID,
    strokes: [],
    effects: [],
    ...extra,
  } as unknown as FigmaNode;
}

function textNode(
  id: string,
  boxes: { bbox: Record<string, number>; render?: Record<string, number> },
): FigmaNode {
  return {
    id,
    name: id,
    type: "TEXT",
    absoluteBoundingBox: boxes.bbox,
    ...(boxes.render ? { absoluteRenderBounds: boxes.render } : {}),
    characters: "Sign in",
    style: {
      fontFamily: "Inter",
      fontStyle: "Bold",
      fontSize: 16,
      textAlignHorizontal: "LEFT",
      textAlignVertical: "TOP",
      letterSpacing: 0,
      lineHeightUnit: "AUTO",
    },
    characterStyleOverrides: [],
    styleOverrideTable: {},
    fills: SOLID,
    strokes: [],
  } as unknown as FigmaNode;
}

function group(
  id: string,
  opacity: number,
  children: FigmaNode[],
  extra: Record<string, unknown> = {},
): FigmaNode {
  const xs = children.map((c) => (c.absoluteBoundingBox ?? { x: 0 }).x);
  const ys = children.map((c) => (c.absoluteBoundingBox ?? { y: 0 }).y);
  const xe = children.map((c) => {
    const b = c.absoluteBoundingBox ?? { x: 0, width: 0 };
    return b.x + b.width;
  });
  const ye = children.map((c) => {
    const b = c.absoluteBoundingBox ?? { y: 0, height: 0 };
    return b.y + b.height;
  });
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    id,
    name: id,
    type: "GROUP",
    opacity,
    absoluteBoundingBox: { x, y, width: Math.max(...xe) - x, height: Math.max(...ye) - y },
    children,
    ...extra,
  } as unknown as FigmaNode;
}

/** The six-tuple of the last placement (setTransform) the renderer emitted. */
function lastPlacement(ops: unknown[][]): number[] {
  const placements = ops.filter((r) => r[0] === "setTransform");
  return (placements[placements.length - 1] as unknown[]).slice(1) as number[];
}

/** The globalAlpha recorded immediately before the drawImage of `tag` (fallback paint order). */
function alphaBeforeDrawImage(ops: unknown[][], tag: string): number[] {
  const at = ops.findIndex((r) => r[0] === "drawImage" && r[1] === tag);
  expect(at, `drawImage ${tag}`).toBeGreaterThan(-1);
  for (let i = at - 1; i >= 0; i -= 1) {
    if (ops[i][0] === "set:globalAlpha") return ops[i].slice(1) as number[];
  }
  throw new Error(`no globalAlpha before ${tag}`);
}

describe("W10 shared fallback interface (ADR-0042)", () => {
  it("classifies font-unavailable TEXT into textFallbackNodeIds and keeps fallbackNodeIds", () => {
    const { reports } = drawWithMissing(loadNode("text-basic"), {
      fontAvailable: () => false,
      fallbackForNode: () => null,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].fallbackNodeIds).toEqual(["13:1"]);
    expect(reports[0].textFallbackNodeIds).toEqual(["13:1"]);
  });

  it("classifies unsupported TEXT (list styles) into textFallbackNodeIds", () => {
    const { reports } = drawWithMissing(loadNode("text-list-styles"), {
      fallbackForNode: () => null,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].fallbackNodeIds).toEqual(["14:7"]);
    expect(reports[0].textFallbackNodeIds).toEqual(["14:7"]);
  });

  it("emits an empty textFallbackNodeIds for non-TEXT fallbacks", () => {
    const { reports } = drawWithMissing(loadNode("background-blur"), {
      fallbackForNode: () => null,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].fallbackNodeIds).toEqual(["9:4"]);
    expect(reports[0].textFallbackNodeIds).toEqual([]);
  });

  it("passes (nodeId, nodeType) to fallbackForNode so W10 can route SVG for TEXT", () => {
    const calls: [string, string | undefined][] = [];
    drawOps(loadNode("text-basic"), {
      fontAvailable: () => false,
      fallbackForNode: (nodeId, nodeType) => {
        calls.push([nodeId, nodeType]);
        return null;
      },
    });
    const scrim = rect(
      "2:1",
      { x: 0, y: 0, width: 10, height: 10 },
      {
        fills: BAKED_OWN_OPACITY_FILL,
      },
    );
    drawOps(scrim, {
      fallbackForNode: (nodeId, nodeType) => {
        calls.push([nodeId, nodeType]);
        return null;
      },
    });
    expect(calls).toEqual([
      ["13:1", "TEXT"],
      ["2:1", "RECTANGLE"],
    ]);
  });

  it("reports nothing when every fallback raster is already supplied", () => {
    // The raster resolves, so neither id list carries the node; only the font stays reported
    // (spec 32.5.1: the caller can still load it and re-render as vector).
    const { reports } = drawWithMissing(loadNode("text-basic"), { fontAvailable: () => false });
    expect(reports).toHaveLength(1);
    expect(reports[0].fallbackNodeIds).toEqual([]);
    expect(reports[0].textFallbackNodeIds).toEqual([]);
  });
});

describe("fallback opacity — G1 controlled proof (export-alpha-proof.json)", () => {
  it("does not re-apply the node's own opacity to Figma-exported bytes", () => {
    // 0.12-GROUP exports alphaMax 31/255 and 0.55-FRAME 140/255: the old nodeOpacity multiply
    // dropped them to 3/255 and 77/255. With no ancestor alpha the raster must draw at 1.
    const node = rect(
      "2:1",
      { x: 0, y: 0, width: 44, height: 44 },
      {
        opacity: 0.55,
        fills: BAKED_OWN_OPACITY_FILL,
      },
    );
    const ops = drawOps(node);
    expect(alphaBeforeDrawImage(ops, "raster:2:1")).toEqual([1]);
    expect(ops.some((r) => r[0] === "set:globalAlpha" && r[1] === 0.55)).toBe(false);
  });

  it("composites only the ancestor chain onto a fallback raster", () => {
    // Parent 0.5 (disjoint children → multiply path is exact) and the fallback child's own 0.55
    // baked in its bytes: expected alpha is 0.5, never 0.5×0.55 and never the parent's 0.5 lost.
    const parent = group("g:1", 0.5, [
      rect("c:1", { x: 0, y: 0, width: 50, height: 10 }),
      rect(
        "c:2",
        { x: 0, y: 10, width: 50, height: 10 },
        {
          opacity: 0.55,
          fills: BAKED_OWN_OPACITY_FILL,
        },
      ),
    ]);
    const ops = drawOps(parent);
    expect(alphaBeforeDrawImage(ops, "raster:c:2")).toEqual([0.5]);
  });

  it("cascades ancestor opacity into normal vector draws (root lead #2)", () => {
    const parent = group("g:1", 0.5, [
      rect("c:1", { x: 0, y: 0, width: 50, height: 10 }),
      rect("c:2", { x: 0, y: 10, width: 50, height: 10 }),
    ]);
    const ops = drawOps(parent);
    // Pre-fix the children's drawNode overwrote globalAlpha with their own 1 (the whole 0.5 was
    // dropped); every alpha in this stream must carry the parent's composite.
    const alphas = ops.filter((r) => r[0] === "set:globalAlpha").map((r) => r[1]);
    expect(alphas.length).toBeGreaterThan(0);
    expect(new Set(alphas)).toEqual(new Set([0.5]));
  });
});

describe("container opacity boundary — never whole SECTION/file", () => {
  const overlapping = () =>
    group("g:1", 0.5, [
      rect("c:1", { x: 0, y: 0, width: 50, height: 20 }),
      rect("c:2", { x: 0, y: 10, width: 50, height: 20 }),
    ]);
  const disjoint = () =>
    group("g:1", 0.5, [
      rect("c:1", { x: 0, y: 0, width: 50, height: 10 }),
      rect("c:2", { x: 0, y: 10, width: 50, height: 10 }),
    ]);

  it("names CONTAINER_OPACITY only for overlapping reduced-opacity containers", () => {
    const renderer = createFigmaRenderer();
    expect(renderer.unsupportedFeatures(overlapping())).toContain("CONTAINER_OPACITY");
    expect(renderer.unsupportedFeatures(disjoint())).not.toContain("CONTAINER_OPACITY");
    expect(
      renderer.unsupportedFeatures(
        group("g:1", 1, [
          rect("c:1", { x: 0, y: 0, width: 50, height: 20 }),
          rect("c:2", { x: 0, y: 10, width: 50, height: 20 }),
        ]),
      ),
    ).not.toContain("CONTAINER_OPACITY");
    expect(
      renderer.unsupportedFeatures(
        group("g:1", 0.5, [], {
          absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 },
        }),
      ),
    ).not.toContain("CONTAINER_OPACITY");
  });

  it("routes the container itself to a per-node fallback and stops drawing children twice", () => {
    const { ops, reports } = drawWithMissing(overlapping(), { fallbackForNode: () => null });
    expect(reports[0].fallbackNodeIds).toEqual(["g:1"]); // never the SECTION, never per child
    expect(ops.some((r) => r[0] === "set:fillStyle")).toBe(false);
  });

  it("draws the group's Figma-baked composite at its own box when the raster arrives", () => {
    const ops = drawOps(overlapping());
    expect(ops).toContainEqual(expect.arrayContaining(["drawImage", "raster:g:1", 0, 0, 50, 30]));
    expect(ops.some((r) => r[0] === "set:fillStyle")).toBe(false);
  });

  it("a backdrop-reading child blend forces the boundary even for disjoint boxes", () => {
    const blended = group("g:1", 0.5, [
      rect("c:1", { x: 0, y: 0, width: 50, height: 10 }),
      rect("c:2", { x: 0, y: 10, width: 50, height: 10 }, { blendMode: "MULTIPLY" }),
    ]);
    const renderer = createFigmaRenderer();
    expect(renderer.unsupportedFeatures(blended)).toContain("CONTAINER_OPACITY");
  });

  it("children that paint nothing cannot overlap: hidden and zero-alpha stay vector", () => {
    const stillVector = group("g:1", 0.5, [
      rect("c:1", { x: 0, y: 0, width: 50, height: 20 }),
      rect("c:2", { x: 0, y: 10, width: 50, height: 20 }, { visible: false }),
      rect("c:3", { x: 0, y: 10, width: 50, height: 20 }, { opacity: 0 }),
    ]);
    const renderer = createFigmaRenderer();
    expect(renderer.unsupportedFeatures(stillVector)).not.toContain("CONTAINER_OPACITY");
  });

  it("mask children clip instead of composite: a masked sibling stays on the vector path", () => {
    const masked = group("g:1", 0.5, [
      rect("c:1", { x: 0, y: 0, width: 50, height: 20 }, { isMask: true, maskType: "ALPHA" }),
      rect("c:2", { x: 0, y: 10, width: 50, height: 20 }),
    ]);
    const renderer = createFigmaRenderer();
    expect(renderer.unsupportedFeatures(masked)).not.toContain("CONTAINER_OPACITY");
  });
});

describe("fallback placement — G2 controlled proof (alpha-bounds-samples.json)", () => {
  const avatar = () =>
    ({
      id: "f:1",
      name: "avatar",
      type: "FRAME",
      absoluteBoundingBox: { x: 10, y: 10, width: 44, height: 44 },
      absoluteRenderBounds: { x: 4, y: 4, width: 72, height: 72 },
      fills: BAKED_OWN_OPACITY_FILL,
      strokes: [],
      effects: [],
    }) as unknown as FigmaNode;
  const croppedText = () =>
    textNode("t:1", {
      bbox: { x: 50, y: 60, width: 53, height: 24 },
      render: { x: 51, y: 66, width: 50, height: 15 },
    });

  it("maps default-cropped non-TEXT bytes onto absoluteRenderBounds, preserving outsets", () => {
    // Proof: the 44×44 shadow frame exports 144×144 @scale2 = 2×(72×72 renderBounds); drawing
    // those bytes on the 44×44 layout box would clip the shadow and squeeze the image.
    const ops = drawOps(avatar());
    expect(lastPlacement(ops)).toEqual([1, 0, 0, 1, 4, 4]);
    expect(ops).toContainEqual(expect.arrayContaining(["drawImage", "raster:f:1", 0, 0, 72, 72]));
  });

  it("maps ink-cropped TEXT bytes onto the render bounds without the flag", () => {
    // Proof: default PNG2 of the 53×24 text measures 101×31 ≈ 2×ink, not 2×layout.
    const ops = drawOps(croppedText(), { fontAvailable: () => false });
    expect(lastPlacement(ops)).toEqual([1, 0, 0, 1, 51, 66]);
    expect(ops).toContainEqual(expect.arrayContaining(["drawImage", "raster:t:1", 0, 0, 50, 15]));
  });

  it("maps absolute-bounds TEXT bytes onto the layout box when W10 enables the flag", () => {
    // Proof: use_absolute_bounds=true PNG2 measures 106×48 = 2×(53×24 layout box).
    const ops = drawOps(croppedText(), {
      fontAvailable: () => false,
      fallbackTextUsesAbsoluteBounds: true,
    });
    expect(lastPlacement(ops)).toEqual([1, 0, 0, 1, 50, 60]);
    expect(ops).toContainEqual(expect.arrayContaining(["drawImage", "raster:t:1", 0, 0, 53, 24]));
  });

  it("uses the layout box for TEXT only when the absolute flag is on", () => {
    const ops = drawOps(avatar(), { fallbackTextUsesAbsoluteBounds: true });
    expect(lastPlacement(ops)).toEqual([1, 0, 0, 1, 4, 4]);
  });

  it("falls back to the bounding box when render bounds are missing (disclosed)", () => {
    const noRender = textNode("t:1", { bbox: { x: 50, y: 60, width: 53, height: 24 } });
    const ops = drawOps(noRender, { fontAvailable: () => false });
    expect(lastPlacement(ops)).toEqual([1, 0, 0, 1, 50, 60]);
    expect(ops).toContainEqual(expect.arrayContaining(["drawImage", "raster:t:1", 0, 0, 53, 24]));
  });
});
