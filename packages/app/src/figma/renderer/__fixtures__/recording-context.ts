// A recording fake of the Canvas 2D context for renderer unit tests (spec 32.11 #12). It records
// every call and property assignment the renderer performs, in order, as plain data so tests can
// assert the exact drawing command stream per fixture without a real rasterizer.
import { RecordingPath } from "../render-path";

export type RecordedOp = unknown[];

export interface FakeImage {
  fakeImage: string;
  width: number;
  height: number;
}

export function fakeImage(ref: string, width = 120, height = 80): FakeImage {
  return { fakeImage: ref, width, height };
}

interface RecordedGradient {
  kind: "linear" | "radial" | "conic";
  args: number[];
  stops: [number, string][];
}

interface RecordedPattern {
  image: FakeImage;
  repetition: string;
  transform: Record<string, number> | null;
}

function serializeValue(value: unknown): unknown {
  if (value instanceof RecordingPath) {
    return value.svgData !== null ? { svg: value.svgData } : { commands: value.commands };
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if ("__gradient" in obj) {
      const g = obj.__gradient as RecordedGradient;
      return { gradient: { kind: g.kind, args: g.args, stops: g.stops } };
    }
    if ("__pattern" in obj) {
      const p = obj.__pattern as RecordedPattern;
      return { pattern: { ...p, image: p.image.fakeImage } };
    }
    if ("__path" in obj) return obj.__path;
  }
  return value;
}

class FakeGradient {
  readonly __gradient: RecordedGradient;
  constructor(kind: RecordedGradient["kind"], args: number[]) {
    this.__gradient = { kind, args, stops: [] };
  }
  addColorStop(offset: number, color: string): void {
    this.__gradient.stops.push([offset, color]);
  }
}

class FakePattern {
  readonly __pattern: RecordedPattern;
  constructor(image: FakeImage, repetition: string) {
    this.__pattern = { image, repetition, transform: null };
  }
  setTransform(
    matrix: { a: number; b: number; c: number; d: number; e: number; f: number } | null,
  ): void {
    this.__pattern.transform = matrix ? { ...matrix } : null;
  }
}

/** The recording context: implements the subset of CanvasRenderingContext2D the renderer uses. */
export class RecordingContext {
  readonly ops: RecordedOp[] = [];

  save(): void {
    this.ops.push(["save"]);
  }
  restore(): void {
    this.ops.push(["restore"]);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ops.push(["setTransform", a, b, c, d, e, f]);
  }
  translate(x: number, y: number): void {
    this.ops.push(["translate", x, y]);
  }
  scale(sx: number, sy: number): void {
    this.ops.push(["scale", sx, sy]);
  }
  beginPath(): void {
    this.ops.push(["beginPath"]);
  }
  fill(path?: unknown, rule?: string): void {
    this.ops.push(["fill", serializeValue(path), rule ?? null]);
  }
  stroke(path?: unknown): void {
    this.ops.push(["stroke", serializeValue(path)]);
  }
  clip(path?: unknown, rule?: string): void {
    this.ops.push(["clip", serializeValue(path), rule ?? null]);
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(["fillRect", x, y, w, h]);
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(["strokeRect", x, y, w, h]);
  }
  clearRect(x: number, y: number, w: number, h: number): void {
    this.ops.push(["clearRect", x, y, w, h]);
  }
  fillText(text: string, x: number, y: number): void {
    this.ops.push(["fillText", text, x, y]);
  }
  strokeText(text: string, x: number, y: number): void {
    this.ops.push(["strokeText", text, x, y]);
  }
  drawImage(image: unknown, dx: number, dy: number, dw?: number, dh?: number): void {
    const tag = (image as FakeImage | null)?.fakeImage ?? "unknown";
    this.ops.push(["drawImage", tag, dx, dy, dw ?? null, dh ?? null]);
  }
  setLineDash(dashes: number[]): void {
    this.ops.push(["setLineDash", [...dashes]]);
  }
  getLineDash(): number[] {
    return [];
  }
  measureText(text: string): TextMetrics {
    this.ops.push(["measureText", text]);
    const size = fontPixelSize(this.fontValue);
    const width = text.length * size * 0.5;
    return {
      width,
      actualBoundingBoxAscent: size * 0.8,
      actualBoundingBoxDescent: size * 0.2,
    } as TextMetrics;
  }
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): unknown {
    this.ops.push(["createLinearGradient", x0, y0, x1, y1]);
    return new FakeGradient("linear", [x0, y0, x1, y1]);
  }
  createRadialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
  ): unknown {
    this.ops.push(["createRadialGradient", x0, y0, r0, x1, y1, r1]);
    return new FakeGradient("radial", [x0, y0, r0, x1, y1, r1]);
  }
  createConicGradient(startAngle: number, x: number, y: number): unknown {
    this.ops.push(["createConicGradient", startAngle, x, y]);
    return new FakeGradient("conic", [startAngle, x, y]);
  }
  createPattern(image: unknown, repetition: string | null): unknown {
    this.ops.push([
      "createPattern",
      (image as FakeImage | null)?.fakeImage ?? "unknown",
      repetition,
    ]);
    return new FakePattern(image as FakeImage, repetition ?? "no-repeat");
  }

  // Properties that the renderer sets are recorded on assignment.
  fontValue = "";
  set font(value: string) {
    this.fontValue = value;
    this.ops.push(["set:font", value]);
  }
  get font(): string {
    return this.fontValue;
  }
  set fillStyle(value: unknown) {
    this.ops.push(["set:fillStyle", serializeValue(value)]);
  }
  set strokeStyle(value: unknown) {
    this.ops.push(["set:strokeStyle", serializeValue(value)]);
  }
  set globalAlpha(value: number) {
    this.ops.push(["set:globalAlpha", value]);
  }
  set globalCompositeOperation(value: string) {
    this.ops.push(["set:globalCompositeOperation", value]);
  }
  set filter(value: string) {
    this.ops.push(["set:filter", value]);
  }
  lineWidthValue = 1;
  set lineWidth(value: number) {
    this.lineWidthValue = value;
    this.ops.push(["set:lineWidth", value]);
  }
  get lineWidth(): number {
    return this.lineWidthValue;
  }
  set lineCap(value: string) {
    this.ops.push(["set:lineCap", value]);
  }
  set lineJoin(value: string) {
    this.ops.push(["set:lineJoin", value]);
  }
  set miterLimit(value: number) {
    this.ops.push(["set:miterLimit", value]);
  }
  set textAlign(value: string) {
    this.ops.push(["set:textAlign", value]);
  }
  set textBaseline(value: string) {
    this.ops.push(["set:textBaseline", value]);
  }
  set letterSpacing(value: string) {
    this.ops.push(["set:letterSpacing", value]);
  }
  set shadowColor(value: string) {
    this.ops.push(["set:shadowColor", value]);
  }
  set shadowBlur(value: number) {
    this.ops.push(["set:shadowBlur", value]);
  }
  set shadowOffsetX(value: number) {
    this.ops.push(["set:shadowOffsetX", value]);
  }
  set shadowOffsetY(value: number) {
    this.ops.push(["set:shadowOffsetY", value]);
  }
}

function fontPixelSize(font: string): number {
  const match = font.match(/(\d+(?:\.\d+)?)px/);
  return match ? Number(match[1]) : 16;
}

/** Path2D commands are exposed on the recording stand-in; serialize them when passed to ctx. */
export function recordPath(ctx: RecordingContext, path: unknown): void {
  ctx.ops.push(["path", serializeValue(path)]);
}
