// Feature detection for the renderer (spec 32.5.1): what this renderer cannot draw faithfully.
// Everything listed here sends the node to `options.fallbackForNode` (a Figma-rendered raster), and
// the debug frame (W10) shows the list. Keep this the single source of truth for support status.
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { boundsIntersect, readBounds, type Bounds } from "./matrix";
import {
  absoluteBoxOf,
  effectsOf,
  geometryOf,
  hasHyperlinks,
  isMask,
  listStyleOf,
  maskType,
  nodeBlendMode,
  nodeOpacity,
  paintsOf,
} from "./node-props";

const DRAWABLE_TYPES = new Set([
  "FRAME",
  "GROUP",
  "COMPONENT",
  "COMPONENT_SET",
  "INSTANCE",
  "RECTANGLE",
  "ROUNDED_RECTANGLE",
  "ELLIPSE",
  "LINE",
  "POLYGON",
  "STAR",
  "VECTOR",
  "BOOLEAN_OPERATION",
  "TEXT",
]);

const PAINT_TYPES = new Set([
  "SOLID",
  "GRADIENT_LINEAR",
  "GRADIENT_RADIAL",
  "GRADIENT_ANGULAR",
  "GRADIENT_DIAMOND",
  "IMAGE",
]);

const BLEND_MODES = new Set([
  "PASS_THROUGH",
  "NORMAL",
  "DARKEN",
  "MULTIPLY",
  "LIGHTEN",
  "SCREEN",
  "COLOR_BURN",
  "COLOR_DODGE",
  "OVERLAY",
  "SOFT_LIGHT",
  "HARD_LIGHT",
  "DIFFERENCE",
  "EXCLUSION",
  "HUE",
  "SATURATION",
  "COLOR",
  "LUMINOSITY",
]);

const EFFECT_TYPES = new Set(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]);

const STROKE_ALIGNMENTS = new Set(["CENTER", "INSIDE", "OUTSIDE"]);

const IMAGE_SCALE_MODES = new Set(["FILL", "FIT", "TILE", "CROP"]);

const SUPPORTED_MASK_TYPES = new Set(["ALPHA", "VECTOR"]);

function pushFeature(features: string[], name: string): void {
  if (!features.includes(name)) features.push(name);
}

/**
 * Feature names of `node` this renderer cannot draw faithfully (empty when it can). Subtree
 * features belong to the child nodes, so draw() asks each node individually and a container
 * without rasters falls back node-by-node; a mask's own type is reported on the parent because
 * clipping happens during the parent's child pass.
 */
export function unsupportedFeatures(node: FigmaNode): string[] {
  const features: string[] = [];
  if (typeof node.type !== "string" || !DRAWABLE_TYPES.has(node.type)) {
    pushFeature(features, `NODE_TYPE:${node.type ?? "UNKNOWN"}`);
  }
  pushPaintFeatures(node, features);
  pushNodeBlendFeature(node, features);
  pushEffectFeatures(node, features);
  const { strokeAlign } = strokeAlignmentOf(node);
  if (!STROKE_ALIGNMENTS.has(strokeAlign)) pushFeature(features, `STROKE_ALIGN:${strokeAlign}`);
  else pushBakedAlignFeature(node, strokeAlign, features);
  if (node.type === "TEXT") pushTextFeatures(node, features);
  pushGeometryAndMaskFeatures(node, features);
  pushContainerOpacityFeature(node, features);
  return features;
}

function pushPaintFeatures(node: FigmaNode, features: string[]): void {
  for (const paint of [...paintsOf(node, "fills"), ...paintsOf(node, "strokes")]) {
    if (!PAINT_TYPES.has(paint.type)) pushFeature(features, `FILL_TYPE:${paint.type}`);
    if (paint.blendMode && !BLEND_MODES.has(paint.blendMode)) {
      pushFeature(features, `BLEND_MODE:${paint.blendMode}`);
    }
    if (paint.type === "IMAGE" && paint.scaleMode && !IMAGE_SCALE_MODES.has(paint.scaleMode)) {
      pushFeature(features, `IMAGE_SCALE_MODE:${paint.scaleMode}`);
    }
  }
}

function pushNodeBlendFeature(node: FigmaNode, features: string[]): void {
  if (typeof node.blendMode === "string" && !BLEND_MODES.has(node.blendMode)) {
    pushFeature(features, `BLEND_MODE:${node.blendMode}`);
  }
}

function pushEffectFeatures(node: FigmaNode, features: string[]): void {
  for (const effect of effectsOf(node)) {
    if (!EFFECT_TYPES.has(effect.type)) pushFeature(features, `EFFECT:${effect.type}`);
    else if (effect.type === "BACKGROUND_BLUR" && effect.visible !== false) {
      pushFeature(features, "BACKGROUND_BLUR");
    }
  }
}

function pushTextFeatures(node: FigmaNode, features: string[]): void {
  if (listStyleOf(node) !== undefined) pushFeature(features, "TEXT_LIST");
  if (hasHyperlinks(node)) pushFeature(features, "TEXT_HYPERLINKS");
}

