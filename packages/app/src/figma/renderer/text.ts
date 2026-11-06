// Text drawing for the renderer (spec 32.5.1): Figma TEXT nodes with per-segment style overrides,
// manual wrapping at the node width, alignment, line-height, letter-spacing, textCase and
// textDecoration. The renderer never loads fonts: `options.fontAvailable` decides whether the
// requested family is used or a generic fallback, and missing fonts are reported for `onMissing`.
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { Paint, TextStyle, TextRun } from "./node-props";
import { nodeOpacity, nodeSize, paintsOf, textAligns, textRuns } from "./node-props";
import { resolvePaintStyle } from "./paints";
import type { MissingSink } from "./missing";
import type { FigmaRenderOptions } from "./types";

const DEFAULT_FONT_SIZE = 16;
const GENERIC_FAMILY = "sans-serif";

const WEIGHT_TOKENS: [string, number][] = [
  ["thin", 100],
  ["extralight", 200],
  ["ultralight", 200],
  ["light", 300],
  ["regular", 400],
  ["normal", 400],
  ["medium", 500],
  ["semibold", 600],
  ["demibold", 600],
  ["bold", 700],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["black", 900],
  ["heavy", 900],
];

interface ResolvedRun {
  text: string;
  family: string;
  weight: number;
  italic: boolean;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number;
  decoration: string | null;
}

function weightAndItalic(styleName: string): { weight: number; italic: boolean } {
  const lower = styleName.toLowerCase();
  let weight = 400;
  for (const [token, value] of WEIGHT_TOKENS) {
    if (lower.includes(token)) weight = Math.max(weight, value);
  }
  return { weight, italic: /italic|oblique/.test(lower) };
}

function cssFont(run: ResolvedRun): string {
  const parts: string[] = [];
  if (run.italic) parts.push("italic");
  parts.push(String(run.weight));
  parts.push(`${run.fontSize}px`);
  parts.push(run.family === GENERIC_FAMILY ? GENERIC_FAMILY : `"${run.family}"`);
  return parts.join(" ");
}

function resolveFamily(
  style: TextStyle,
  options: FigmaRenderOptions,
  missing: MissingSink,
): string {
  const requested = style.fontFamily;
  const styleName = style.fontStyle ?? "Regular";
  if (!requested || requested === GENERIC_FAMILY) return GENERIC_FAMILY;
  if (options.fontAvailable(requested, styleName)) return requested;
  missing.addFont(requested, styleName);
  return GENERIC_FAMILY;
}

function applyTextCase(text: string, textCase: string | undefined): string {
  switch (textCase) {
    case "UPPER":
      return text.toUpperCase();
    case "LOWER":
      return text.toLowerCase();
    case "TITLE":
      return text.replace(
        /(^|\s|-)(\p{L})/gu,
        (_m, pre: string, ch: string) => pre + ch.toUpperCase(),
      );
    case "SMALL_CAPS":
    case "SMALL_CAPS_FORCED":
      // Figma's enum (REST TypeStyle.textCase): ORIGINAL | UPPER | LOWER | TITLE | SMALL_CAPS |
      // SMALL_CAPS_FORCED. Without font small-caps OpenType features on the canvas/Skia
      // contract we approximate both as full capitals.
      return text.toUpperCase();
    default:
      return text;
  }
}

function lineHeightFor(style: TextStyle, fontSize: number): number {
  if (style.lineHeightUnit === "PIXELS" && style.lineHeightPx !== undefined) {
    return style.lineHeightPx;
  }
  if (style.lineHeightUnit === "FONT_SIZE_%" && style.lineHeightPercent !== undefined) {
    return (fontSize * style.lineHeightPercent) / 100;
  }
  if (style.lineHeightUnit === undefined && style.lineHeightPx !== undefined) {
    return style.lineHeightPx;
  }
  return fontSize * 1.2;
}

function toResolvedRun(
  run: TextRun,
  options: FigmaRenderOptions,
  missing: MissingSink,
): ResolvedRun {
  const style = run.style;
  const fontSize = style.fontSize ?? DEFAULT_FONT_SIZE;
  const { weight, italic } = weightAndItalic(style.fontStyle ?? "Regular");
  return {
    text: applyTextCase(run.text, style.textCase),
    family: resolveFamily(style, options, missing),
    weight,
    italic,
    fontSize,
    letterSpacing: style.letterSpacing ?? 0,
    lineHeight: lineHeightFor(style, fontSize),
    decoration: style.textDecoration ?? null,
  };
}

interface Segment {
  run: ResolvedRun;
  text: string;
}

interface Line {
  segments: Segment[];
}

function tokenizeRuns(runs: ResolvedRun[]): { words: Segment[]; hardBreak: boolean }[] {
  const paragraphs: { words: Segment[]; hardBreak: boolean }[] = [];
  let current: Segment[] = [];
  const flush = (hardBreak: boolean): void => {
    paragraphs.push({ words: current, hardBreak });
    current = [];
  };
  for (const run of runs) {
    let buffer = "";
    for (const ch of run.text) {
      if (ch === "\n") {
        if (buffer) current.push({ run, text: buffer });
        buffer = "";
        flush(true);
        continue;
      }
      if (ch === " ") {
        if (buffer) current.push({ run, text: buffer });
        buffer = "";
        current.push({ run, text: " " });
        continue;
      }
      buffer += ch;
    }
    if (buffer) current.push({ run, text: buffer });
  }
  flush(false);
  return paragraphs;
}

