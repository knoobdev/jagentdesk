import type { FigmaEditOp } from "@jagentdesk/protocol/figma/rpc-schemas";

type Reaction = Extract<FigmaEditOp, { op: "set_reaction" }>;
type ReactionTransition = NonNullable<Reaction["transition"]>;

// Maps the app's edit ops (32.6) onto Forge-compatible plugin tool calls. One planned step per op;
// the bridge executes the steps in order and maps tempIds onto the real node ids the plugin
// returns, so a batch can create a node and then reference it (spec 32.6.1 apply semantics).

export interface PlannedOp {
  tool: string;
  nodeIds?: string[];
  params?: Record<string, unknown>;
  /** The tempId this op's result registers when the plugin returns a node id. */
  tempId?: string;
  /** Id fields (already resolved against earlier creations) that must exist for the op to run. */
  dependsOnTempIds: string[];
}

function toHexColor(color: { r: number; g: number; b: number; a: number }): string {
  const channel = (value: number): string =>
    Math.min(255, Math.max(0, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function toPluginTransition(transition: ReactionTransition | undefined): Record<string, unknown> {
  if (!transition) return { transitionType: "INSTANT" };
  const out: Record<string, unknown> = { transitionType: transition.type };
  if (transition.direction !== undefined) out.direction = transition.direction;
  if (transition.durationMs !== undefined) out.duration = transition.durationMs;
  if (transition.easing !== undefined) out.easingType = transition.easing;
  return out;
}

/** Values inside node-reference fields that name a node an earlier op creates. */
function referenceFields(op: FigmaEditOp): string[] {
  switch (op.op) {
    case "set_reaction":
      return op.destinationId === null ? [op.nodeId] : [op.nodeId, op.destinationId];
    case "create_node":
      return [op.parentId];
    case "create_instance":
      return [op.componentId, op.parentId];
    default:
      return "nodeId" in op ? [op.nodeId] : [];
  }
}

type OpOf<K extends FigmaEditOp["op"]> = Extract<FigmaEditOp, { op: K }>;
interface Base {
  dependsOnTempIds: string[];
}

function fillParams(color: OpOf<"set_fill">["color"]): Record<string, unknown> {
  const params: Record<string, unknown> = { hex: toHexColor(color) };
  if (color.a < 1) params.opacity = color.a;
  return params;
}

function geometryParams(op: OpOf<"set_geometry">): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (op.x !== undefined) params.x = op.x;
  if (op.y !== undefined) params.y = op.y;
  if (op.width !== undefined) params.width = op.width;
  if (op.height !== undefined) params.height = op.height;
  return params;
}

function autoLayoutParams(op: OpOf<"set_auto_layout">): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (op.layoutMode !== undefined) params.layoutMode = op.layoutMode;
  if (op.itemSpacing !== undefined) params.itemSpacing = op.itemSpacing;
  if (op.padding !== undefined) {
    params.paddingTop = op.padding.top;
    params.paddingRight = op.padding.right;
    params.paddingBottom = op.padding.bottom;
    params.paddingLeft = op.padding.left;
  }
  if (op.primaryAxisSizingMode !== undefined)
    params.primaryAxisSizingMode = op.primaryAxisSizingMode;
  if (op.counterAxisSizingMode !== undefined)
    params.counterAxisSizingMode = op.counterAxisSizingMode;
  return params;
}

function layoutChildParams(op: OpOf<"set_layout_child">): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (op.horizontal !== undefined) params.layoutSizingHorizontal = op.horizontal;
  if (op.vertical !== undefined) params.layoutSizingVertical = op.vertical;
  return params;
}

function createNodePlan(base: Base, op: OpOf<"create_node">): PlannedOp {
  const params: Record<string, unknown> = { parentId: op.parentId, x: op.x, y: op.y };
  if (op.name !== undefined) params.name = op.name;
  if (op.kind === "FRAME") {
    params.width = op.width;
    params.height = op.height;
    return { ...base, tool: "create_frame", params, tempId: op.tempId };
  }
  if (op.kind === "RECTANGLE") {
    params.shapeType = "RECTANGLE";
    params.width = op.width;
    params.height = op.height;
    return { ...base, tool: "create_shape", params, tempId: op.tempId };
  }
  if (op.characters !== undefined) params.characters = op.characters;
  return { ...base, tool: "create_text", params, tempId: op.tempId };
}

function reactionPlan(base: Base, op: OpOf<"set_reaction">): PlannedOp {
  if (op.destinationId === null) {
    return { ...base, tool: "remove_reactions", nodeIds: [op.nodeId] };
  }
  return {
    ...base,
    tool: "set_reactions",
    nodeIds: [op.nodeId],
    params: {
      reactions: [
        {
          trigger: { type: op.trigger },
          action: {
            actionType: "NODE",
            navigation: "NAVIGATE",
            destinationId: op.destinationId,
            transition: toPluginTransition(op.transition),
          },
        },
      ],
    },
  };
}

