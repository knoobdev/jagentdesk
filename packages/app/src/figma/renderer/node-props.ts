// Typed readers for the Figma REST node fields the renderer consumes. `FigmaNode` is a passthrough
// bag (`[property: string]: unknown`), so every field access goes through these narrowings.
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  boundsOfRect,
  identity,
  multiply,
  readBounds,
  readMatrix,
  readNumber,
  rotate,
  type Bounds,
  type RenderMatrix,
} from "./matrix";

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface Paint {
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: RGBA;
  gradientHandlePositions?: { x: number; y: number }[];
  gradientStops?: { position: number; color: RGBA }[];
  imageRef?: string;
  scaleMode?: string;
  imageTransform?: RenderMatrix;
}

export interface Effect {
  type: string;
  visible?: boolean;
  color?: RGBA;
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  blurType?: string;
  blendMode?: string;
}

export interface GeometryPath {
  path: string;
  windingRule: string;
}

export interface TextStyle {
  fontFamily?: string;
  fontStyle?: string;
  fontWeight?: number;
  fontSize?: number;
  italic?: boolean;
  letterSpacing?: number;
  lineHeightUnit?: string;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textCase?: string;
  textDecoration?: string;
}

export interface TextRun {
  start: number;
  end: number;
  text: string;
  style: TextStyle;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readColor(value: unknown): RGBA | undefined {
  if (!isRecord(value)) return undefined;
  const r = readNumber(value.r);
  const g = readNumber(value.g);
  const b = readNumber(value.b);
  if (r === null || g === null || b === null) return undefined;
  return { r, g, b, a: readNumber(value.a) ?? 1 };
}

function readPaint(value: unknown): Paint | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  const paint: Paint = { type: value.type };
  if (typeof value.visible === "boolean") paint.visible = value.visible;
  const opacity = readNumber(value.opacity);
  if (opacity !== null) paint.opacity = opacity;
  if (typeof value.blendMode === "string") paint.blendMode = value.blendMode;
  const color = readColor(value.color);
  if (color) paint.color = color;
  if (Array.isArray(value.gradientHandlePositions)) {
    const handles = value.gradientHandlePositions.filter(isRecord);
    if (handles.length) {
      paint.gradientHandlePositions = handles.map((h) => ({
        x: readNumber(h.x) ?? 0,
        y: readNumber(h.y) ?? 0,
      }));
    }
  }
  if (Array.isArray(value.gradientStops)) {
    const stops: { position: number; color: RGBA }[] = [];
    for (const stop of value.gradientStops) {
      if (!isRecord(stop)) continue;
      const position = readNumber(stop.position);
      const stopColor = readColor(stop.color);
      if (position === null || !stopColor) continue;
      stops.push({ position, color: stopColor });
    }
    if (stops.length) paint.gradientStops = stops;
  }
  if (typeof value.imageRef === "string") paint.imageRef = value.imageRef;
  if (typeof value.scaleMode === "string") paint.scaleMode = value.scaleMode;
  const transform = readMatrix(value.imageTransform);
  if (transform) paint.imageTransform = transform;
  return paint;
}

/** Paints in bottom-to-top order (Figma's array order), skipping invisible entries. */
export function paintsOf(node: FigmaNode, field: "fills" | "strokes"): Paint[] {
  const value = node[field];
  if (!Array.isArray(value)) return [];
  const out: Paint[] = [];
  for (const entry of value) {
    const paint = readPaint(entry);
    if (paint && paint.visible !== false) out.push(paint);
  }
  return out;
}

