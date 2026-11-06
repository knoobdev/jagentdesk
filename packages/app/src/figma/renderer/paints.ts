// Paint resolution: turns Figma paint objects into canvas fill/stroke styles. Solid colours and the
// four gradient kinds are drawn natively; image fills go through `options.imageForRef` (the renderer
// never fetches). Missing images are reported so the caller can load them.
import type { Paint } from "./node-props";
import { identity, multiply, scale, translate, type RenderMatrix } from "./matrix";
import { diamondPath } from "./shapes";
import type { Shape } from "./shapes";
import type { RenderPath } from "./render-path";

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function toChannel(v: number): number {
  return Math.round(clamp01(v) * 255);
}

export function cssColor(r: number, g: number, b: number, a: number): string {
  return `rgba(${toChannel(r)}, ${toChannel(g)}, ${toChannel(b)}, ${Math.round(clamp01(a) * 1000) / 1000})`;
}

export function colorToCss(
  color: { r: number; g: number; b: number; a?: number } | undefined,
  fallbackAlpha: number,
): string {
  if (!color) return cssColor(0, 0, 0, fallbackAlpha);
  return cssColor(color.r, color.g, color.b, (color.a ?? 1) * fallbackAlpha);
}

export type StyleFactory = Pick<
  CanvasRenderingContext2D,
  "createLinearGradient" | "createRadialGradient" | "createConicGradient" | "createPattern"
>;

function buildGradient(
  ctx: StyleFactory,
  paint: Paint,
  width: number,
  height: number,
): CanvasGradient | null {
  const stops = paint.gradientStops;
  if (!stops || stops.length === 0) return null;
  const handles = paint.gradientHandlePositions ?? [];
  const h0 = handles[0] ?? { x: 0, y: 0 };
  const h1 = handles[1] ?? { x: 1, y: 0 };
  let gradient: CanvasGradient | null = null;
  if (paint.type === "GRADIENT_LINEAR") {
    // Figma parameterizes the ramp in the NORMALIZED handle space: the stop value at a
    // bbox-normalized point p is the first coordinate of T⁻¹(p − h0), where T has columns
    // (h1 − h0, h2 − h0) — the third handle is a basis vector, not decoration. A canvas
    // gradient projects in pixels (its coordinates are current-user-space), so map the
    // parameter row into pixel space and normalize it into an axis: w = (r.x / width,
    // r.y / height), axis = w / |w|². Verified numerically against the same-version
    // exports: skewed handles (0,0)->(1,1)/(-0.5,0.5) on 366x48 export axis (12.378, 94.378),
    // which the naive pixel diagonal (366, 48) contradicts.
    const x0 = h0.x * width;
    const y0 = h0.y * height;
    let endX = h1.x * width;
    let endY = h1.y * height;
    const base = handles[2];
    if (base && width > 0 && height > 0) {
      const ux = h1.x - h0.x;
      const uy = h1.y - h0.y;
      const vx = base.x - h0.x;
      const vy = base.y - h0.y;
      const det = ux * vy - vx * uy;
      if (Math.abs(det) > 1e-9) {
        const wx = vy / det / width; // (first row of T⁻¹) / (width, height)
        const wy = -vx / det / height;
        const norm = wx * wx + wy * wy;
        if (Number.isFinite(norm) && norm > 0) {
          endX = x0 + wx / norm;
          endY = y0 + wy / norm;
        }
      }
    }
    gradient = ctx.createLinearGradient(x0, y0, endX, endY);
  } else if (paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_DIAMOND") {
    const radius = Math.hypot((h1.x - h0.x) * width, (h1.y - h0.y) * height);
    gradient = ctx.createRadialGradient(
      h0.x * width,
      h0.y * height,
      0,
      h0.x * width,
      h0.y * height,
      radius,
    );
  } else if (paint.type === "GRADIENT_ANGULAR") {
    gradient = ctx.createConicGradient(
      Math.atan2((h1.y - h0.y) * height, (h1.x - h0.x) * width),
      h0.x * width,
      h0.y * height,
    );
  }
  if (!gradient) return null;
  for (const stop of stops)
    gradient.addColorStop(clamp01(stop.position), colorToCss(stop.color, 1));
  return gradient;
}

