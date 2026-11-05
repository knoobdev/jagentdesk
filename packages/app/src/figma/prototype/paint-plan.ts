import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  cssColor,
  mergeNodeOverride,
  nodeBounds,
  nodeCornerRadius,
  nodeIsVisible,
  nodeOpacity,
  nodeSolidColor,
  type Rect,
  type RGBA,
} from "./node-geometry";

// Flat paint list for the native frame surface (before W9's Skia adapter lands, native has no
// 2D canvas): each solid-fill node becomes one absolutely-positioned box in frame-local,
// already-scaled coordinates. Document order — later boxes paint over earlier ones.

export interface PaintBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  opacity: number;
  cornerRadius: number;
}

export function buildPaintPlan(
  root: FigmaNode,
  options: { overrides?: Record<string, Partial<FigmaNode>>; scale: number },
): PaintBox[] {
  const origin = nodeBounds(root);
  if (!origin) return [];
  const boxes: PaintBox[] = [];
  const visit = (node: FigmaNode, inheritedOpacity: number): void => {
    const merged = mergeNodeOverride(node, options.overrides);
    const bounds = nodeBounds(merged);
    const color = nodeSolidColor(merged);
    const opacity = nodeOpacity(merged) * inheritedOpacity;
    if (bounds && color && opacity > 0 && bounds.width > 0 && bounds.height > 0) {
      boxes.push(toBox(bounds, origin, color, opacity, merged, options.scale));
    }
    if (!Array.isArray(merged.children)) return;
    for (const child of merged.children) {
      if (nodeIsVisible(child)) visit(child, opacity);
    }
  };
  visit(root, 1);
  return boxes;
}

function toBox(
  bounds: Rect,
  origin: Rect,
  color: RGBA,
  opacity: number,
  node: FigmaNode,
  scale: number,
): PaintBox {
  const width = bounds.width * scale;
  const height = bounds.height * scale;
  return {
    id: node.id,
    x: (bounds.x - origin.x) * scale,
    y: (bounds.y - origin.y) * scale,
    width,
    height,
    color: cssColor(color),
    opacity,
    cornerRadius: Math.min(nodeCornerRadius(node), Math.min(width, height) / 2),
  };
}
