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

function gradientStops(paint: Dict): string {
  const stops = asArray(paint.gradientStops)
    .map((entry) => asDict(entry))
    .filter((stop): stop is Dict => stop !== null)
    .map(
      (stop) =>
        `${colorToCss(stop.color, stop.opacity)} ${round((asNumber(stop.position) ?? 0) * 100)}%`,
    );
  return stops.join(", ");
}

function backgroundFrom(paints: Dict[]): string[] {
  const lines: string[] = [];
  for (const paint of paints) {
    const type = asString(paint.type);
    if (type === "SOLID") {
      lines.push(`background: ${colorToCss(paint.color, paint.opacity)};`);
    } else if (type === "GRADIENT_LINEAR") {
      const angle = gradientAngle(paint.gradientTransform);
      lines.push(`background: linear-gradient(${angle ?? 180}deg, ${gradientStops(paint)});`);
    } else if (type === "GRADIENT_RADIAL") {
      lines.push(`background: radial-gradient(circle, ${gradientStops(paint)});`);
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
      lines.push(
        `padding: ${round(top ?? 0)}px ${round(right ?? 0)}px ${round(bottom ?? 0)}px ${round(left ?? 0)}px;`,
      );
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
      const offset = asDict(effect.offset);
      const x = round(asNumber(offset?.x) ?? 0);
      const y = round(asNumber(offset?.y) ?? 0);
      const blur = round(asNumber(effect.blur) ?? 0);
      const spread = round(asNumber(effect.spread) ?? 0);
      shadows.push(
        `${type === "INNER_SHADOW" ? "inset " : ""}${x}px ${y}px ${blur}px ${spread}px ${color}`,
      );
    } else if (type === "LAYER_BLUR") {
      lines.push(`filter: blur(${round(asNumber(effect.radius) ?? 0)}px);`);
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
  if (type !== "TEXT") lines.push(...backgroundFrom(visiblePaints(node, "fills")));
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
