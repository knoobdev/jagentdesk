// Builds the fill and stroke paths of a node: from `fillGeometry`/`strokeGeometry` when Figma sent
// them (vectors, boolean operations), otherwise reconstructed from the node's type and geometry
// properties (rectangles with corner radii, ellipses, polygons, stars, lines, frames).
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { cornerRadii, geometryOf, nodeSize, pointCountOf, starInnerRadius } from "./node-props";
import { newPath, type RenderPath } from "./render-path";

export interface Shape {
  path: RenderPath;
  /** Path2D fill rule derived from the geometry's windingRule. */
  rule: CanvasFillRule;
  /**
   * True when the path came from Figma's `fillGeometry`/`strokeGeometry`: the path already
   * encodes the final outline — stroke width, cap, join and dashes included — so a baked
   * stroke path is FILLED (with `rule`), never stroked.
   */
  baked?: boolean;
}

function roundedRectPath(
  width: number,
  height: number,
  radii: [number, number, number, number],
): RenderPath {
  const path = newPath();
  const clamp = (r: number): number => {
    const max = Math.min(width, height) / 2;
    return Math.max(0, Math.min(r, max));
  };
  const [tl, tr, br, bl] = radii.map(clamp) as [number, number, number, number];
  path.moveTo(tl, 0);
  path.lineTo(width - tr, 0);
  if (tr > 0) path.arcTo(width, 0, width, tr, tr);
  path.lineTo(width, height - br);
  if (br > 0) path.arcTo(width, height, width - br, height, br);
  path.lineTo(bl, height);
  if (bl > 0) path.arcTo(0, height, 0, height - bl, bl);
  path.lineTo(0, tl);
  if (tl > 0) path.arcTo(0, 0, tl, 0, tl);
  path.closePath();
  return path;
}

function ellipsePath(width: number, height: number): RenderPath {
  const path = newPath();
  path.ellipse(width / 2, height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  return path;
}

function polygonPath(
  width: number,
  height: number,
  points: number,
  inner: number | null,
): RenderPath {
  const path = newPath();
  const total = inner === null ? points : points * 2;
  for (let i = 0; i < total; i++) {
    let radiusX = width / 2;
    let radiusY = height / 2;
    if (inner !== null && i % 2 === 1) {
      radiusX *= inner;
      radiusY *= inner;
    }
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / total;
    const x = width / 2 + radiusX * Math.cos(angle);
    const y = height / 2 + radiusY * Math.sin(angle);
    if (i === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  }
  path.closePath();
  return path;
}

function linePath(width: number): RenderPath {
  const path = newPath();
  path.moveTo(0, 0);
  path.lineTo(width, 0);
  return path;
}

function fromGeometry(node: FigmaNode, field: "fillGeometry" | "strokeGeometry"): Shape[] | null {
  const geometry = geometryOf(node, field);
  if (!geometry || geometry.length === 0) return null;
  return geometry.map((entry) => ({
    path: newPath(entry.path),
    rule: entry.windingRule === "EVENODD" ? "evenodd" : "nonzero",
    baked: true,
  }));
}

/** Fill shapes of the node in local coordinates (origin at the node's own top-left). */
export function fillShapes(node: FigmaNode): Shape[] {
  const geometry = fromGeometry(node, "fillGeometry");
  if (geometry) return geometry;
  const { width, height } = nodeSize(node);
  if (width <= 0 || height <= 0) return [];
  const path = primitivePath(node, width, height);
  return path ? [{ path, rule: "nonzero" }] : [];
}

/** Stroke shapes of the node; vectors prefer `strokeGeometry`. */
export function strokeShapes(node: FigmaNode): Shape[] {
  const geometry = fromGeometry(node, "strokeGeometry");
  if (geometry) return geometry;
  const { width, height } = nodeSize(node);
  if (width <= 0 || height <= 0) return [];
  const path = primitivePath(node, width, height);
  return path ? [{ path, rule: "nonzero" }] : [];
}

function primitivePath(node: FigmaNode, width: number, height: number): RenderPath | null {
  switch (node.type) {
    case "RECTANGLE":
    case "ROUNDED_RECTANGLE":
    case "FRAME":
    case "COMPONENT":
    case "INSTANCE":
    case "BOOLEAN_OPERATION":
      return roundedRectPath(width, height, cornerRadii(node));
    case "ELLIPSE":
      return ellipsePath(width, height);
    case "LINE":
      return linePath(width);
    case "POLYGON":
      return polygonPath(width, height, pointCountOf(node), null);
    case "STAR":
      return polygonPath(width, height, pointCountOf(node), starInnerRadius(node));
    default:
      return null;
  }
}

/** The node's own clipping rectangle path (frames/groups with clipsContent), local coordinates. */
export function clipPathOf(node: FigmaNode): RenderPath | null {
  const { width, height } = nodeSize(node);
  if (width <= 0 || height <= 0) return null;
  const radii = cornerRadii(node);
  if (radii.some((r) => r > 0)) return roundedRectPath(width, height, radii);
  const path = newPath();
  path.rect(0, 0, width, height);
  return path;
}

/** Diamond polygon used to clip GRADIENT_DIAMOND fills, local coordinates. */
export function diamondPath(width: number, height: number): RenderPath {
  const path = newPath();
  path.moveTo(width / 2, 0);
  path.lineTo(width, height / 2);
  path.lineTo(width / 2, height);
  path.lineTo(0, height / 2);
  path.closePath();
  return path;
}
