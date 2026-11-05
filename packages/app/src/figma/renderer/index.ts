import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaCanvasContext, FigmaRenderer, FigmaRenderOptions } from "./types";

// Minimal stand-in renderer until W9 lands (spec 32.5.1): draw() fills the root frame's bounds
// with its background colour, hitTest() returns the deepest node under a point. The real
// renderer (vector paths, fills, text, effects) replaces this file wholesale; W1 imports only
// `createFigmaRenderer` from "@/figma/renderer".

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function boundsOf(node: FigmaNode): Rect | null {
  const box = readRecord(node.absoluteBoundingBox);
  if (!box) return null;
  const x = readNumber(box.x);
  const y = readNumber(box.y);
  const width = readNumber(box.width);
  const height = readNumber(box.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

function backgroundOf(node: FigmaNode): string {
  if (Array.isArray(node.fills)) {
    for (const entry of node.fills) {
      const paint = readRecord(entry);
      if (!paint || paint.type !== "SOLID" || paint.visible === false) continue;
      const color = readRecord(paint.color);
      if (!color) continue;
      const r = readNumber(color.r);
      const g = readNumber(color.g);
      const b = readNumber(color.b);
      const a = readNumber(color.a) ?? 1;
      if (r === null || g === null || b === null) continue;
      return `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
    }
  }
  return "#ffffff";
}

function hits(node: FigmaNode, point: { x: number; y: number }): boolean {
  if (node.visible === false) return false;
  const bounds = boundsOf(node);
  if (!bounds) return false;
  return (
    point.x >= bounds.x &&
    point.x <= bounds.x + bounds.width &&
    point.y >= bounds.y &&
    point.y <= bounds.y + bounds.height
  );
}

export function createFigmaRenderer(): FigmaRenderer {
  return {
    draw(ctx: FigmaCanvasContext, root: FigmaNode, options: FigmaRenderOptions): void {
      const override = options.overrides?.[root.id];
      const node = override ? { ...root, ...override } : root;
      const bounds = boundsOf(node);
      if (!bounds) return;
      ctx.fillStyle = backgroundOf(node);
      ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    },

    unsupportedFeatures(node: FigmaNode): string[] {
      if (node.type === "TEXT") return ["text"];
      if (node.fillGeometry || node.strokeGeometry) return ["vectorPaths"];
      return [];
    },

    hitTest(root: FigmaNode, point: { x: number; y: number }): FigmaNode | null {
      let found: FigmaNode | null = hits(root, point) ? root : null;
      if (Array.isArray(root.children)) {
        for (const child of root.children) {
          const hit = this.hitTest(child, point);
          if (hit) found = hit;
        }
      }
      return found;
    },
  };
}