export function effectsOf(node: FigmaNode): Effect[] {
  const value = node.effects;
  if (!Array.isArray(value)) return [];
  const out: Effect[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.type !== "string") continue;
    const effect: Effect = { type: entry.type };
    if (typeof entry.visible === "boolean") effect.visible = entry.visible;
    const color = readColor(entry.color);
    if (color) effect.color = color;
    if (isRecord(entry.offset)) {
      const x = readNumber(entry.offset.x);
      const y = readNumber(entry.offset.y);
      if (x !== null && y !== null) effect.offset = { x, y };
    }
    const radius = readNumber(entry.radius);
    if (radius !== null) effect.radius = radius;
    const spread = readNumber(entry.spread);
    if (spread !== null) effect.spread = spread;
    if (typeof entry.blurType === "string") effect.blurType = entry.blurType;
    if (typeof entry.blendMode === "string") effect.blendMode = entry.blendMode;
    out.push(effect);
  }
  return out;
}

export function geometryOf(
  node: FigmaNode,
  field: "fillGeometry" | "strokeGeometry",
): GeometryPath[] | null {
  const value = node[field];
  if (!Array.isArray(value)) return null;
  const out: GeometryPath[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.path !== "string") continue;
    out.push({
      path: entry.path,
      windingRule: typeof entry.windingRule === "string" ? entry.windingRule : "NONZERO",
    });
  }
  return out;
}

/**
 * The node's local→absolute matrix. Figma Link data carries `absoluteTransform` and wins. REST
 * nodes (`GET /v1/files/:key/nodes?geometry=paths`) never have it: position comes from
 * `absoluteBoundingBox` (falling back to `absoluteRenderBounds`, whose x/y are equally absolute,
 * for nodes that omit a bounding box). `relativeTransform` is parent-relative, so only its linear
 * part — rotation/skew — is used; its translation would double-count ancestors already baked into
 * the absolute box. The rotated local box is anchored so its corners' extents land on the box:
 * Figma's `absoluteBoundingBox` is the axis-aligned bounds of the rotated shape.
 */
export function nodeTransform(node: FigmaNode): RenderMatrix | null {
  const absolute = readMatrix(node.absoluteTransform);
  if (absolute) return absolute;
  const box = absoluteBoxOf(node) ?? readBounds(node.absoluteRenderBounds);
  if (!box) return null;
  const rel = readMatrix(node.relativeTransform);
  let linear: RenderMatrix = rel ? { ...rel, e: 0, f: 0 } : identity();
  const rotation = readNumber(node.rotation);
  if (rotation) linear = multiply(linear, rotate(rotation));
  const { width, height } = nodeSize(node);
  const placed = boundsOfRect(linear, width, height);
  return { ...linear, e: box.x - placed.x, f: box.y - placed.y };
}

export function absoluteBoxOf(node: FigmaNode): Bounds | null {
  return readBounds(node.absoluteBoundingBox);
}

export function nodeSize(node: FigmaNode): { width: number; height: number } {
  const box = absoluteBoxOf(node);
  // REST `geometry=paths` nodes carry the unrotated dimensions in `size`; the bounding box is
  // post-transform, so a rotated node's local shape must be measured against `size`.
  const size = isRecord(node.size) ? node.size : null;
  const width = readNumber(node.width) ?? (size ? readNumber(size.x) : null) ?? box?.width ?? 0;
  const height = readNumber(node.height) ?? (size ? readNumber(size.y) : null) ?? box?.height ?? 0;
  return { width, height };
}