function measureTextWidth(ctx: CanvasRenderingContext2D, run: ResolvedRun, text: string): number {
  if (text.length === 0) return 0;
  ctx.font = cssFont(run);
  const base = ctx.measureText(text).width;
  return base + run.letterSpacing * Math.max(0, text.length - 1);
}

function layoutLines(
  ctx: CanvasRenderingContext2D,
  runs: ResolvedRun[],
  wrapWidth: number | null,
): Line[] {
  const lines: Line[] = [];
  for (const paragraph of tokenizeRuns(runs)) {
    let line: Line = { segments: [] };
    let lineWidth = 0;
    const pushLine = (): void => {
      lines.push(line);
      line = { segments: [] };
      lineWidth = 0;
    };
    for (const word of paragraph.words) {
      const width = measureTextWidth(ctx, word.run, word.text);
      const fits =
        wrapWidth === null || lineWidth + width <= wrapWidth || line.segments.length === 0;
      if (fits) {
        line.segments.push(word);
        lineWidth += width;
      } else {
        pushLine();
        // Leading spaces on wrapped continuation lines collapse.
        if (word.text !== " ") {
          line.segments.push(word);
          lineWidth = width;
        }
      }
    }
    pushLine();
  }
  return lines;
}

function measureLine(
  ctx: CanvasRenderingContext2D,
  line: Line,
): { widths: number[]; total: number } {
  const widths = line.segments.map((segment) => measureTextWidth(ctx, segment.run, segment.text));
  return { widths, total: widths.reduce((sum, w) => sum + w, 0) };
}

function lineHeightOf(line: Line): number {
  if (line.segments.length === 0) return DEFAULT_FONT_SIZE * 1.2;
  let height = 0;
  for (const segment of line.segments)
    height = Math.max(height, segment.run.lineHeight, segment.run.fontSize * 1.2);
  return height;
}

function defaultFill(): Paint {
  return { type: "SOLID", color: { r: 0, g: 0, b: 0, a: 1 } };
}

function drawDecoration(
  ctx: CanvasRenderingContext2D,
  segment: Segment,
  x: number,
  baselineY: number,
): void {
  const width = segment.text === " " ? 0 : ctx.measureText(segment.text).width;
  if (width <= 0) return;
  const thickness = Math.max(1, segment.run.fontSize / 12);
  const y =
    segment.run.decoration === "UNDERLINE"
      ? baselineY + thickness * 0.5
      : baselineY - segment.run.fontSize * 0.25;
  ctx.fillRect(x, y, width, thickness);
}

/**
 * Draws a TEXT node in local coordinates (the caller has set the node transform). Returns false
 * when the node has no characters to draw.
 */
export function drawTextNode(
  ctx: CanvasRenderingContext2D,
  node: FigmaNode,
  options: FigmaRenderOptions,
  missing: MissingSink,
): boolean {
  const runs = textRuns(node).map((run) => toResolvedRun(run, options, missing));
  if (runs.every((run) => run.text.length === 0)) return false;
  const { width: nodeWidth, height: nodeHeight } = nodeSize(node);
  const aligns = textAligns(node);
  const wraps = aligns.autoResize !== "WIDTH_AND_HEIGHT" && nodeWidth > 0;
  const lines = layoutLines(ctx, runs, wraps ? nodeWidth : null);

  const totalHeight = lines.reduce((sum, line) => sum + lineHeightOf(line), 0);
  let yTop = 0;
  if (aligns.vertical === "CENTER") yTop = (nodeHeight - totalHeight) / 2;
  else if (aligns.vertical === "BOTTOM") yTop = nodeHeight - totalHeight;

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const nodeAlpha = nodeOpacity(node);
  const fills = paintsOf(node, "fills");
  let cursorY = yTop;
  for (const line of lines) {
    const lineHeight = lineHeightOf(line);
    const { widths, total } = measureLine(ctx, line);
    const gapCount = line.segments.filter((s) => s.text === " ").length;
    let extra = 0;
    let indent = 0;
    if (aligns.horizontal === "CENTER" && wraps) indent = (nodeWidth - total) / 2;
    else if (aligns.horizontal === "RIGHT" && wraps) indent = nodeWidth - total;
    else if (aligns.horizontal === "JUSTIFIED" && gapCount > 0 && total < nodeWidth) {
      extra = (nodeWidth - total) / gapCount;
    }
    let pen = indent;
    line.segments.forEach((segment, index) => {
      const baselineY = cursorY + segment.run.fontSize * 0.8;
      ctx.font = cssFont(segment.run);
      if (segment.run.letterSpacing !== 0) ctx.letterSpacing = `${segment.run.letterSpacing}px`;
      for (const paint of fills.length > 0 ? fills : [defaultFill()]) {
        const resolved = resolvePaintStyle(ctx, paint, nodeWidth, nodeHeight, options.imageForRef);
        if (!resolved || "missing" in resolved) continue;
        ctx.fillStyle = resolved.style;
        ctx.globalAlpha = (paint.opacity ?? 1) * nodeAlpha;
        ctx.fillText(segment.text, pen, baselineY);
      }
      if (segment.run.decoration === "UNDERLINE" || segment.run.decoration === "STRIKETHROUGH") {
        drawDecoration(ctx, segment, pen, baselineY);
      }
      pen += widths[index] + (segment.text === " " ? extra : 0);
    });
    cursorY += lineHeight;
  }
  return true;
}