/** Matrix mapping a decoded image into the node's local box for the paint's scaleMode (32.5.1). */
export function imagePlacement(
  paint: Paint,
  image: { width: number; height: number },
  width: number,
  height: number,
): RenderMatrix {
  if (paint.scaleMode === "CROP") {
    if (paint.imageTransform) {
      // Figma's imageTransform maps normalized image space (0..1) into the node box;
      // the pattern repeats whole images, so scale image pixels into that space first.
      return multiply(
        paint.imageTransform,
        scale(1 / Math.max(1, image.width), 1 / Math.max(1, image.height)),
      );
    }
    // No crop transform: the whole image covers the whole node.
    return scale(width / Math.max(1, image.width), height / Math.max(1, image.height));
  }
  if (paint.scaleMode === "TILE") {
    if (paint.imageTransform) {
      // One image footprint (normalized) per repeat.
      return multiply(
        paint.imageTransform,
        scale(1 / Math.max(1, image.width), 1 / Math.max(1, image.height)),
      );
    }
    // Tiles repeat at the image's natural pixel size (local units == layout px).
    return identity();
  }
  const fit = paint.scaleMode === "FIT";
  const sx = fit
    ? Math.min(width / image.width, height / image.height)
    : Math.max(width / image.width, height / image.height);
  const drawnWidth = image.width * sx;
  const drawnHeight = image.height * sx;
  return multiply(translate((width - drawnWidth) / 2, (height - drawnHeight) / 2), scale(sx, sx));
}

export interface ImageSourceLike {
  width: number;
  height: number;
}

function resolveImage(
  ctx: StyleFactory,
  paint: Paint,
  width: number,
  height: number,
  imageForRef: (ref: string) => CanvasImageSource | null,
): CanvasPattern | { missing: string } | null {
  const ref = paint.imageRef;
  if (!ref) return null;
  const image = imageForRef(ref);
  if (!image) return { missing: ref };
  const repetition = paint.scaleMode === "TILE" ? "repeat" : "no-repeat";
  const pattern = ctx.createPattern(image, repetition);
  if (!pattern) return { missing: ref };
  const size = image as unknown as ImageSourceLike;
  pattern.setTransform(
    imagePlacement(
      paint,
      { width: size.width || width, height: size.height || height },
      width,
      height,
    ),
  );
  return pattern;
}

/**
 * Resolves one paint to a canvas style for fills/strokes of `shapes` at the node size.
 * Returns `{ missing }` when an image fill has no decoded image yet (report via onMissing), and
 * null when the paint cannot be drawn at all (unknown type).
 */
export function resolvePaintStyle(
  ctx: StyleFactory,
  paint: Paint,
  width: number,
  height: number,
  imageForRef: (ref: string) => CanvasImageSource | null,
): { style: string | CanvasGradient | CanvasPattern } | { missing: string } | null {
  if (paint.type === "SOLID") {
    if (!paint.color) return null;
    return { style: cssColor(paint.color.r, paint.color.g, paint.color.b, paint.color.a ?? 1) };
  }
  if (
    paint.type === "GRADIENT_LINEAR" ||
    paint.type === "GRADIENT_RADIAL" ||
    paint.type === "GRADIENT_ANGULAR" ||
    paint.type === "GRADIENT_DIAMOND"
  ) {
    const gradient = buildGradient(ctx, paint, width, height);
    return gradient ? { style: gradient } : null;
  }
  if (paint.type === "IMAGE") {
    const resolved = resolveImage(ctx, paint, width, height, imageForRef);
    if (!resolved) return null;
    if ("missing" in resolved) return resolved;
    return { style: resolved };
  }
  return null;
}

/** Whether the paint's fill area must be clipped to a diamond (GRADIENT_DIAMOND approximation). */
export function isDiamond(paint: Paint): boolean {
  return paint.type === "GRADIENT_DIAMOND";
}

/** Clip path a diamond fill is drawn within (GRADIENT_DIAMOND approximation), local coordinates. */
export function diamondClip(width: number, height: number): RenderPath {
  return diamondPath(width, height);
}

/** The shapes a paint covers: its own geometry argument, kept for call-site clarity. */
export type PaintShapes = Shape[];
