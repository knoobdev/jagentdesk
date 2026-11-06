import type {
  FigmaEditOp,
  FigmaNode,
  FigmaPendingOp,
} from "@jagentdesk/protocol/figma/rpc-schemas";

// The inspect-side edit state of one node (spec 32.6.1). Queued ops are layered over the raw
// REST node so a field previews its pending value, and the fields a queued op carries are
// flagged — the Inspect panel renders those as PENDING, never as saved to the original file
// in Figma. Renderer-side previews live in pending-overrides; this is the panel's own view.

export type PendingField =
  | "name"
  | "visible"
  | "locked"
  | "characters"
  | "fillColor"
  | "cornerRadius"
  | "width"
  | "height"
  | "x"
  | "y"
  | "layoutMode"
  | "itemSpacing"
  | "padding";

export interface NodeEditState {
  /** The node with queued values applied — what the editable fields display. */
  node: FigmaNode;
  /** Field keys a queued op carries; the UI marks these rows "Pending". */
  pendingFields: ReadonlySet<PendingField>;
  /** Queued ops touching this node (0 when clean), for the honest "not saved in Figma" caption. */
  pendingCount: number;
}

export function nodeEditState(node: FigmaNode, ops: readonly FigmaPendingOp[]): NodeEditState {
  const pendingFields = new Set<PendingField>();
  let merged = node;
  let pendingCount = 0;
  for (const entry of ops) {
    if (entry.state !== "pending") continue;
    const op = entry.op;
    if (!("nodeId" in op) || op.nodeId !== node.id) continue;
    pendingCount += 1;
    merged = queueOpOn(merged, op, pendingFields);
  }
  return { node: merged, pendingFields, pendingCount };
}

// eslint-disable-next-line complexity
function queueOpOn(node: FigmaNode, op: FigmaEditOp, fields: Set<PendingField>): FigmaNode {
  switch (op.op) {
    case "rename":
      fields.add("name");
      return { ...node, name: op.name };
    case "set_visible":
      fields.add("visible");
      return { ...node, visible: op.visible };
    case "set_locked":
      fields.add("locked");
      return { ...node, locked: op.locked };
    case "delete":
      fields.add("visible");
      return { ...node, visible: false, deleted: true };
    case "set_text":
      fields.add("characters");
      return { ...node, characters: op.characters };
    case "set_fill":
      fields.add("fillColor");
      return { ...node, fills: [{ type: "SOLID", color: op.color, visible: true }] };
    case "set_corner_radius":
      fields.add("cornerRadius");
      return { ...node, cornerRadius: op.radius };
    case "set_geometry":
      return queueGeometry(node, op, fields);
    case "set_auto_layout":
      return queueAutoLayout(node, op, fields);
    default:
      // duplicate, reorder, create_*, apply_style, bind_variable, set_reaction,
      // set_layout_child, swap_instance: no editable inspect field to preview.
      return node;
  }
}

function queueGeometry(
  node: FigmaNode,
  op: FigmaEditOp & { op: "set_geometry" },
  fields: Set<PendingField>,
): FigmaNode {
  const base = node.absoluteBoundingBox;
  const box = base && typeof base === "object" ? { ...(base as Record<string, unknown>) } : {};
  if (op.x !== undefined) {
    box.x = op.x;
    fields.add("x");
  }
  if (op.y !== undefined) {
    box.y = op.y;
    fields.add("y");
  }
  if (op.width !== undefined) {
    box.width = op.width;
    fields.add("width");
  }
  if (op.height !== undefined) {
    box.height = op.height;
    fields.add("height");
  }
  return { ...node, absoluteBoundingBox: box };
}

function queueAutoLayout(
  node: FigmaNode,
  op: FigmaEditOp & { op: "set_auto_layout" },
  fields: Set<PendingField>,
): FigmaNode {
  const merged: FigmaNode = { ...node };
  if (op.layoutMode !== undefined) {
    merged.layoutMode = op.layoutMode;
    fields.add("layoutMode");
  }
  if (op.itemSpacing !== undefined) {
    merged.itemSpacing = op.itemSpacing;
    fields.add("itemSpacing");
  }
  if (op.padding !== undefined) {
    merged.paddingTop = op.padding.top;
    merged.paddingRight = op.padding.right;
    merged.paddingBottom = op.padding.bottom;
    merged.paddingLeft = op.padding.left;
    fields.add("padding");
  }
  return merged;
}
