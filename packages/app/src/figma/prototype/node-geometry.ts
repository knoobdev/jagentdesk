import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";

// Read-only views over Figma REST node JSON (a passthrough schema: every property beyond
// id/name/type/children is `unknown` until validated). Used by the prototype player's hotspots,
// transitions and smart animate; nothing here mutates the tree.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function nodeBounds(node: FigmaNode): Rect | null {
  const box = readRecord(node.absoluteBoundingBox);
  if (!box) return null;
  const x = readNumber(box.x);
  const y = readNumber(box.y);
  const width = readNumber(box.width);
  const height = readNumber(box.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

/** The rendered-ink box (`absoluteRenderBounds`) when it is complete and finite. */
export function nodeRenderBounds(node: FigmaNode): Rect | null {
  const box = readRecord(node.absoluteRenderBounds);
  if (!box) return null;
  const x = readNumber(box.x);
  const y = readNumber(box.y);
  const width = readNumber(box.width);
  const height = readNumber(box.height);
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height };
}

export function nodeIsVisible(node: FigmaNode): boolean {
  return node.visible !== false;
}

/**
 * Rewrite a subtree in frame-local coordinates: subtract the frame's absoluteBoundingBox origin
 * from every node's box — and from its `absoluteRenderBounds` when that box is valid, since the
 * renderer places default-crop fallbacks on it — and pin each node's transform to that local
 * position. The web player's canvas spans one frame, and the renderer draws with the absolute
 * coordinates it is handed, so drawing a frame at x=1200 without localizing puts the whole
 * frame off-canvas. Real Figma REST nodes carry no `absoluteTransform` (that field is
 * plugin-only) — position comes from `absoluteBoundingBox`, and any transforms riding on the
 * payload are replaced outright.
 */
export function toFrameLocalNodes(root: FigmaNode, origin: Rect): FigmaNode {
  const localize = (node: FigmaNode): FigmaNode => {
    const copy: FigmaNode = { ...node };
    delete copy.absoluteTransform;
    delete copy.relativeTransform;
    const bounds = nodeBounds(node);
    if (bounds) {
      const x = bounds.x - origin.x;
      const y = bounds.y - origin.y;
      copy.absoluteBoundingBox = { x, y, width: bounds.width, height: bounds.height };
      const rotation = readNumber(node.rotation) ?? 0;
      if (rotation === 0)
        copy.absoluteTransform = [
          [1, 0, x],
          [0, 1, y],
        ];
    }
    // W8's renderer consults `absoluteRenderBounds` FIRST for default-crop fallbacks and
    // shadow outsets (renderer/nodes.ts fallbackPlacementBox), and on the wire that box is in
    // document coordinates exactly like the layout box — leaving it unshifted places a
    // shadowed fallback far off the one-frame canvas (or culls it). Width/height are the
    // export's ink extent, position-independent, so they survive verbatim. Missing, null or
    // non-finite bounds stay untouched: never fabricate a local box — the renderer's own
    // validated read falls back to the bounding box for those.
    const rendered = nodeRenderBounds(node);
    if (rendered)
      copy.absoluteRenderBounds = {
        x: rendered.x - origin.x,
        y: rendered.y - origin.y,
        width: rendered.width,
        height: rendered.height,
      };
    if (Array.isArray(node.children)) copy.children = node.children.map(localize);
    return copy;
  };
  return localize(root);
}

/** The first visible solid fill's colour, as Figma reports it (components 0–1). */
export function nodeSolidColor(node: FigmaNode): RGBA | null {
  if (!Array.isArray(node.fills)) return null;
  for (const entry of node.fills) {
    const paint = readRecord(entry);
    if (!paint || paint.type !== "SOLID" || paint.visible === false) continue;
    const color = readRecord(paint.color);
    if (!color) continue;
    const r = readNumber(color.r);
    const g = readNumber(color.g);
    const b = readNumber(color.b);
    if (r === null || g === null || b === null) continue;
    const paintOpacity = readNumber(paint.opacity);
    const a = (readNumber(color.a) ?? 1) * (paintOpacity ?? 1);
    return { r, g, b, a };
  }
  return null;
}

export function cssColor(color: RGBA): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  return `rgba(${r}, ${g}, ${b}, ${color.a})`;
}

export function nodeOpacity(node: FigmaNode): number {
  return readNumber(node.opacity) ?? 1;
}

export function nodeCornerRadius(node: FigmaNode): number {
  return readNumber(node.cornerRadius) ?? 0;
}

/** Figma's `overflowDirection` on a frame: which axes the frame scrolls internally. */
export function nodeOverflowAxes(node: FigmaNode): { horizontal: boolean; vertical: boolean } {
  const direction = typeof node.overflowDirection === "string" ? node.overflowDirection : "";
  return {
    horizontal: direction === "HORIZONTAL" || direction === "VERTICAL_AND_HORIZONTAL",
    vertical: direction !== "" && direction !== "HORIZONTAL",
  };
}

export function mergeNodeOverride(
  node: FigmaNode,
  overrides?: Record<string, Partial<FigmaNode>>,
): FigmaNode {
  const override = overrides?.[node.id];
  return override ? { ...node, ...override } : node;
}

export function walkNodes(root: FigmaNode, visit: (node: FigmaNode) => void): void {
  visit(root);
  if (!Array.isArray(root.children)) return;
  for (const child of root.children) {
    if (nodeIsVisible(child)) walkNodes(child, visit);
  }
}

export function findNodeById(root: FigmaNode, nodeId: string): FigmaNode | null {
  if (root.id === nodeId) return root;
  if (!Array.isArray(root.children)) return null;
  for (const child of root.children) {
    const found = findNodeById(child, nodeId);
    if (found) return found;
  }
  return null;
}

/** The node names from `root` (inclusive) down to `node`, for smart-animate layer matching. */
export function namePath(root: FigmaNode, node: FigmaNode): string[] | null {
  if (root.id === node.id) return [root.name];
  if (!Array.isArray(root.children)) return null;
  for (const child of root.children) {
    const path = namePath(child, node);
    if (path) return [root.name, ...path];
  }
  return null;
}

/** Scale that fits `bounds` into `container`, capped at `maxScale` (never upscales past it). */
export function computeFitScale(
  bounds: Rect,
  container: { width: number; height: number },
  maxScale = 1,
): number {
  if (bounds.width <= 0 || bounds.height <= 0) return 0;
  const fit = Math.min(container.width / bounds.width, container.height / bounds.height);
  return Math.max(0, Math.min(fit, maxScale));
}

/** Union of visible descendants' bounds, clipped to the frame's own viewport. */
export function contentBounds(root: FigmaNode): Rect | null {
  let union: Rect | null = null;
  walkNodes(root, (node) => {
    const bounds = nodeBounds(node);
    if (!bounds) return;
    union = unionRect(union, bounds);
  });
  return union;
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpColor(a: RGBA, b: RGBA, t: number): RGBA {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
    a: lerp(a.a, b.a, t),
  };
}
