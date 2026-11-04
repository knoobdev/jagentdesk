import type { GraphModel, GraphNode } from "./model.js";

// GraphModel → archify 3.2.0 `tree` JSON (spec 31.1).
//   - Flow grows down: each main-path step is the child of the step before it, so a whole turn
//     reads top to bottom in a tall, narrow panel; subagents and approval waits are child
//     branches beside the step that spawned them; unfinished todos follow as planned nodes.
//   - Plan grows right: request → todos, or Spec mode phases → tasks.
// Status colors are not archify's job: the app paints them with the overlay (spec 31.3).

export const ARCHIFY_OUTPUT_NAME = "diagram.html";

interface TreeNode {
  id: string;
  label: string;
  sublabel?: string;
  parent?: string;
  collapsed?: boolean;
}

function treeNode(node: GraphNode, parent: string | undefined): TreeNode {
  return {
    id: node.id,
    label: node.label,
    ...(node.sublabel ? { sublabel: node.sublabel } : {}),
    ...(parent ? { parent } : {}),
  };
}

// Down-growing layout tuned for the ~560 px side panel at 1:1: cards 140–176 px (archify wraps
// longer text onto more lines) so a step with two branches still fits three across; the
// generation gap is tighter than archify's default because the Flow canvas hides the collapse
// toggles that gap makes room for.
export const FLOW_TREE_LAYOUT = {
  direction: "down",
  gapX: 20,
  gapY: 36,
  nodeW: 140,
  nodeMaxW: 176,
};

export function toFlowTreeJson(model: GraphModel): Record<string, unknown> {
  const main = model.nodes.filter((node) => node.placement === "main");
  const branchesOf = new Map<string, GraphNode[]>();
  for (const node of model.nodes) {
    if (node.placement !== "branch" || !node.parentId) continue;
    const list = branchesOf.get(node.parentId) ?? [];
    list.push(node);
    branchesOf.set(node.parentId, list);
  }
  // Children are read in declaration order and a parent is centred over its first and last child
  // (exactly over a middle one). Declaring the next step between the step's branches keeps the
  // chain a straight vertical line: half the branches to its left, the rest to its right.
  const ordered: TreeNode[] = [];
  main.forEach((step, index) => {
    if (index === 0) ordered.push(treeNode(step, undefined));
    const branches = branchesOf.get(step.id) ?? [];
    const left = branches.slice(0, Math.floor(branches.length / 2));
    const right = branches.slice(left.length);
    for (const branch of left) ordered.push(treeNode(branch, step.id));
    const next = main[index + 1];
    if (next) ordered.push(treeNode(next, step.id));
    for (const branch of right) ordered.push(treeNode(branch, step.id));
  });
  return {
    schema_version: 1,
    diagram_type: "tree",
    meta: { title: model.title, output: ARCHIFY_OUTPUT_NAME, animation: "none" },
    layout: FLOW_TREE_LAYOUT,
    nodes: ordered,
  };
}

export function toPlanTreeJson(model: GraphModel): Record<string, unknown> {
  const hasChildren = new Set(model.nodes.map((node) => node.parentId).filter(Boolean));
  return {
    schema_version: 1,
    diagram_type: "tree",
    meta: { title: model.title, output: ARCHIFY_OUTPUT_NAME, animation: "none" },
    layout: { direction: "right" },
    nodes: model.nodes.map((node) => ({
      ...treeNode(node, node.parentId),
      // A finished phase starts folded so the open work stays in view (spec 31.1).
      ...(node.kind === "phase" && node.status === "done" && hasChildren.has(node.id)
        ? { collapsed: true }
        : {}),
    })),
  };
}

export function toArchifyJson(model: GraphModel): {
  diagramType: "tree";
  document: Record<string, unknown>;
} {
  return {
    diagramType: "tree",
    document: model.view === "plan" ? toPlanTreeJson(model) : toFlowTreeJson(model),
  };
}
