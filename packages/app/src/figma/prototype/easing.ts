// Cubic-bezier easing for prototype transitions (spec 32.5.3). Figma names the curves on the
// interaction; the player maps each name to a preset control-point pair and solves the curve
// per animation frame. Unknown names fall back to ease-in-and-out, matching Figma's default.

export type EasingName = "LINEAR" | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT" | "GENTLE_SPRING";

export type EasingFn = (t: number) => number;

export const EASING_PRESETS: Record<EasingName, readonly [number, number, number, number]> = {
  LINEAR: [0, 0, 1, 1],
  EASE_IN: [0.7, 0, 0.84, 0],
  EASE_OUT: [0.16, 1, 0.3, 1],
  EASE_IN_AND_OUT: [0.83, 0, 0.17, 1],
  GENTLE_SPRING: [0.175, 0.885, 0.32, 1.275],
};

const EASING_NAMES = new Set<string>(Object.keys(EASING_PRESETS));

export function isEasingName(value: string): value is EasingName {
  return EASING_NAMES.has(value);
}

/**
 * Solves the bezier curve (0,0)→(x1,y1)→(x2,y2)→(1,1) for progress x, returning y.
 * Newton iteration on x with a bisection fallback; y may overshoot 1 when control points do.
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): EasingFn {
  const sampleX = (t: number) => bezierAxis(t, x1, x2);
  const sampleY = (t: number) => bezierAxis(t, y1, y2);
  return (progress: number) => {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    if (x1 === 0 && y1 === 0 && x2 === 1 && y2 === 1) return progress;
    let t = progress;
    for (let i = 0; i < 8; i += 1) {
      const x = sampleX(t) - progress;
      if (Math.abs(x) < 1e-5) return sampleY(t);
      const slope = bezierSlope(t, x1, x2);
      if (Math.abs(slope) < 1e-6) break;
      t -= x / slope;
    }
    return sampleY(bisectToX(progress, sampleX));
  };
}

function bezierAxis(t: number, p1: number, p2: number): number {
  const inv = 1 - t;
  return 3 * inv * inv * t * p1 + 3 * inv * t * t * p2 + t * t * t;
}

function bezierSlope(t: number, p1: number, p2: number): number {
  const inv = 1 - t;
  return 3 * inv * inv * p1 + 6 * inv * t * (p2 - p1) + 3 * t * t * (1 - p2);
}

function bisectToX(x: number, sampleX: (t: number) => number): number {
  let low = 0;
  let high = 1;
  let t = x;
  for (let i = 0; i < 24; i += 1) {
    const value = sampleX(t);
    if (Math.abs(value - x) < 1e-5) return t;
    if (value < x) low = t;
    else high = t;
    t = (low + high) / 2;
  }
  return t;
}

const EASING_FNS = new Map<EasingName, EasingFn>();

export function easingFor(name: EasingName): EasingFn {
  const cached = EASING_FNS.get(name);
  if (cached) return cached;
  const [x1, y1, x2, y2] = EASING_PRESETS[name];
  const fn = cubicBezier(x1, y1, x2, y2);
  EASING_FNS.set(name, fn);
  return fn;
}

/**
 * Resolves a wire easing string; anything unknown behaves like EASE_IN_AND_OUT.
 * The daemon appends the control points for custom curves: `CUSTOM_CUBIC_BEZIER(0.42,0,0.58,1)`
 * (packages/server/src/server/figma/prototype.ts `easingName`); spaces are accepted too. The
 * x control points are clamped to [0, 1] like CSS cubic-bezier; y may overshoot (springs).
 */
const CUSTOM_CURVE =
  /CUSTOM_CUBIC_BEZIER[\s(]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)?/i;

const CUSTOM_FNS = new Map<string, EasingFn>();

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveEasing(name: string | undefined | null): EasingFn {
  if (name && isEasingName(name)) return easingFor(name);
  const match = name ? CUSTOM_CURVE.exec(name) : null;
  if (match) {
    const points = match.slice(1, 5).map(Number);
    if (points.every(Number.isFinite)) {
      const key = points.join(",");
      const cached = CUSTOM_FNS.get(key);
      if (cached) return cached;
      const fn = cubicBezier(clampUnit(points[0]), points[1], clampUnit(points[2]), points[3]);
      CUSTOM_FNS.set(key, fn);
      return fn;
    }
  }
  return easingFor("EASE_IN_AND_OUT");
}
