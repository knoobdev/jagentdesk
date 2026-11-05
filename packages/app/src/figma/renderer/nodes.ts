// The node drawing pipeline (spec 32.5.1): visibility, viewport culling, per-node property
// overrides, unsupported→fallback rasters, transform, opacity/blend, clipping and masks, fills,
// strokes and effects, in Figma paint order.
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { Paint } from "./node-props";
import { boundsIntersect, boundsOfRect, type RenderMatrix } from "./matrix";
import {
  absoluteBoxOf,
  clipsContent,
  effectsOf,
  isMask,
  nodeOpacity,
  nodeSize,
  nodeTransform,
  paintsOf,
  strokeSettings,
} from "./node-props";
import { resolvePaintStyle, isDiamond, diamondClip } from "./paints";
import { fillShapes, strokeShapes, clipPathOf, type Shape } from "./shapes";
import {
  drawDropShadows,
  drawInnerShadows,
  applyLayerBlur,
  resetLayerBlur,
  visibleEffects,
} from "./effects";
import { unsupportedChildFeatures, unsupportedFeatures } from "./unsupported";
import { drawTextNode } from "./text";
import type { MissingSink } from "./missing";
import type { FigmaCanvasContext, FigmaRenderOptions } from "./types";

/** Node types that are invisible containers: children render, the node itself draws nothing. */
const CONTAINER_TYPES = new Set(["PAGE", "DOCUMENT", "CANVAS"]);

