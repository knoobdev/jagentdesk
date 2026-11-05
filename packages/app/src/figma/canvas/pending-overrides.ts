import type { FigmaNode, FigmaPendingOp } from "@jagentdesk/protocol/figma/rpc-schemas";

// Pending edits render as overrides on the canvas (spec 32.6.1): the renderer takes the op's new
// values through `options.overrides`, so an edit is visible before Figma Link exists. Ops that
// create nodes have no existing node to override and are skipped — PendingBar (W8) lists those.

// eslint-disable-next-line complexity
export function pendingToOverrides(
  ops: readonly FigmaPendingOp[],
): Record<string, Partial<FigmaNode>> {
  const overrides: Record<string, Partial<FigmaNode>> = {};
  for (const entry of ops) {
    if (entry.state !== "pending") continue;
    const op = entry.op;
    if (!("nodeId" in op)) continue; // create_node has no existing node to override
    const current = overrides[op.nodeId] ?? {};
    switch (op.op) {
      case "rename":
        overrides[op.nodeId] = { ...current, name: op.name };
        break;
      case "set_visible":
        overrides[op.nodeId] = { ...current, visible: op.visible };
        break;
      case "set_locked":
        overrides[op.nodeId] = { ...current, locked: op.locked };
        break;
      case "delete":
        overrides[op.nodeId] = { ...current, visible: false, deleted: true };
        break;
      case "set_text":
        overrides[op.nodeId] = { ...current, characters: op.characters };
        break;
      case "set_fill":
        overrides[op.nodeId] = {
          ...current,
          fills: [{ type: "SOLID", color: op.color, visible: true }],
        };
        break;
      case "set_corner_radius":
        overrides[op.nodeId] = { ...current, cornerRadius: op.radius };
        break;
      case "set_geometry": {
        const base = current.absoluteBoundingBox;
        const box = base && typeof base === "object" ? (base as Record<string, unknown>) : {};
        overrides[op.nodeId] = {
          ...current,
          absoluteBoundingBox: {
            x: op.x ?? (typeof box.x === "number" ? box.x : 0),
            y: op.y ?? (typeof box.y === "number" ? box.y : 0),
            width: op.width ?? (typeof box.width === "number" ? box.width : 0),
            height: op.height ?? (typeof box.height === "number" ? box.height : 0),
          },
        };
        break;
      }
      default:
        // duplicate, reorder, create_*, apply_style, bind_variable, set_reaction,
        // set_layout_child: nothing to draw as an override on an existing node.
        break;
    }
  }
  return overrides;
}
