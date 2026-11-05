// Effect drawing: DROP_SHADOW / INNER_SHADOW / LAYER_BLUR (spec 32.5.1). BACKGROUND_BLUR is not
// drawn here at all — it makes the node unsupported so the caller's fallback raster is used.
// Canvas shadows have no spread, so drop-shadow spread is folded into the blur radius as an
// approximation (the only lever the 2D context gives us).
import type { Effect } from "./node-props";
import { colorToCss } from "./paints";
import { newPath } from "./render-path";
import type { Shape } from "./shapes";

export interface ShadowDraw {
  effect: Effect;
  /** CSS color for ctx.shadowColor including the effect's own alpha. */
  color: string;
  offsetX: number;
  offsetY: number;
  blur: number;
}

export function visibleEffects(effects: Effect[]): Effect[] {
  return effects.filter((effect) => effect.visible !== false);
}

export function toShadowDraw(effect: Effect, scale = 1): ShadowDraw {
  const radius = effect.radius ?? 0;
  const spread = effect.spread ?? 0;
  // Canvas ignores the CTM for shadow offsets/blur, so pre-apply the render scale ourselves.
  return {
    effect,
    color: colorToCss(effect.color, 1),
    offsetX: (effect.offset?.x ?? 0) * scale,
    offsetY: (effect.offset?.y ?? 0) * scale,
    // No canvas spread: widen the blur so the shadow keeps the heaviest part of its reach.
    blur: (radius + spread) * scale,
  };
}

function clearShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = "rgba(0, 0, 0, 0)";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function applyShadow(ctx: CanvasRenderingContext2D, draw: ShadowDraw): void {
  ctx.shadowColor = draw.color;
  ctx.shadowBlur = draw.blur;
  ctx.shadowOffsetX = draw.offsetX;
  ctx.shadowOffsetY = draw.offsetY;
}

/**
 * Draws the drop shadows of a shape: each visible DROP_SHADOW re-fills the shape with the canvas
 * shadow enabled, in effect order (Figma sends effects bottom-to-top).
 */
export function drawDropShadows(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  effects: Effect[],
  fillStyle: string | CanvasGradient | CanvasPattern,
  scale: number,
): void {
  const shadows = effects.filter((e) => e.type === "DROP_SHADOW");
  if (shadows.length === 0) return;
  ctx.save();
  ctx.fillStyle = fillStyle;
  // The shape body is repainted by the normal fill pass on top, so this pass may be opaque.
  ctx.globalAlpha = 1;
  for (const effect of shadows) {
    applyShadow(ctx, toShadowDraw(effect, scale));
    for (const shape of shapes) ctx.fill(shape.path, shape.rule);
    clearShadow(ctx);
  }
  ctx.restore();
}

/**
 * Draws inner shadows: clip to the shape, then fill a ring (outer rect + shape hole, even-odd) so
 * only the ring's shadow lands inside the clip (the standard canvas technique).
 */
export function drawInnerShadows(
  ctx: CanvasRenderingContext2D,
  shapes: Shape[],
  effects: Effect[],
  width: number,
  height: number,
  scale: number,
): void {
  const shadows = effects.filter((e) => e.type === "INNER_SHADOW");
  if (shadows.length === 0) return;
  const ring = newPath();
  const big = 4 * Math.max(width, height);
  ring.rect(-big, -big, big * 3 + width, big * 3 + height);
  ring.rect(0, 0, width, height);
  ctx.save();
  for (const shape of shapes) ctx.clip(shape.path, shape.rule);
  for (const effect of shadows) {
    const draw = toShadowDraw(effect, scale);
    ctx.save();
    applyShadow(ctx, draw);
    ctx.fillStyle = draw.color;
    ctx.fill(ring, "evenodd");
    clearShadow(ctx);
    ctx.restore();
  }
  ctx.restore();
}

/** Sets ctx.filter for a LAYER_BLUR effect; returns true when applied. */
export function applyLayerBlur(
  ctx: CanvasRenderingContext2D,
  effects: Effect[],
  scale: number,
): boolean {
  const blur = visibleEffects(effects).find((e) => e.type === "LAYER_BLUR");
  if (!blur) return false;
  const radius = blur.radius ?? 0;
  // Canvas blur(px) is a Gaussian with stdDeviation = px, unaffected by the CTM; Figma's radius is
  // ~2× stdDeviation, and we pre-apply the render scale ourselves.
  ctx.filter = `blur(${(radius / 2) * scale}px)`;
  return true;
}

export function resetLayerBlur(ctx: CanvasRenderingContext2D, applied: boolean): void {
  if (applied) ctx.filter = "none";
}