const CANVAS_BLEND_MODES = new Set([
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

export interface DrawState {
  ctx: FigmaCanvasContext;
  options: FigmaRenderOptions;
  missing: MissingSink;
  scale: number;
}

function resolveNode(state: DrawState, node: FigmaNode): FigmaNode {
  const override = state.options.overrides?.[node.id];
  if (!override) return node;
  return { ...node, ...override };
}

function setNodeTransform(state: DrawState, m: RenderMatrix): void {
  const s = state.scale;
  state.ctx.setTransform(m.a * s, m.b * s, m.c * s, m.d * s, m.e * s, m.f * s);
}

/** True when the node's absolute box lies entirely outside the render viewport. */
function culled(state: DrawState, node: FigmaNode, transform: RenderMatrix | null): boolean {
  const viewport = state.options.viewport;
  if (!viewport) return false;
  const size = nodeSize(node);
  const box =
    absoluteBoxOf(node) ??
    (transform && size.width > 0 && size.height > 0
      ? boundsOfRect(transform, size.width, size.height)
      : null);
  if (!box) return false;
  return !boundsIntersect(box, viewport);
}

function drawFallback(state: DrawState, node: FigmaNode, transform: RenderMatrix | null): void {
  const raster = state.options.fallbackForNode(node.id);
  if (!raster) {
    state.missing.addFallback(node.id);
    return;
  }
  const box = absoluteBoxOf(node) ?? (transform ? boundsOfRect(transform, ...wh(node)) : null);
  if (!box) return;
  const { ctx } = state;
  ctx.save();
  const s = state.scale;
  ctx.setTransform(s, 0, 0, s, box.x * s, box.y * s);
  ctx.globalAlpha = nodeOpacity(node);
  ctx.drawImage(raster, 0, 0, box.width, box.height);
  ctx.restore();
}

function wh(node: FigmaNode): [number, number] {
  const size = nodeSize(node);
  return [size.width, size.height];
}

function drawFills(state: DrawState, node: FigmaNode, alpha: number): void {
  const paints = paintsOf(node, "fills");
  if (paints.length === 0) return;
  const shapes = fillShapes(node);
  if (shapes.length === 0) return;
  const { ctx, options } = state;
  const { width, height } = nodeSize(node);
  const resolved: { paint: Paint; style: string | CanvasGradient | CanvasPattern }[] = [];
  for (const paint of paints) {
    const result = resolvePaintStyle(ctx, paint, width, height, options.imageForRef);
    if (!result) continue;
    if ("missing" in result) {
      state.missing.addImage(result.missing);
      continue;
    }
    resolved.push({ paint, style: result.style });
  }
  if (resolved.length === 0) return;
  const effects = visibleEffects(effectsOf(node));

  // Drop shadows sit behind the whole node: paint the silhouette once per shadow effect with the
  // top-most style, then the normal fill pass below repaints the body exactly.
  const silhouette = resolved[resolved.length - 1].style;
  drawDropShadows(ctx, shapes, effects, silhouette, state.scale);

  for (const entry of resolved) {
    ctx.save();
    ctx.globalAlpha = (entry.paint.opacity ?? 1) * alpha;
    applyPaintBlend(ctx, entry.paint.blendMode);
    if (isDiamond(entry.paint)) {
      ctx.save();
      ctx.clip(diamondClip(width, height));
      fillWith(ctx, shapes, entry.style);
      ctx.restore();
    } else {
      fillWith(ctx, shapes, entry.style);
    }
    ctx.restore();
  }
  drawInnerShadows(ctx, shapes, effects, width, height, state.scale);
}

function fillWith(
  ctx: FigmaCanvasContext,
  shapes: Shape[],
  style: string | CanvasGradient | CanvasPattern,
): void {
  ctx.fillStyle = style;
  for (const shape of shapes) ctx.fill(shape.path, shape.rule);
}

function applyPaintBlend(ctx: FigmaCanvasContext, blendMode: string | undefined): void {
  if (!blendMode || blendMode === "PASS_THROUGH" || blendMode === "NORMAL") return;
  if (CANVAS_BLEND_MODES.has(blendMode)) {
    ctx.globalCompositeOperation = blendMode as GlobalCompositeOperation;
  }
}

function drawStrokes(state: DrawState, node: FigmaNode, alpha: number): void {
  const paints = paintsOf(node, "strokes");
  const settings = strokeSettings(node);
  if (paints.length === 0 || settings.weight <= 0) return;
  const shapes = strokeShapes(node);
  if (shapes.length === 0) return;
  const { ctx, options } = state;
  const { width, height } = nodeSize(node);
  ctx.save();
  ctx.lineWidth = settings.weight;
  ctx.lineCap = toCanvasCap(settings.cap);
  ctx.lineJoin = toCanvasJoin(settings.join);
  if (settings.dashes.length > 0) ctx.setLineDash(settings.dashes);
  for (const paint of paints) {
    const result = resolvePaintStyle(ctx, paint, width, height, options.imageForRef);
    if (!result || "missing" in result) {
      if (result && "missing" in result) state.missing.addImage(result.missing);
      continue;
    }
    ctx.strokeStyle = result.style;
    ctx.globalAlpha = (paint.opacity ?? 1) * alpha;
    applyPaintBlend(ctx, paint.blendMode);
    for (const shape of shapes) strokeShape(ctx, shape, settings.align);
  }
  ctx.restore();
}

/** strokeAlign: CENTER strokes normally; INSIDE/OUTSIDE clip to the shape and double the width. */
function strokeShape(ctx: FigmaCanvasContext, shape: Shape, align: string): void {
  if (align === "INSIDE" || align === "OUTSIDE") {
    const current = ctx.lineWidth;
    ctx.save();
    ctx.clip(shape.path, shape.rule);
    ctx.lineWidth = current * 2;
    ctx.stroke(shape.path);
    ctx.restore();
    return;
  }
  ctx.stroke(shape.path);
}

function toCanvasCap(cap: string): CanvasLineCap {
  if (cap === "ROUND") return "round";
  if (cap === "SQUARE") return "square";
  return "butt";
}

function toCanvasJoin(join: string): CanvasLineJoin {
  if (join === "ROUND") return "round";
  if (join === "BEVEL") return "bevel";
  return "miter";
}

function drawChildren(state: DrawState, node: FigmaNode): void {
  const children = node.children ?? [];
  if (children.length === 0) return;
  const { ctx } = state;
  ctx.save();
  for (const child of children) {
    const resolved = resolveNode(state, child);
    if (resolved.visible === false) continue;
    if (isMask(resolved)) {
      applyMaskClip(state, resolved);
      continue;
    }
    drawNode(state, resolved);
  }
  ctx.restore();
}

function applyMaskClip(state: DrawState, mask: FigmaNode): void {
  const transform = nodeTransform(mask);
  if (!transform) return;
  const shapes = fillShapes(mask);
  if (shapes.length === 0) return;
  setNodeTransform(state, transform);
  for (const shape of shapes) state.ctx.clip(shape.path, shape.rule);
}

function drawNode(state: DrawState, node: FigmaNode): void {
  if (node.visible === false) return;
  if (typeof node.type === "string" && CONTAINER_TYPES.has(node.type)) {
    drawChildren(state, node);
    return;
  }
  const transform = nodeTransform(node);
  if (culled(state, node, transform)) return;
  const features = [...unsupportedFeatures(node), ...unsupportedChildFeatures(node)];
  if (features.length > 0) {
    drawFallback(state, node, transform);
    return;
  }
  if (!transform) return;
  const alpha = nodeOpacity(node);
  if (alpha <= 0) return;
  const { ctx } = state;
  ctx.save();
  setNodeTransform(state, transform);
  ctx.globalAlpha = alpha;
  applyPaintBlend(ctx, typeof node.blendMode === "string" ? node.blendMode : undefined);
  const blurred = applyLayerBlur(ctx, visibleEffects(effectsOf(node)), state.scale);
  if (clipsContent(node)) {
    const clip = clipPathOf(node);
    if (clip) ctx.clip(clip);
  }
  if (node.type === "TEXT") {
    drawTextNode(ctx, node, state.options, state.missing);
  } else {
    drawFills(state, node, alpha);
    drawStrokes(state, node, alpha);
  }
  drawChildren(state, node);
  resetLayerBlur(ctx, blurred);
  ctx.restore();
}

export function drawTree(state: DrawState, root: FigmaNode): void {
  const { ctx } = state;
  ctx.save();
  ctx.setTransform(state.scale, 0, 0, state.scale, 0, 0);
  drawNode(state, resolveNode(state, root));
  ctx.restore();
}