function readTextStyle(value: unknown): TextStyle | null {
  if (!isRecord(value)) return null;
  const style: TextStyle = {};
  if (typeof value.fontFamily === "string") style.fontFamily = value.fontFamily;
  if (typeof value.fontStyle === "string") style.fontStyle = value.fontStyle;
  const fontWeight = readNumber(value.fontWeight);
  if (fontWeight !== null) style.fontWeight = fontWeight;
  const fontName = value.fontName;
  if (isRecord(fontName)) {
    if (typeof fontName.family === "string") style.fontFamily = fontName.family;
    if (typeof fontName.style === "string") style.fontStyle = fontName.style;
  }
  const fontSize = readNumber(value.fontSize);
  if (fontSize !== null) style.fontSize = fontSize;
  const letterSpacing = readNumber(value.letterSpacing);
  if (letterSpacing !== null) style.letterSpacing = letterSpacing;
  if (typeof value.lineHeightUnit === "string") style.lineHeightUnit = value.lineHeightUnit;
  const lineHeightPx = readNumber(value.lineHeightPx);
  if (lineHeightPx !== null) style.lineHeightPx = lineHeightPx;
  const lineHeightPercent = readNumber(value.lineHeightPercentFontSize);
  if (lineHeightPercent !== null) style.lineHeightPercent = lineHeightPercent;
  if (typeof value.textAlignHorizontal === "string")
    style.textAlignHorizontal = value.textAlignHorizontal;
  if (typeof value.textAlignVertical === "string")
    style.textAlignVertical = value.textAlignVertical;
  if (typeof value.textCase === "string") style.textCase = value.textCase;
  if (typeof value.textDecoration === "string") style.textDecoration = value.textDecoration;
  return style;
}

export function baseTextStyle(node: FigmaNode): TextStyle {
  return readTextStyle(node.style) ?? {};
}

/**
 * Characters split into runs sharing a style: the base style plus `styleOverrideTable[ id ]` for
 * every character whose `characterStyleOverrides` entry names that style (Figma uses -1/absent for
 * the base style).
 */
export function textRuns(node: FigmaNode): TextRun[] {
  const characters = typeof node.characters === "string" ? node.characters : "";
  const base = baseTextStyle(node);
  const overrides = Array.isArray(node.characterStyleOverrides)
    ? (node.characterStyleOverrides as unknown[])
    : [];
  const table = isRecord(node.styleOverrideTable) ? node.styleOverrideTable : {};
  const runs: TextRun[] = [];
  let runStyleKey: string | null = null;
  let runStyle: TextStyle = base;
  for (let i = 0; i < characters.length; i++) {
    const rawKey = overrides[i];
    // REST documents 0 as the default-style marker (trailing zeros are stripped, and shorter
    // arrays mean the rest is default too); the plugin API's -1 and absent entries also map to
    // the base style. Anything else names a styleOverrideTable entry.
    const key =
      rawKey === undefined || rawKey === null || rawKey === -1 || rawKey === 0
        ? ""
        : String(rawKey);
    if (key !== runStyleKey) {
      runStyleKey = key;
      runStyle = key === "" ? base : mergeStyle(base, readTextStyle(table[key]) ?? {});
    }
    const last = runs[runs.length - 1];
    if (last && last.style === runStyle) {
      last.text += characters[i];
      last.end = i + 1;
    } else {
      runs.push({ start: i, end: i + 1, text: characters[i], style: runStyle });
    }
  }
  return runs;
}

function mergeStyle(base: TextStyle, patch: TextStyle): TextStyle {
  return { ...base, ...patch };
}

/** Effective style for the whole node (base merged with an override), used for measurement. */
export function effectiveStyle(node: FigmaNode): TextStyle {
  return baseTextStyle(node);
}

export function textAligns(node: FigmaNode): {
  horizontal: string;
  vertical: string;
  autoResize: string;
} {
  const style = readTextStyle(node.style) ?? {};
  const top = typeof node.textAlignHorizontal === "string" ? node.textAlignHorizontal : null;
  const horizontal = top ?? style.textAlignHorizontal ?? "LEFT";
  const verticalTop = typeof node.textAlignVertical === "string" ? node.textAlignVertical : null;
  const vertical = verticalTop ?? style.textAlignVertical ?? "TOP";
  const autoResize = typeof node.textAutoResize === "string" ? node.textAutoResize : "NONE";
  return { horizontal, vertical, autoResize };
}

