// 2D affine matrices and rectangle math for the Figma renderer (spec 32.5.1). Figma's REST
// `absoluteTransform`/`relativeTransform` are 2×3 row matrices [[a,c,e],[b,d,f]]; this module
// converts them to the flat six-tuple Canvas' setTransform expects and does the few operations
// needed: compose, invert, transform points, and derive a node's absolute box.

/** Canvas setTransform(a, b, c, d, e, f): x' = a·x + c·y + e, y' = b·x + d·y + f. */
export interface RenderMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A JSON node field is only known to be `unknown` — these narrow it without `any`. */
export function readMatrix(value: unknown): RenderMatrix | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const rows = value as unknown[];
  const top = rows[0];
  const bottom = rows[1];
  if (!Array.isArray(top) || !Array.isArray(bottom) || top.length !== 3 || bottom.length !== 3) {
    return null;
  }
  const nums = [...(top as unknown[]), ...(bottom as unknown[])];
  if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) return null;
  const [a, c, e, b, d, f] = nums as number[];
  return { a, b, c, d, e, f };
}

export function readBounds(value: unknown): Bounds | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const { x, y, width, height } = raw;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  return { x, y, width, height };
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function identity(): RenderMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

export function translate(x: number, y: number): RenderMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scale(sx: number, sy: number): RenderMatrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function rotate(degrees: number): RenderMatrix {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

export function multiply(m: RenderMatrix, n: RenderMatrix): RenderMatrix {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function invert(m: RenderMatrix): RenderMatrix | null {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0 || !Number.isFinite(det)) return null;
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export function applyToPoint(m: RenderMatrix, p: Point): Point {
  return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

export function transformPoints(m: RenderMatrix, points: Point[]): Point[] {
  return points.map((p) => applyToPoint(m, p));
}

/** Axis-aligned box covering the transformed corners of a local rectangle (0,0,w,h). */
export function boundsOfRect(m: RenderMatrix, width: number, height: number): Bounds {
  const corners = transformPoints(m, [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ]);
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function pointInBounds(p: Point, b: Bounds): boolean {
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}
