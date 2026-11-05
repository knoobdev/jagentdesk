// Geometric hit testing (spec 32.5.1): the topmost visible node under a Figma-space point,
// respecting visibility, opacity, parent clipping and masks. Paint order is `children` array
// order, so testing runs from the last child (topmost) backwards.
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  invert,
  pointInBounds,
  readNumber,
  type Bounds,
  type Point,
  type RenderMatrix,
} from "./matrix";
import { geometryOf, isMask, nodeOpacity, nodeSize, nodeTransform } from "./node-props";
import { pathContainsPoint } from "./svg-path";

interface Clip {
  transform: RenderMatrix;
  bounds: Bounds;
}

function toLocal(m: RenderMatrix, p: Point): Point | null {
  const inv = invert(m);
  if (!inv) return null;
  return { x: inv.a * p.x + inv.c * p.y + inv.e, y: inv.b * p.x + inv.d * p.y + inv.f };
}

function rectContains(local: Point, width: number, height: number): boolean {
  return local.x >= 0 && local.x <= width && local.y >= 0 && local.y <= height;
}

function ellipseContains(local: Point, width: number, height: number): boolean {
  if (width <= 0 || height <= 0) return false;
  const nx = (local.x - width / 2) / (width / 2);
  const ny = (local.y - height / 2) / (height / 2);
  return nx * nx + ny * ny <= 1;
}

function segmentDistance(p: Point, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - x1) * dx + (p.y - y1) * dy) / lenSq));
  return Math.hypot(p.x - (x1 + t * dx), p.y - (y1 + t * dy));
}

function geometryContains(node: FigmaNode, local: Point): boolean {
  const fields = ["fillGeometry", "strokeGeometry"] as const;
  for (const field of fields) {
    const entries = geometryOf(node, field);
    if (!entries) continue;
    for (const entry of entries) {
      if (pathContainsPoint(entry.path, entry.windingRule, local.x, local.y)) return true;
    }
  }
  return false;
}

/** Does the node's drawn area (in its own local space) contain the point? */
function nodeContains(node: FigmaNode, local: Point): boolean {
  const { width, height } = nodeSize(node);
  switch (node.type) {
    case "ELLIPSE":
      return ellipseContains(local, width, height);
    case "LINE": {
      const reach = Math.max((readNumber(node.strokeWeight) ?? 1) / 2, 1);
      return segmentDistance(local, 0, 0, width, 0) <= reach;
    }
    case "POLYGON":
    case "STAR":
    case "VECTOR":
    case "BOOLEAN_OPERATION": {
      const geometry = geometryOf(node, "fillGeometry");
      if (geometry && geometry.length > 0) return geometryContains(node, local);
      return rectContains(local, width, height);
    }
    default:
      return rectContains(local, width, height);
  }
}

function clipFor(node: FigmaNode, kind: "clip" | "mask"): Clip | null {
  if (kind === "clip" ? node.clipsContent !== true : !isMask(node) || node.visible === false)
    return null;
  const transform = nodeTransform(node);
  const { width, height } = nodeSize(node);
  if (!transform || width <= 0 || height <= 0) return null;
  return { transform, bounds: { x: 0, y: 0, width, height } };
}

function hitPoint(clips: Clip[], p: Point): boolean {
  for (const clip of clips) {
    const local = toLocal(clip.transform, p);
    if (!local || !pointInBounds(local, clip.bounds)) return false;
  }
  return true;
}

/** Masks constrain the hit region of their parent's other children (they clip siblings). */
function maskClipsOf(parent: FigmaNode): Clip[] {
  const out: Clip[] = [];
  for (const child of parent.children ?? []) {
    const clip = clipFor(child, "mask");
    if (clip) out.push(clip);
  }
  return out;
}

function hitFromTop(node: FigmaNode, point: Point, clips: Clip[]): FigmaNode | null {
  if (node.visible === false || nodeOpacity(node) === 0) return null;
  const transform = nodeTransform(node);
  if (!transform) return null;
  const local = toLocal(transform, point);
  if (!local) return null;
  const childClips = [...clips];
  const ownClip = clipFor(node, "clip");
  if (ownClip) childClips.push(ownClip);
  const masks = maskClipsOf(node);
  const children = node.children ?? [];
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!child || isMask(child) || child.visible === false) continue;
    if (!hitPoint(childClips, point) || !hitPoint(masks, point)) continue;
    const hit = hitFromTop(child, point, childClips);
    if (hit) return hit;
  }
  // Masks clip siblings and pages/documents are virtual containers: never returned themselves.
  if (node.isMask === true) return null;
  if (
    typeof node.type === "string" &&
    (node.type === "PAGE" || node.type === "DOCUMENT" || node.type === "CANVAS")
  ) {
    return null;
  }
  if (!nodeContains(node, local)) return null;
  return node;
}

/** Topmost visible node whose drawn area contains the Figma-space point, or null. */
export function hitTest(root: FigmaNode, point: Point): FigmaNode | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return hitFromTop(root, point, []);
}