export function cornerRadii(node: FigmaNode): [number, number, number, number] {
  const uniform = readNumber(node.cornerRadius);
  if (uniform !== null) return [uniform, uniform, uniform, uniform];
  const perCorner = node.rectangleCornerRadii;
  if (Array.isArray(perCorner) && perCorner.length === 4) {
    return perCorner.map((v) => readNumber(v) ?? 0) as [number, number, number, number];
  }
  const tl = readNumber(node.topLeftRadius) ?? 0;
  const tr = readNumber(node.topRightRadius) ?? 0;
  const br = readNumber(node.bottomRightRadius) ?? 0;
  const bl = readNumber(node.bottomLeftRadius) ?? 0;
  return [tl, tr, br, bl];
}

export function strokeSettings(node: FigmaNode): {
  weight: number;
  align: string;
  dashes: number[];
  cap: string;
  join: string;
} {
  return {
    weight: readNumber(node.strokeWeight) ?? 0,
    align: typeof node.strokeAlign === "string" ? node.strokeAlign : "CENTER",
    dashes: Array.isArray(node.strokeDashes)
      ? (node.strokeDashes as unknown[]).map((v) => readNumber(v) ?? 0).filter((v) => v > 0)
      : [],
    cap: typeof node.strokeCap === "string" ? node.strokeCap : "NONE",
    join: typeof node.strokeJoin === "string" ? node.strokeJoin : "MITER",
  };
}

export function nodeOpacity(node: FigmaNode): number {
  const opacity = readNumber(node.opacity);
  return opacity === null ? 1 : Math.min(1, Math.max(0, opacity));
}

export function nodeBlendMode(node: FigmaNode): string | null {
  return typeof node.blendMode === "string" &&
    node.blendMode !== "PASS_THROUGH" &&
    node.blendMode !== "NORMAL"
    ? node.blendMode
    : null;
}

export function isNodeVisible(node: FigmaNode): boolean {
  return node.visible !== false;
}

export function isMask(node: FigmaNode): boolean {
  return node.isMask === true;
}

export function maskType(node: FigmaNode): string {
  return typeof node.maskType === "string" ? node.maskType : "ALPHA";
}

export function clipsContent(node: FigmaNode): boolean {
  return node.clipsContent === true;
}

/**
 * The node's list style when it is a bullet/numbered list. REST TEXTNode carries lists as
 * top-level `lineTypes`/`lineIndentations` (one entry per line); `styles.listStyles` is the
 * Figma-plugin spelling kept for Link data. Undefined for plain text.
 */
export function listStyleOf(node: FigmaNode): unknown {
  const lineTypes = node.lineTypes;
  if (
    Array.isArray(lineTypes) &&
    lineTypes.some((type) => type === "ORDERED" || type === "UNORDERED")
  ) {
    return lineTypes;
  }
  const styles = node.styles;
  if (isRecord(styles) && styles.listStyles !== undefined) return styles.listStyles;
  return undefined;
}

/** True when the base style or any override style carries a hyperlink (TypeStyle.hyperlink). */
export function hasHyperlinks(node: FigmaNode): boolean {
  if (hasHyperlinkIn(node.style)) return true;
  const table = node.styleOverrideTable;
  if (isRecord(table)) {
    for (const entry of Object.values(table)) {
      if (hasHyperlinkIn(entry)) return true;
    }
  }
  return false;
}

function hasHyperlinkIn(style: unknown): boolean {
  return isRecord(style) && style.hyperlink != null;
}

export function pointCountOf(node: FigmaNode): number {
  return Math.max(3, Math.round(readNumber(node.pointCount) ?? 3));
}

export function starInnerRadius(node: FigmaNode): number {
  const value = readNumber(node.innerRadius) ?? readNumber(node.starInnerScale);
  if (value === null) return 0.381966;
  return Math.min(1, Math.max(0, value));
}

export function cornerSmoothing(node: FigmaNode): number {
  return readNumber(node.cornerSmoothing) ?? 0;
}

export function booleanOperationOf(node: FigmaNode): string | null {
  return typeof node.booleanOperation === "string" ? node.booleanOperation : null;
}
