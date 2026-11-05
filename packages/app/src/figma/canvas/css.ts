import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaColor } from "./protocol-types";

// CSS generation for the Inspect panel (spec 32.5.2). Input is a raw Figma REST node
// (`geometry=paths`); unknown or missing properties are skipped so partial nodes still produce
// partial CSS. Output is the declaration block body, one property per line, in a fixed order.

type Dict = Record<string, unknown>;

function asDict(value: unknown): Dict | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Dict)
    : null;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function colorToCss(color: unknown, paintOpacity?: unknown): string {
  const c = asDict(color);
  const r = clamp01(asNumber(c?.r) ?? 0);
  const g = clamp01(asNumber(c?.g) ?? 0);
  const b = clamp01(asNumber(c?.b) ?? 0);
  const a = clamp01((asNumber(c?.a) ?? 1) * (asNumber(paintOpacity) ?? 1));
  return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${round(a)})`;
}

/** Visible paints of one kind (fills/strokes), oldest-first as Figma returns them. */
function visiblePaints(node: Dict, property: "fills" | "strokes"): Dict[] {
  return asArray(node[property])
    .map((entry) => asDict(entry))
    .filter((paint): paint is Dict => paint !== null && paint.visible !== false);
}

function solidPaint(paints: Dict[]): Dict | null {
  return paints.find((paint) => paint.type === "SOLID") ?? null;
}

const GRADIENT_TYPES = [
  "GRADIENT_LINEAR",
  "GRADIENT_RADIAL",
  "GRADIENT_ANGULAR",
  "GRADIENT_DIAMOND",
] as const;
type GradientType = (typeof GRADIENT_TYPES)[number];
export type { GradientType };

function isGradientType(type: unknown): type is GradientType {
  return (GRADIENT_TYPES as readonly unknown[]).includes(type);
}

function gradientAngle(transform: unknown): number | undefined {
  // Figma's gradientTransform maps shape space → gradient space; CSS angles run clockwise from
  // "to top", so invert the x-axis of the 2×3 matrix and convert.
  const rows = asArray(transform).map((row) => asArray(row));
  if (rows.length < 2) return undefined;
  const [row0, row1] = rows;
  if (!row0 || !row1 || row0.length < 2 || row1.length < 2) return undefined;
  const a = asNumber(row0[0]);
  const b = asNumber(row1[0]);
  if (a === undefined || b === undefined) return undefined;
  const vx = b;
  const vy = -a;
  return round(((Math.atan2(vx, -vy) * 180) / Math.PI + 360) % 360, 0);
}

/**
 * Angle from REST `gradientHandlePositions`: three points in node-normalized space (top-left
 * 0,0 → bottom-right 1,1) where the first is the gradient start and the second its end. The CSS
 * angle runs clockwise from "to top", so left→right handles give 90deg and top→bottom 180deg.
 */
function handlePosition(handles: unknown, index: number): { x: number; y: number } | undefined {
  const point = asDict(asArray(handles)[index]);
  const x = asNumber(point?.x);
  const y = asNumber(point?.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function handleAngle(handles: unknown): number | undefined {
  const start = handlePosition(handles, 0);
  const end = handlePosition(handles, 1);
  if (!start || !end) return undefined;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return undefined;
  return round(((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360, 0);
}

/** Gradient geometry prefers REST handle positions and falls back to the Link gradientTransform. */
function gradientGeometry(paint: Dict): { angle?: number; center?: { x: number; y: number } } {
  const handles = paint.gradientHandlePositions;
  const angle = handleAngle(handles) ?? gradientAngle(paint.gradientTransform);
  const center = handlePosition(handles, 0);
  return {
    ...(angle === undefined ? {} : { angle }),
    ...(center
      ? { center: { x: round(clamp01(center.x) * 100), y: round(clamp01(center.y) * 100) } }
      : {}),
  };
}

function gradientStops(paint: Dict): string {
  return stopSpec(paint).join(", ");
}

function stopSpec(paint: Dict): string[] {
  return asArray(paint.gradientStops)
    .map((entry) => asDict(entry))
    .filter((stop): stop is Dict => stop !== null)
    .map(
      (stop) =>
        `${colorToCss(stop.color, stop.opacity)} ${round((asNumber(stop.position) ?? 0) * 100)}%`,
    );
}

function stopColors(paint: Dict): string[] {
  return asArray(paint.gradientStops)
    .map((entry) => asDict(entry))
    .filter((stop): stop is Dict => stop !== null)
    .map((stop) => colorToCss(stop.color, stop.opacity));
}

/** The CSS gradient function for one REST/Link paint, or null when it is not a gradient. */
export function gradientCss(paint: unknown): string | null {
  const dict = asDict(paint);
  if (!dict || !isGradientType(dict.type)) return null;
  const stops = gradientStops(dict);
  const geometry = gradientGeometry(dict);
  if (dict.type === "GRADIENT_LINEAR" || dict.type === "GRADIENT_DIAMOND") {
    // Diamond has no CSS equivalent; its axis reads as a linear gradient.
    return `linear-gradient(${geometry.angle ?? 180}deg, ${stops})`;
  }
  if (dict.type === "GRADIENT_RADIAL") {
    const at = geometry.center ? ` at ${geometry.center.x}% ${geometry.center.y}%` : "";
    return `radial-gradient(circle${at}, ${stops})`;
  }
  const at = geometry.center ? ` at ${geometry.center.x}% ${geometry.center.y}%` : "";
  return `conic-gradient(from ${geometry.angle ?? 0}deg${at}, ${stops})`;
}

export interface GradientFillInfo {
  type: GradientType;
  /** The CSS gradient function, also used to paint the inspect swatch. */
  css: string;
  /** The stop list, e.g. `rgba(255, 255, 255, 1) 0%, rgba(0, 0, 0, 1) 100%`. */
  stops: string;
  /** Stop colors in position order, for the native fallback swatch. */
  colors: string[];
  /** The gradient axis in normalized node space (REST handles; defaults to left→right). */
  start: { x: number; y: number };
  end: { x: number; y: number };
}

/** Visible gradient fills of a node, topmost paint list order as Figma returns them. */
export function gradientFills(node: FigmaNode): GradientFillInfo[] {
  const infos: GradientFillInfo[] = [];
  for (const paint of visiblePaints(node as unknown as Dict, "fills")) {
    const type = asString(paint.type);
    if (!isGradientType(type)) continue;
    const css = gradientCss(paint);
    if (!css) continue;
    infos.push({
      type,
      css,
      stops: gradientStops(paint),
      colors: stopColors(paint),
      start: handlePosition(paint.gradientHandlePositions, 0) ?? { x: 0, y: 0.5 },
      end: handlePosition(paint.gradientHandlePositions, 1) ?? { x: 1, y: 0.5 },
    });
  }
  return infos;
}

function backgroundFrom(paints: Dict[]): string[] {
  const lines: string[] = [];
  for (const paint of paints) {
    const type = asString(paint.type);
    if (type === "SOLID") {
      lines.push(`background: ${colorToCss(paint.color, paint.opacity)};`);
    } else if (isGradientType(type)) {
      const css = gradientCss(paint);
      if (css) lines.push(`background: ${css};`);
    } else if (type === "IMAGE") {
      const ref = asString(paint.imageRef);
      const fit = asString(paint.scaleMode) === "STRETCH" ? "100% 100%" : "cover";
      const repeat = asString(paint.scaleMode) === "TILE" ? "repeat" : "no-repeat";
      lines.push(`background: url("${ref ?? ""}") center / ${fit} ${repeat};`);
    }
  }
  return lines;
}

const ALIGN_H: Record<string, string> = {
  MIN: "flex-start",
  CENTER: "center",
  MAX: "flex-end",
  SPACE_BETWEEN: "space-between",
};
const ALIGN_V: Record<string, string> = { MIN: "flex-start", CENTER: "center", MAX: "flex-end" };

/**
 * CSS `padding` shorthand from the four REST sides: one value when all match, two when the
 * vertical and horizontal pairs match, otherwise the full top/right/bottom/left list.
 */
export function paddingShorthand(
  top: number | undefined,
  right: number | undefined,
  bottom: number | undefined,
  left: number | undefined,
): string {
  const t = round(top ?? 0);
  const r = round(right ?? 0);
  const b = round(bottom ?? 0);
  const l = round(left ?? 0);
  if (t === r && r === b && b === l) return `${t}px`;
  if (t === b && l === r) return `${t}px ${r}px`;
  return `${t}px ${r}px ${b}px ${l}px`;
}

function autoLayoutFrom(node: Dict): string[] {
  const mode = asString(node.layoutMode);
  const lines: string[] = [];
  if (mode === "HORIZONTAL" || mode === "VERTICAL") {
    lines.push("display: flex;");
    lines.push(`flex-direction: ${mode === "HORIZONTAL" ? "row" : "column"};`);
    const gap = asNumber(node.itemSpacing);
    if (gap !== undefined) lines.push(`gap: ${round(gap)}px;`);
    const top = asNumber(node.paddingTop);
    const right = asNumber(node.paddingRight);
    const bottom = asNumber(node.paddingBottom);
    const left = asNumber(node.paddingLeft);
    if (top !== undefined || right !== undefined || bottom !== undefined || left !== undefined) {
      lines.push(`padding: ${paddingShorthand(top, right, bottom, left)};`);
    }
    const primary = asString(node.primaryAxisAlignItems);
    if (primary && ALIGN_H[primary]) lines.push(`justify-content: ${ALIGN_H[primary]};`);
    const counter = asString(node.counterAxisAlignItems);
    if (counter && ALIGN_V[counter]) lines.push(`align-items: ${ALIGN_V[counter]};`);
  }
  const wrap = asString(node.layoutWrap);
  if (wrap === "WRAP") lines.push("flex-wrap: wrap;");
  return lines;
}

function radiusFrom(node: Dict): string[] {
  const radii = asArray(node.rectangleCornerRadii).map((entry) => asNumber(entry));
  if (radii.length === 4 && radii.every((entry) => entry !== undefined)) {
    const [topLeft, topRight, bottomRight, bottomLeft] = radii as [number, number, number, number];
    return [
      `border-radius: ${round(topLeft)}px ${round(topRight)}px ${round(bottomRight)}px ${round(bottomLeft)}px;`,
    ];
  }
  const radius = asNumber(node.cornerRadius);
  if (radius !== undefined) return [`border-radius: ${round(radius)}px;`];
  return [];
}

function strokesFrom(node: Dict): string[] {
  const paints = visiblePaints(node, "strokes");
  const solid = solidPaint(paints);
  const weight = asNumber(node.strokeWeight);
  if (!solid || weight === undefined || weight <= 0) return [];
  const dashPattern = asArray(node.dashPattern).map((entry) => asNumber(entry));
  const lines = [
    `border: ${round(weight)}px solid ${colorToCss(solid.color, solid.opacity)};`,
    "box-sizing: border-box;",
  ];
  if (dashPattern.length >= 2 && dashPattern.every((entry) => entry !== undefined)) {
    lines.push(`border-style: dashed; /* dash ${dashPattern.join(" ")} */`);
  }
  return lines;
}

function effectsFrom(node: Dict): string[] {
  const shadows: string[] = [];
  const lines: string[] = [];
  for (const entry of asArray(node.effects)) {
    const effect = asDict(entry);
    if (!effect || effect.visible === false) continue;
    const type = asString(effect.type);
    const color = colorToCss(effect.color, effect.opacity);
    if (type === "DROP_SHADOW" || type === "INNER_SHADOW") {
      // REST (and the Link serializer) name the blur amount `radius`; `spread` defaults to 0.
      const offset = asDict(effect.offset);
      const x = round(asNumber(offset?.x) ?? 0);
      const y = round(asNumber(offset?.y) ?? 0);
      const blur = round(asNumber(effect.radius) ?? 0);
      const spread = round(asNumber(effect.spread) ?? 0);
      shadows.push(
        `${type === "INNER_SHADOW" ? "inset " : ""}${x}px ${y}px ${blur}px ${spread}px ${color}`,
      );
    } else if (type === "LAYER_BLUR") {
      lines.push(`filter: blur(${round(asNumber(effect.radius) ?? 0)}px);`);
    } else if (type === "BACKGROUND_BLUR") {
      lines.push(`backdrop-filter: blur(${round(asNumber(effect.radius) ?? 0)}px);`);
    }
  }
  if (shadows.length > 0) lines.unshift(`box-shadow: ${shadows.join(", ")};`);
  return lines;
}

function weightOfStyle(style: string | undefined): number {
  const named: Record<string, number> = {
    thin: 100,
    extralight: 200,
    ultralight: 200,
    light: 300,
    regular: 400,
    normal: 400,
    medium: 500,
    semibold: 600,
    demibold: 600,
    bold: 700,
    extrabold: 800,
    ultrabold: 800,
    black: 900,
    heavy: 900,
  };
  if (!style) return 400;
  const words = style.toLowerCase().split(/[^a-z]+/);
  for (const word of words) {
    if (named[word] !== undefined) return named[word];
  }
  return 400;
}

// eslint-disable-next-line complexity
function textFrom(node: Dict): string[] {
  if (asString(node.type) !== "TEXT") return [];
  const style = asDict(node.style) ?? {};
  const fontName = asDict(style.fontName);
  const lines: string[] = [];
  const family = asString(fontName?.family);
  if (family) lines.push(`font-family: "${family}";`);
  const styleName = asString(fontName?.style);
  const weight = weightOfStyle(styleName);
  if (weight !== 400) lines.push(`font-weight: ${weight};`);
  if (styleName && /italic|oblique/i.test(styleName)) lines.push("font-style: italic;");
  const size = asNumber(style.fontSize);
  if (size !== undefined) lines.push(`font-size: ${round(size)}px;`);
  const lineHeightPx = asNumber(style.lineHeightPx);
  const lineHeightPercent = asNumber(style.lineHeightPercent);
  if (lineHeightPx !== undefined) lines.push(`line-height: ${round(lineHeightPx)}px;`);
  else if (lineHeightPercent !== undefined && size !== undefined)
    lines.push(`line-height: ${round((lineHeightPercent / 100) * size)}px;`);
  const letterSpacing = style.letterSpacing;
  if (typeof letterSpacing === "number") lines.push(`letter-spacing: ${round(letterSpacing)}px;`);
  else {
    const ls = asDict(letterSpacing);
    const unit = asString(ls?.unit);
    const value = asNumber(ls?.value);
    if (unit === "PIXELS" && value !== undefined) lines.push(`letter-spacing: ${round(value)}px;`);
    if (unit === "PERCENT" && value !== undefined)
      lines.push(`letter-spacing: ${round(value / 100)}em;`);
  }
  const align = asString(style.textAlignHorizontal);
  if (align === "CENTER") lines.push("text-align: center;");
  if (align === "RIGHT") lines.push("text-align: right;");
  if (align === "JUSTIFIED") lines.push("text-align: justify;");
  const decoration = asString(style.textDecoration);
  if (decoration === "UNDERLINE") lines.push("text-decoration: underline;");
  if (decoration === "STRIKETHROUGH") lines.push("text-decoration: line-through;");
  const textCase = asString(style.textCase);
  if (textCase === "UPPER") lines.push("text-transform: uppercase;");
  if (textCase === "LOWER") lines.push("text-transform: lowercase;");
  const solid = solidPaint(visiblePaints(node, "fills"));
  if (solid) lines.push(`color: ${colorToCss(solid.color, solid.opacity)};`);
  return lines;
}

const BLEND: Record<string, string> = {
  MULTIPLY: "multiply",
  SCREEN: "screen",
  OVERLAY: "overlay",
  DARKEN: "darken",
  LIGHTEN: "lighten",
  COLOR_DODGE: "color-dodge",
  COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light",
  SOFT_LIGHT: "soft-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity",
};

/** CSS for a node's Dev-Inspect-visible properties; "" when nothing can be expressed. */
export function generateNodeCss(node: FigmaNode): string {
  const lines: string[] = [];
  const bounds = asDict(node.absoluteBoundingBox);
  const width = asNumber(bounds?.width);
  const height = asNumber(bounds?.height);
  if (width !== undefined) lines.push(`width: ${round(width)}px;`);
  if (height !== undefined) lines.push(`height: ${round(height)}px;`);
  const x = asNumber(bounds?.x);
  const y = asNumber(bounds?.y);
  if (x !== undefined && y !== undefined) {
    lines.push("position: absolute;");
    lines.push(`left: ${round(x)}px;`);
    lines.push(`top: ${round(y)}px;`);
  }
  const type = asString(node.type);
  if (type !== "TEXT")
    lines.push(...backgroundFrom(visiblePaints(node as unknown as Dict, "fills")));
  const opacity = asNumber(node.opacity);
  if (opacity !== undefined && opacity < 1) lines.push(`opacity: ${round(opacity)};`);
  lines.push(...radiusFrom(node));
  lines.push(...strokesFrom(node));
  lines.push(...effectsFrom(node));
  lines.push(...autoLayoutFrom(node));
  lines.push(...textFrom(node));
  const blend = asString(node.blendMode);
  if (blend && blend !== "NORMAL" && BLEND[blend]) lines.push(`mix-blend-mode: ${BLEND[blend]};`);
  return lines.join("\n");
}

export function isTextLike(node: FigmaNode): boolean {
  return typeof node.type === "string" && node.type === "TEXT";
}

export function figmaColorFromHex(hex: string): FigmaColor {
  const value = hex.trim().replace(/^#/, "");
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
    throw new Error(`not a hex color: ${hex}`);
  }
  const channel = (start: number, end: number) => parseInt(value.slice(start, end), 16) / 255;
  return {
    r: channel(0, 2),
    g: channel(2, 4),
    b: channel(4, 6),
    a: value.length === 8 ? channel(6, 8) : 1,
  };
}

export function firstSolidColor(node: FigmaNode): FigmaColor | null {
  const solid = solidPaint(visiblePaints(node as unknown as Dict, "fills"));
  if (!solid) return null;
  const color = asDict(solid.color);
  return {
    r: asNumber(color?.r) ?? 0,
    g: asNumber(color?.g) ?? 0,
    b: asNumber(color?.b) ?? 0,
    a: (asNumber(color?.a) ?? 1) * (asNumber(solid.opacity) ?? 1),
  };
}
