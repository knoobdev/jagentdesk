// Feature detection for the renderer (spec 32.5.1): what this renderer cannot draw faithfully.
// Everything listed here sends the node to `options.fallbackForNode` (a Figma-rendered raster), and
// the debug frame (W10) shows the list. Keep this the single source of truth for support status.
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { effectsOf, hasHyperlinks, isMask, listStyleOf, maskType, paintsOf } from "./node-props";

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
  for (const paint of [...paintsOf(node, "fills"), ...paintsOf(node, "strokes")]) {
    if (!PAINT_TYPES.has(paint.type)) pushFeature(features, `FILL_TYPE:${paint.type}`);
    if (paint.blendMode && !BLEND_MODES.has(paint.blendMode)) {
      pushFeature(features, `BLEND_MODE:${paint.blendMode}`);
    }
    if (paint.type === "IMAGE" && paint.scaleMode && !IMAGE_SCALE_MODES.has(paint.scaleMode)) {
      pushFeature(features, `IMAGE_SCALE_MODE:${paint.scaleMode}`);
    }
  }
  if (typeof node.blendMode === "string" && !BLEND_MODES.has(node.blendMode)) {
    pushFeature(features, `BLEND_MODE:${node.blendMode}`);
  }
  for (const effect of effectsOf(node)) {
    if (!EFFECT_TYPES.has(effect.type)) pushFeature(features, `EFFECT:${effect.type}`);
    else if (effect.type === "BACKGROUND_BLUR" && effect.visible !== false) {
      pushFeature(features, "BACKGROUND_BLUR");
    }
  }
  const { strokeAlign } = strokeAlignmentOf(node);
  if (!STROKE_ALIGNMENTS.has(strokeAlign)) pushFeature(features, `STROKE_ALIGN:${strokeAlign}`);
  if (node.type === "TEXT") {
    if (listStyleOf(node) !== undefined) pushFeature(features, "TEXT_LIST");
    if (hasHyperlinks(node)) pushFeature(features, "TEXT_HYPERLINKS");
  }
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
  return features;
}

function strokeAlignmentOf(node: FigmaNode): { strokeAlign: string } {
  return { strokeAlign: typeof node.strokeAlign === "string" ? node.strokeAlign : "CENTER" };
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
