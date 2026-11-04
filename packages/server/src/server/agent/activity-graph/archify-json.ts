import type { ActivityGraphNodeStatus } from "@jagentdesk/protocol/agent-activity-graph";
import type { GraphModel, GraphNode } from "./model.js";

// GraphModel → archify 3.2.0 JSON: Flow as `lifecycle` schema 3 (automatic main-path layout),
// Plan as `tree` growing right (spec 31.1). Status colors are not archify's job: the app paints
// them with the overlay (spec 31.3), so the archify type only picks a neutral card and the
// default corner sigils are switched off where a status change would make them stale.

export const ARCHIFY_OUTPUT_NAME = "diagram.html";

type LifecycleType =
  | "start"
  | "active"
  | "waiting"
  | "decision"
  | "success"
  | "failure"
  | "neutral"
  | "external";

function lifecycleType(node: GraphNode): LifecycleType {
  switch (node.kind) {
    case "start":
      return "start";
    case "subagent":
      return "external";
    case "permission":
      return "waiting";
    case "error":
      return "failure";
    case "end":
      return node.status === "failed" ? "failure" : "success";
    case "todo":
    case "earlier":
    case "compaction":
      return "neutral";
    default:
      return "active";
  }
}

function statusIcon(status: ActivityGraphNodeStatus): string {
  // Matches the overlay (data-jad-status) at render time; the overlay restyles the card when the
  // status later changes without a re-render.
  switch (status) {
    case "failed":
      return "failure";
    case "waiting":
      return "waiting";
    default:
      return "none";
  }
}

export function toLifecycleJson(model: GraphModel): Record<string, unknown> {
  const main = model.nodes.filter((node) => node.placement === "main");
  const branches = model.nodes.filter((node) => node.placement === "branch");
  // Label (12 px) and sublabel (9 px) only: archify's 8 px tag and step rails are too small to read
  // in the panel and repeat what the card and the arrows already say.
  const states = model.nodes.map((node) => {
    const state: Record<string, unknown> = {
      id: node.id,
      type: lifecycleType(node),
      label: node.label,
    };
    if (node.sublabel) state.sublabel = node.sublabel;
    if (node.kind !== "start") state.icon = statusIcon(node.status);
    return state;
  });
  const transitions: Record<string, unknown>[] = [];
  for (let index = 1; index < main.length; index += 1) {
    const from = main[index - 1]!;
    const to = main[index]!;
    transitions.push({
      id: `t-${from.id}-${to.id}`.slice(0, 120),
      from: from.id,
      to: to.id,
      ...(to.plannedEdge ? { variant: "dashed" } : {}),
    });
  }
  for (const branch of branches) {
    if (!branch.parentId) continue;
    transitions.push({
      from: branch.parentId,
      to: branch.id,
      ...(branch.errorEdge ? { variant: "security" } : {}),
    });
    if (branch.returns)
      transitions.push({ from: branch.id, to: branch.parentId, variant: "dashed" });
  }
  return {
    schema_version: 3,
    diagram_type: "lifecycle",
    meta: {
      title: model.title,
      output: ARCHIFY_OUTPUT_NAME,
      animation: "none",
      legend: { mode: "hidden" },
    },
    mainPath: main.map((node) => node.id),
    states,
    transitions,
  };
}

export function toTreeJson(model: GraphModel): Record<string, unknown> {
  const hasChildren = new Set(model.nodes.map((node) => node.parentId).filter(Boolean));
  return {
    schema_version: 1,
    diagram_type: "tree",
    meta: {
      title: model.title,
      output: ARCHIFY_OUTPUT_NAME,
      animation: "none",
    },
    layout: { direction: "right" },
    nodes: model.nodes.map((node) => ({
      id: node.id,
      label: node.label,
      ...(node.sublabel ? { sublabel: node.sublabel } : {}),
      ...(node.parentId ? { parent: node.parentId } : {}),
      // A finished phase starts folded so the open work stays in view (spec 31.1).
      ...(node.kind === "phase" && node.status === "done" && hasChildren.has(node.id)
        ? { collapsed: true }
        : {}),
    })),
  };
}

export function toArchifyJson(model: GraphModel): {
  diagramType: "lifecycle" | "tree";
  document: Record<string, unknown>;
} {
  return model.view === "plan"
    ? { diagramType: "tree", document: toTreeJson(model) }
    : { diagramType: "lifecycle", document: toLifecycleJson(model) };
}
