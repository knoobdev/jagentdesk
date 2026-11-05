import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaRenderer } from "./types";

// Development stand-in for the JAgentDesk renderer. W9 builds the real one (spec 32.5.1) at this
// path and replaces this file; the canvas viewer only depends on the `FigmaRenderer` contract.

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function boundsOf(node: FigmaNode): Box | null {
  const raw = node.absoluteBoundingBox;
  if (typeof raw !== "object" || raw === null) return null;
  const box = raw as Record<string, unknown>;
  const { x, y, width, height } = box;
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

function backgroundColorOf(node: FigmaNode): string | null {
  const raw = node.backgroundColor;
  if (typeof raw === "string") return raw;
  const fills = node.fills;
  if (Array.isArray(fills)) {
    for (const entry of fills) {
      if (typeof entry !== "object" || entry === null) continue;
      const paint = entry as Record<string, unknown>;
      if (paint.visible === false) continue;
      if (paint.type === "SOLID" && typeof paint.color === "object" && paint.color !== null) {
        const c = paint.color as Record<string, unknown>;
        const chan = (key: string) =>
          Math.round((typeof c[key] === "number" ? (c[key] as number) : 0) * 255);
        const alpha = typeof c.a === "number" ? c.a : 1;
        return `rgba(${chan("r")}, ${chan("g")}, ${chan("b")}, ${alpha})`;
      }
    }
  }
  return null;
}

function collectFrames(node: FigmaNode, out: FigmaNode[]): void {
  if (node.visible === false) return;
  if (node.type === "FRAME" || node.type === "RECTANGLE" || node.type === "INSTANCE") {
    out.push(node);
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectFrames(child, out);
  }
}

function applyOverride(node: FigmaNode, overrides: Record<string, Partial<FigmaNode>>): FigmaNode {
  return { ...node, ...overrides[node.id] };
}

export function createFigmaRenderer(): FigmaRenderer {
  return {
    draw(ctx, root, options) {
      const nodes: FigmaNode[] = [];
      collectFrames(applyOverride(root, options.overrides ?? {}), nodes);
      for (const node of nodes) {
        const withOverride = applyOverride(node, options.overrides ?? {});
        const bounds = boundsOf(withOverride);
        if (!bounds) continue;
        const color = backgroundColorOf(withOverride);
        if (!color) continue;
        ctx.fillStyle = color;
        ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      }
    },
    unsupportedFeatures: () => [],
    hitTest(root, point) {
      const nodes: FigmaNode[] = [];
      collectFrames(root, nodes);
      for (let i = nodes.length - 1; i >= 0; i -= 1) {
        const node = nodes[i];
        if (!node) continue;
        const bounds = boundsOf(node);
        if (!bounds) continue;
        if (
          point.x >= bounds.x &&
          point.x <= bounds.x + bounds.width &&
          point.y >= bounds.y &&
          point.y <= bounds.y + bounds.height
        ) {
          return node;
        }
      }
      return null;
    },
  };
}

export type { FigmaRenderer, FigmaRenderOptions, FigmaCanvasContext } from "./types";