function planModify(base: Base, op: FigmaEditOp): PlannedOp {
  switch (op.op) {
    case "rename":
      return {
        ...base,
        tool: "set_node_properties",
        nodeIds: [op.nodeId],
        params: { name: op.name },
      };
    case "set_visible":
      return {
        ...base,
        tool: "set_node_visibility",
        params: { items: [{ nodeId: op.nodeId, visible: op.visible }] },
      };
    case "set_locked":
      return {
        ...base,
        tool: op.locked ? "lock_nodes" : "unlock_nodes",
        nodeIds: [op.nodeId],
      };
    case "delete":
      return { ...base, tool: "delete_nodes", nodeIds: [op.nodeId], params: { confirm: true } };
    case "duplicate":
      return { ...base, tool: "duplicate_nodes", nodeIds: [op.nodeId], tempId: op.tempId };
    case "reorder":
      return {
        ...base,
        tool: "reorder_nodes",
        nodeIds: [op.nodeId],
        params: { order: "index", index: op.index },
      };
    case "set_text":
      return {
        ...base,
        tool: "set_text_content",
        nodeIds: [op.nodeId],
        params: { text: op.characters },
      };
    case "set_fill":
      return {
        ...base,
        tool: "set_solid_fill",
        nodeIds: [op.nodeId],
        params: fillParams(op.color),
      };
    case "set_corner_radius":
      return {
        ...base,
        tool: "set_node_properties",
        nodeIds: [op.nodeId],
        params: { cornerRadius: op.radius },
      };
    case "set_geometry":
      return {
        ...base,
        tool: "set_node_properties",
        nodeIds: [op.nodeId],
        params: geometryParams(op),
      };
    case "set_auto_layout":
      return {
        ...base,
        tool: "set_auto_layout",
        nodeIds: [op.nodeId],
        params: autoLayoutParams(op),
      };
    case "set_layout_child":
      return {
        ...base,
        tool: "set_layout_child",
        nodeIds: [op.nodeId],
        params: layoutChildParams(op),
      };
    case "apply_style":
      return {
        ...base,
        tool: "apply_style_to_node",
        nodeIds: [op.nodeId],
        params: { styleId: op.styleId },
      };
    case "bind_variable":
      return {
        ...base,
        tool: "bind_variable_to_node",
        nodeIds: [op.nodeId],
        params: { field: op.field, variableId: op.variableId },
      };
    case "create_component":
      return { ...base, tool: "create_component", nodeIds: [op.nodeId], tempId: op.tempId };
    case "swap_instance":
      return {
        ...base,
        tool: "swap_component",
        nodeIds: [op.nodeId],
        params: { componentId: op.componentId },
      };
    default:
      throw new Error(`Unsupported edit op: ${String((op as { op?: string }).op)}`);
  }
}

export function planOp(op: FigmaEditOp): PlannedOp {
  const base = { dependsOnTempIds: referenceFields(op) };
  switch (op.op) {
    case "create_node":
      return createNodePlan(base, op);
    case "create_instance":
      return {
        ...base,
        tool: "create_instance",
        params: { componentId: op.componentId, parentId: op.parentId, x: op.x, y: op.y },
        tempId: op.tempId,
      };
    case "set_reaction":
      return reactionPlan(base, op);
    default:
      return planModify(base, op);
  }
}

/**
 * Replace any id field whose value names a node an earlier op created with the real id the
 * plugin returned. Values that are declared tempIds of the batch but were never created stay
 * as-is so `unresolvedRefs` can report them instead of sending a fake id to the plugin.
 */
export function resolveTempIds(
  planned: PlannedOp,
  createdIds: Record<string, string>,
  declared: Set<string>,
): PlannedOp {
  const real = (value: string): string =>
    declared.has(value) ? (createdIds[value] ?? value) : value;
  const nodeIds = planned.nodeIds?.map(real);
  const params = planned.params ? { ...planned.params } : undefined;
  for (const key of ["parentId", "componentId", "styleId", "variableId"] as const) {
    const value = params?.[key];
    if (typeof value === "string") params![key] = real(value);
  }
  if (Array.isArray(params?.items)) {
    params!.items = (params!.items as { nodeId?: string; visible?: boolean }[]).map((item) =>
      typeof item.nodeId === "string"
        ? Object.assign({}, item, { nodeId: real(item.nodeId) })
        : item,
    );
  }
  if (Array.isArray(params?.reactions)) {
    params!.reactions = (params!.reactions as Record<string, unknown>[]).map((reaction) => {
      const action = reaction.action as Record<string, unknown> | undefined;
      if (!action || typeof action.destinationId !== "string") return reaction;
      return Object.assign({}, reaction, {
        action: Object.assign({}, action, { destinationId: real(action.destinationId) }),
      });
    });
  }
  return { ...planned, nodeIds, params };
}

/** A reference the batch never created (its create op failed) — reported per-op, not thrown. */
export function unresolvedTempIds(
  planned: PlannedOp,
  createdIds: Record<string, string>,
  declared: Set<string>,
): string[] {
  return planned.dependsOnTempIds.filter(
    (value) => declared.has(value) && createdIds[value] === undefined,
  );
}
