import type { FigmaEditOp, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import type { FigmaColor, FigmaTransition } from "./protocol-types";

// Building the edit ops of spec 32.6. Everything the Inspect panel and the edit toolbar change
// goes through here, so the same FigmaEditOp[] reaches figma.link.op (linked) or figma.pending.add
// (queued), and the "op building" test is the behavior contract.

export interface InspectEditPatch {
  name?: string;
  visible?: boolean;
  locked?: boolean;
  /** geometry — merged into one set_geometry op when any is present */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** text content (32.6, text) */
  characters?: string;
  /** fill color — hex (#RRGGBB or #RRGGBBAA) or Figma's 0..1 rgba */
  fillColor?: string | FigmaColor;
  cornerRadius?: number;
  /** auto layout (32.6, layout fields) */
  layoutMode?: "NONE" | "HORIZONTAL" | "VERTICAL";
  itemSpacing?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  primaryAxisSizingMode?: "FIXED" | "AUTO";
  counterAxisSizingMode?: "FIXED" | "AUTO";
  /** child sizing inside an auto-layout parent */
  childHorizontal?: "FIXED" | "HUG" | "FILL";
  childVertical?: "FIXED" | "HUG" | "FILL";
}

function isFigmaColor(value: string | FigmaColor): value is FigmaColor {
  return typeof value !== "string";
}

function colorFromHex(hex: string): FigmaColor {
  const value = hex.trim().replace(/^#/, "");
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) throw new Error(`not a hex color: ${hex}`);
  const channel = (start: number, end: number) => parseInt(value.slice(start, end), 16) / 255;
  return {
    r: channel(0, 2),
    g: channel(2, 4),
    b: channel(4, 6),
    a: value.length === 8 ? channel(6, 8) : 1,
  };
}

/**
 * One deterministic FigmaEditOp[] for an inspect edit. Only the properties the patch actually
 * carries become ops; geometry and auto-layout fields collapse into single ops.
 */
// eslint-disable-next-line complexity
export function buildEditOps(nodeId: string, patch: InspectEditPatch): FigmaEditOp[] {
  const ops: FigmaEditOp[] = [];
  if (patch.name !== undefined && patch.name.trim() !== "") {
    ops.push({ op: "rename", nodeId, name: patch.name.trim() });
  }
  if (patch.visible !== undefined) ops.push({ op: "set_visible", nodeId, visible: patch.visible });
  if (patch.locked !== undefined) ops.push({ op: "set_locked", nodeId, locked: patch.locked });
  if (patch.characters !== undefined) {
    ops.push({ op: "set_text", nodeId, characters: patch.characters });
  }
  if (patch.fillColor !== undefined) {
    const color = isFigmaColor(patch.fillColor) ? patch.fillColor : colorFromHex(patch.fillColor);
    ops.push({ op: "set_fill", nodeId, color });
  }
  if (patch.cornerRadius !== undefined) {
    ops.push({ op: "set_corner_radius", nodeId, radius: patch.cornerRadius });
  }
  const geometry = {
    x: patch.x,
    y: patch.y,
    width: patch.width,
    height: patch.height,
  };
  if (
    geometry.x !== undefined ||
    geometry.y !== undefined ||
    geometry.width !== undefined ||
    geometry.height !== undefined
  ) {
    ops.push({ op: "set_geometry", nodeId, ...geometry });
  }
  if (
    patch.layoutMode !== undefined ||
    patch.itemSpacing !== undefined ||
    patch.padding !== undefined ||
    patch.primaryAxisSizingMode !== undefined ||
    patch.counterAxisSizingMode !== undefined
  ) {
    ops.push({
      op: "set_auto_layout",
      nodeId,
      ...(patch.layoutMode !== undefined ? { layoutMode: patch.layoutMode } : {}),
      ...(patch.itemSpacing !== undefined ? { itemSpacing: patch.itemSpacing } : {}),
      ...(patch.padding !== undefined ? { padding: patch.padding } : {}),
      ...(patch.primaryAxisSizingMode !== undefined
        ? { primaryAxisSizingMode: patch.primaryAxisSizingMode }
        : {}),
      ...(patch.counterAxisSizingMode !== undefined
        ? { counterAxisSizingMode: patch.counterAxisSizingMode }
        : {}),
    });
  }
  if (patch.childHorizontal !== undefined || patch.childVertical !== undefined) {
    ops.push({
      op: "set_layout_child",
      nodeId,
      ...(patch.childHorizontal !== undefined ? { horizontal: patch.childHorizontal } : {}),
      ...(patch.childVertical !== undefined ? { vertical: patch.childVertical } : {}),
    });
  }
  return ops;
}

// ── Toolbar one-offs (32.6) ────────────────────────────────────────────────────

export function toggleVisibleOp(node: FigmaNode): FigmaEditOp {
  return {
    op: "set_visible",
    nodeId: node.id,
    visible: node.visible === false,
  };
}

export function toggleLockOp(node: FigmaNode): FigmaEditOp {
  const locked = node.locked === true || node.constraints === "LOCKED";
  return { op: "set_locked", nodeId: node.id, locked: !locked };
}

export function deleteOp(nodeId: string): FigmaEditOp {
  return { op: "delete", nodeId };
}

export function duplicateOp(nodeId: string, tempId: string): FigmaEditOp {
  return { op: "duplicate", nodeId, tempId };
}

export function renameOp(nodeId: string, name: string): FigmaEditOp {
  return { op: "rename", nodeId, name };
}

export function createNodeOp(input: {
  parentId: string;
  kind: "FRAME" | "TEXT" | "RECTANGLE";
  tempId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  name?: string;
  characters?: string;
}): FigmaEditOp {
  return { op: "create_node", ...input };
}

export function createComponentOp(nodeId: string, tempId: string): FigmaEditOp {
  return { op: "create_component", nodeId, tempId };
}

export function createInstanceOp(input: {
  componentId: string;
  parentId: string;
  x: number;
  y: number;
  tempId: string;
}): FigmaEditOp {
  return { op: "create_instance", ...input };
}

export function setReactionOp(input: {
  nodeId: string;
  trigger: "ON_CLICK" | "ON_HOVER" | "ON_PRESS" | "AFTER_TIMEOUT";
  destinationId: string | null;
  transition?: FigmaTransition;
}): FigmaEditOp {
  return { op: "set_reaction", ...input };
}

/** Node placement for created shapes: centered in the visible Figma-space region. */
export function placementForCreate(
  visible: { x: number; y: number; width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  return {
    x: Math.round(visible.x + (visible.width - size.width) / 2),
    y: Math.round(visible.y + (visible.height - size.height) / 2),
  };
}
