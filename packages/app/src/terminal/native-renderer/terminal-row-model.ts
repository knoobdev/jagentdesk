import type { TextStyle } from "react-native";
import type { TerminalCell } from "@jagentdesk/protocol/messages";

import type { TerminalCellStyleResolver } from "./colors";
import { resolveTerminalCustomGlyph, type TerminalCustomGlyph } from "./terminal-custom-glyph";

const WIDE_CHAR_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2329, 0x232a],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
];

interface TerminalRunBase {
  key: string;
  text: string;
  cellCount: number;
  styleKey: string;
  style: TextStyle;
  foregroundColor: string;
}

export interface TerminalTextRun extends TerminalRunBase {
  renderKind: "text";
}

export interface TerminalCustomGlyphRun extends TerminalRunBase {
  renderKind: "custom-glyph";
  glyphs: TerminalCustomGlyphCell[];
}

export type TerminalRun = TerminalCustomGlyphRun | TerminalTextRun;

export interface TerminalCustomGlyphCell {
  key: string;
  offset: number;
  glyph: TerminalCustomGlyph;
}

export interface TerminalRowModel {
  index: number;
  hash: string;
  runs: TerminalRun[];
}

type TerminalRenderableCell = TerminalCell & { width?: number };

function hashStringPart(hash: number, value: string): number {
  let nextHash = hash;
  for (let index = 0; index < value.length; index += 1) {
    nextHash = Math.imul(nextHash ^ value.charCodeAt(index), 16777619);
  }
  return nextHash;
}

function finishHash(hash: number): string {
  return (hash >>> 0).toString(36);
}

function terminalCharWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 1;
  const isWide = WIDE_CHAR_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
  return isWide ? 2 : 1;
}

function shouldSkipSpacerCell(cells: TerminalRenderableCell[], col: number, char: string): boolean {
  if (terminalCharWidth(char) < 2) {
    return false;
  }
  return cells[col + 1]?.char === " ";
}

function terminalCellCount(cells: TerminalRenderableCell[], col: number, char: string): number {
  const authoritativeWidth = cells[col]?.width;
  if (authoritativeWidth !== undefined) {
    return Math.max(1, authoritativeWidth);
  }
  if (shouldSkipSpacerCell(cells, col, char)) {
    return 2;
  }
  return 1;
}

function appendRun(input: {
  runs: TerminalRun[];
  text: string;
  cellCount: number;
  styleKey: string;
  style: TextStyle;
  foregroundColor: string;
  customGlyph: TerminalCustomGlyph | null;
  col: number;
}): void {
  const renderKind = input.customGlyph ? "custom-glyph" : "text";
  const previousRun = input.runs[input.runs.length - 1];
  if (
    previousRun &&
    previousRun.styleKey === input.styleKey &&
    previousRun.renderKind === renderKind
  ) {
    const offset = previousRun.cellCount;
    previousRun.text += input.text;
    previousRun.cellCount += input.cellCount;
    if (previousRun.renderKind === "custom-glyph" && input.customGlyph) {
      previousRun.glyphs.push({
        key: `${input.col}:${input.text}`,
        offset,
        glyph: input.customGlyph,
      });
    }
    return;
  }

  const baseRun: TerminalRunBase = {
    key: `${input.col}:${input.styleKey}`,
    text: input.text,
    cellCount: input.cellCount,
    styleKey: input.styleKey,
    style: input.style,
    foregroundColor: input.foregroundColor,
  };
  if (input.customGlyph) {
    input.runs.push({
      ...baseRun,
      renderKind: "custom-glyph",
      glyphs: [{ key: `${input.col}:${input.text}`, offset: 0, glyph: input.customGlyph }],
    });
    return;
  }
  input.runs.push({ ...baseRun, renderKind: "text" });
}

function buildRowModel(input: {
  cells: TerminalRenderableCell[];
  index: number;
  resolver: TerminalCellStyleResolver;
}): TerminalRowModel {
  const runs: TerminalRun[] = [];
  let hash = 2166136261;

  for (let col = 0; col < input.cells.length; col += 1) {
    const cell = input.cells[col];
    const text = cell.char || " ";
    const resolvedStyle = input.resolver.resolve(cell);
    const cellCount = terminalCellCount(input.cells, col, text);
    const customGlyph = resolveTerminalCustomGlyph(text);
    appendRun({
      runs,
      text,
      cellCount,
      styleKey: resolvedStyle.key,
      style: resolvedStyle.style,
      foregroundColor: resolvedStyle.foregroundColor,
      customGlyph,
      col,
    });
    hash = hashStringPart(hash, text);
    hash = hashStringPart(hash, String(cellCount));
    hash = hashStringPart(hash, resolvedStyle.key);
    hash = hashStringPart(hash, customGlyph ? "custom-glyph" : "text");

    if (cellCount > 1) {
      col += 1;
    }
  }

  return {
    index: input.index,
    hash: finishHash(hash),
    runs,
  };
}

export function buildRows(input: {
  grid: TerminalRenderableCell[][];
  resolver: TerminalCellStyleResolver;
}): TerminalRowModel[] {
  return input.grid.map((cells, index) =>
    buildRowModel({ cells, index, resolver: input.resolver }),
  );
}