function pushGeometryAndMaskFeatures(node: FigmaNode, features: string[]): void {
  const geometryMissing =
    (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") &&
    node.fills === undefined &&
    node.strokes === undefined;
  if (geometryMissing) pushFeature(features, "MISSING_GEOMETRY");
  if (isMask(node) && !SUPPORTED_MASK_TYPES.has(maskType(node))) {
    // Reported here too so a directly-queried mask node names its own limitation; draw() reports
    // it on the parent because the parent is what changes visually.
    pushFeature(features, `MASK_TYPE:${maskType(node)}`);
  }
}

/**
 * A container whose reduced opacity canvas cannot reproduce faithfully (ADR-0042). Figma
 * composites a group as one layer; painting each child at parent×child alpha differs wherever
 * children overlap each other or the container's own paint — so the truthful boundary is the
 * container node itself: its per-node Figma fallback bakes the group compositing and its own
 * opacity (controlled proof, render-quality/export-alpha-proof.json: a 0.12 GROUP exports
 * alphaMax 31/255, a 0.55 FRAME 140/255; re-applying nodeOpacity there drops them to 3 and 77).
 * Disjoint children in normal blend multiply exactly, so the container stays on the vector
 * path. Overlap is decided on drawn boxes, so shape-disjoint nodes with intersecting boxes
 * over-fallback rather than mis-composite.
 */
function pushContainerOpacityFeature(node: FigmaNode, features: string[]): void {
  if (nodeOpacity(node) >= 1) return;
  const children = node.children ?? [];
  if (children.length === 0) return;
  const boxes: Bounds[] = [];
  if (paintsOf(node, "fills").length > 0 || paintsOf(node, "strokes").length > 0) {
    const own = drawnBoxOf(node);
    if (own) boxes.push(own);
  }
  if (drawablesOverlap(children, boxes)) pushFeature(features, "CONTAINER_OPACITY");
}

function drawnBoxOf(node: FigmaNode): Bounds | null {
  return readBounds(node.absoluteRenderBounds) ?? absoluteBoxOf(node);
}

/** Pairwise test over every child that paints (masks clip, they do not composite). */
function drawablesOverlap(children: FigmaNode[], boxes: Bounds[]): boolean {
  for (const child of children) {
    if (child.visible === false || isMask(child) || nodeOpacity(child) === 0) continue;
    // A blend mode reads the backdrop, so group compositing and per-child alpha differ even
    // for geometrically disjoint nodes.
    if (nodeBlendMode(child) !== null || hasBlendingPaints(child)) return true;
    const box = drawnBoxOf(child);
    if (box) {
      for (const other of boxes) if (boundsIntersect(other, box)) return true;
      boxes.push(box);
    }
    if (drawablesOverlap(child.children ?? [], boxes)) return true;
  }
  return false;
}

function hasBlendingPaints(node: FigmaNode): boolean {
  return [...paintsOf(node, "fills"), ...paintsOf(node, "strokes")].some(
    (paint) =>
      !!paint.blendMode && paint.blendMode !== "NORMAL" && paint.blendMode !== "PASS_THROUGH",
  );
}

function strokeAlignmentOf(node: FigmaNode): { strokeAlign: string } {
  return { strokeAlign: typeof node.strokeAlign === "string" ? node.strokeAlign : "CENTER" };
}

/**
 * A baked stroke paints `strokeGeometry` clipped to the fill region for INSIDE/OUTSIDE
 * align, and only three branches are mathematically exact on canvas (proven with
 * real-pixel probes, not just call shape): a SINGLE fill outline clipped under its own
 * rule, and per-outline EVENODD inverse clips intersected for OUTSIDE (De Morgan).
 * A merged path is no union - merged evenodd XORs overlapping islands and merged nonzero
 * can cancel opposite-winding overlaps - so multi-outline INSIDE is unsupported; and
 * [rect, path] clipped "nonzero" keeps a same-winding shape inside (winding 2 ≠ 0), so
 * OUTSIDE over any nonzero/complex fill has no exact complement and is unsupported too.
 * Unsupported nodes go to the per-node raster fallback (options.fallbackForNode).
 */
function pushBakedAlignFeature(node: FigmaNode, strokeAlign: string, features: string[]): void {
  const weight = typeof node.strokeWeight === "number" ? node.strokeWeight : 0;
  if (weight <= 0) return;
  const strokes = geometryOf(node, "strokeGeometry");
  if (!strokes || strokes.length === 0) return;
  const fills = geometryOf(node, "fillGeometry");
  if (!fills || fills.length === 0) return;
  if (strokeAlign === "INSIDE") {
    if (fills.length > 1) pushFeature(features, "STROKE_ALIGN_MULTI_OUTLINE");
    return;
  }
  if (strokeAlign === "OUTSIDE" && fills.some((entry) => entry.windingRule !== "EVENODD")) {
    pushFeature(features, "STROKE_ALIGN_NON_EVENODD_COMPLEMENT");
  }
}

/** Mask children that make their parent depend on features this renderer cannot draw. */
export function unsupportedChildFeatures(node: FigmaNode): string[] {
  const features: string[] = [];
  for (const child of node.children ?? []) {
    if (isMask(child) && !SUPPORTED_MASK_TYPES.has(maskType(child))) {
      pushFeature(features, `MASK_TYPE:${maskType(child)}`);
    }
  }
  return features;
}
