import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  findNodeById,
  lerp,
  lerpColor,
  nodeBounds,
  nodeCornerRadius,
  nodeIsVisible,
  nodeOpacity,
  nodeSolidColor,
  type Rect,
  type RGBA,
} from "./node-geometry";

// Hand-written SMART_ANIMATE (spec 32.5.3): match layers between the two frames by name path —
// the chain of node names below the frame — then interpolate position, size, opacity, solid
// fill and corner radius per animation frame, delivered as renderer `overrides` keyed by node
// id. Matched layers morph on the incoming frame; unmatched layers crossfade.

export interface LayerPair {
  fromId: string;
  toId: string;
  path: string;
}

export interface InterpolatedLayer {
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  cornerRadius: number;
  color: RGBA | null;
}

export interface SmartAnimateFrame {
  /** Overrides for nodes of the incoming frame, keyed by destination node id. */
  to: Record<string, Partial<FigmaNode>>;
  /** Overrides for nodes of the outgoing frame, keyed by source node id. */
  from: Record<string, Partial<FigmaNode>>;
}

function indexByPath(root: FigmaNode): Map<string, FigmaNode[]> {
  const index = new Map<string, FigmaNode[]>();
  const visit = (node: FigmaNode, segments: string[]): void => {
    const key = segments.join("/");
    const bucket = index.get(key);
    if (bucket) bucket.push(node);
    else index.set(key, [node]);
    if (!Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (nodeIsVisible(child)) visit(child, [...segments, child.name]);
    }
  };
  if (!Array.isArray(root.children)) return index;
  for (const child of root.children) {
    if (nodeIsVisible(child)) visit(child, [child.name]);
  }
  return index;
}

/** Pairs layers whose name paths below the frame coincide, in document order. */
export function matchLayers(fromRoot: FigmaNode, toRoot: FigmaNode): LayerPair[] {
  const fromIndex = indexByPath(fromRoot);
  const toIndex = indexByPath(toRoot);
  const pairs: LayerPair[] = [];
  for (const [key, fromNodes] of fromIndex) {
    const toNodes = toIndex.get(key);
    if (!toNodes) continue;
    const count = Math.min(fromNodes.length, toNodes.length);
    for (let i = 0; i < count; i += 1) {
      pairs.push({ fromId: fromNodes[i].id, toId: toNodes[i].id, path: key });
    }
  }
  return pairs;
}

/** The two layers' values blended at `t` (0 → `from`, 1 → `to`) in the nodes' own coordinates. */
export function interpolateLayer(from: FigmaNode, to: FigmaNode, t: number): InterpolatedLayer {
  const fromBounds = nodeBounds(from) ?? { x: 0, y: 0, width: 0, height: 0 };
  const toBounds = nodeBounds(to) ?? { x: 0, y: 0, width: 0, height: 0 };
  const fromColor = nodeSolidColor(from);
  const toColor = nodeSolidColor(to);
  return {
    x: lerp(fromBounds.x, toBounds.x, t),
    y: lerp(fromBounds.y, toBounds.y, t),
    width: lerp(fromBounds.width, toBounds.width, t),
    height: lerp(fromBounds.height, toBounds.height, t),
    opacity: lerp(nodeOpacity(from), nodeOpacity(to), t),
    cornerRadius: lerp(nodeCornerRadius(from), nodeCornerRadius(to), t),
    color: fromColor && toColor ? lerpColor(fromColor, toColor, t) : null,
  };
}

function solidPaint(color: RGBA): Partial<FigmaNode> {
  return {
    fills: [{ type: "SOLID", color: { r: color.r, g: color.g, b: color.b, a: color.a } }],
  };
}

function localOf(bounds: Rect | null, frame: Rect | null): Rect | null {
  if (!bounds || !frame) return null;
  return {
    x: bounds.x - frame.x,
    y: bounds.y - frame.y,
    width: bounds.width,
    height: bounds.height,
  };
}

/**
 * Renderer override maps for both stages at eased progress `t` (0 → outgoing frame, 1 →
 * incoming). Matched layers morph on the incoming frame at their interpolated frame-local
 * values and hide on the outgoing one; unmatched layers crossfade by opacity.
 */
export function smartAnimateOverrides(
  fromRoot: FigmaNode,
  toRoot: FigmaNode,
  t: number,
): SmartAnimateFrame {
  const to: Record<string, Partial<FigmaNode>> = {};
  const from: Record<string, Partial<FigmaNode>> = {};
  const fromFrame = nodeBounds(fromRoot);
  const toFrame = nodeBounds(toRoot);
  if (!fromFrame || !toFrame) return { to, from };
  const matchedFrom = new Set<string>();
  const matchedTo = new Set<string>();
  for (const pair of matchLayers(fromRoot, toRoot)) {
    const fromNode = findNodeById(fromRoot, pair.fromId);
    const toNode = findNodeById(toRoot, pair.toId);
    if (!fromNode || !toNode) continue;
    const fromLocal = localOf(nodeBounds(fromNode), fromFrame);
    const toLocal = localOf(nodeBounds(toNode), toFrame);
    if (!fromLocal || !toLocal) continue;
    matchedFrom.add(pair.fromId);
    matchedTo.add(pair.toId);
    const color = lerpNullable(nodeSolidColor(fromNode), nodeSolidColor(toNode), t);
    to[pair.toId] = {
      absoluteBoundingBox: {
        x: toFrame.x + lerp(fromLocal.x, toLocal.x, t),
        y: toFrame.y + lerp(fromLocal.y, toLocal.y, t),
        width: lerp(fromLocal.width, toLocal.width, t),
        height: lerp(fromLocal.height, toLocal.height, t),
      },
      opacity: lerp(nodeOpacity(fromNode), nodeOpacity(toNode), t),
      cornerRadius: lerp(nodeCornerRadius(fromNode), nodeCornerRadius(toNode), t),
      ...(color ? solidPaint(color) : {}),
    };
    from[pair.fromId] = { opacity: 0 };
  }
  const fade = (node: FigmaNode, side: "in" | "out"): void => {
    if (Array.isArray(node.children)) {
      for (const child of node.children) fade(child, side);
    }
    if (node.id === fromRoot.id || node.id === toRoot.id) return;
    const matched = side === "out" ? matchedFrom : matchedTo;
    if (matched.has(node.id)) return;
    const base = nodeOpacity(node);
    const target = side === "out" ? 1 - t : t;
    (side === "out" ? from : to)[node.id] = { opacity: base * target };
  };
  fade(fromRoot, "out");
  fade(toRoot, "in");
  return { to, from };
}

function lerpNullable(a: RGBA | null, b: RGBA | null, t: number): RGBA | null {
  if (!a || !b) return null;
  return lerpColor(a, b, t);
}
