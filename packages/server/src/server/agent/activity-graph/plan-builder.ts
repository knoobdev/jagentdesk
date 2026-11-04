import type { ActivityGraphNodeStatus } from "@jagentdesk/protocol/agent-activity-graph";
import type { AgentTaskItem } from "../agent-sdk-types.js";
import {
  isTaskListTool,
  resolveTurn,
  splitTurns,
  summarizeTurns,
  todoItemsFromTaskTool,
  todoNodeId,
  todoStatus,
  type ActivityInput,
} from "./flow-builder.js";
import { firstLine, stableNodeId, truncateText, type GraphModel, type GraphNode } from "./model.js";
import type { SpecPlan } from "./spec-plan-source.js";
import type { FlowResult } from "./flow-builder.js";

// Plan view (spec 31.1): a tree. Root = the request; children = the agent's todos, or, with Spec
// mode on, its tasks.md phases with their tasks ([P] tasks marked parallel).

function todoNodeStatus(item: AgentTaskItem): ActivityGraphNodeStatus {
  const status = todoStatus(item);
  if (status === "completed") return "done";
  if (status === "in_progress") return "running";
  return "pending";
}

// The plan is agent-wide: the latest todo snapshot at or before the end of the chosen turn.
function latestTodos(input: ActivityInput, endSeq: number | null): AgentTaskItem[] | null {
  let todos: AgentTaskItem[] | null = null;
  for (const row of input.rows) {
    if (endSeq !== null && (row.seqStart ?? row.seq) >= endSeq) break;
    if (row.item.type === "todo") todos = row.item.items;
    else if (row.item.type === "tool_call" && isTaskListTool(row.item)) {
      todos = todoItemsFromTaskTool(row.item) ?? todos;
    }
  }
  return todos;
}

function specPlanNodes(specPlan: SpecPlan): GraphNode[] {
  const nodes: GraphNode[] = [];
  for (const phase of specPlan.phases) {
    const phaseId = stableNodeId("phase", phase.id.replace(/^phase-/, ""));
    const done = phase.tasks.filter((task) => task.done).length;
    nodes.push({
      id: phaseId,
      kind: "phase",
      label: truncateText(phase.title, 48),
      sublabel: `${done}/${phase.tasks.length} tasks`,
      status: phase.status,
      ref: { kind: "phase" },
      placement: "branch",
      parentId: "root",
    });
    for (const task of phase.tasks) {
      const marks = [task.parallel ? "[P] parallel" : null, task.story ?? null].filter(
        (mark): mark is string => mark !== null,
      );
      const prefix = task.id.startsWith("line-") ? "" : `${task.id} `;
      nodes.push({
        id: stableNodeId("task", `${phase.id}-${task.id}`),
        kind: "task",
        label: truncateText(`${prefix}${task.text}`, 56),
        ...(marks.length ? { sublabel: marks.join(" · ") } : {}),
        status: task.done ? "done" : "pending",
        ref: { kind: "task", todoId: task.id },
        placement: "branch",
        parentId: phaseId,
      });
    }
  }
  return nodes;
}

function todoPlanNodes(todos: readonly AgentTaskItem[]): GraphNode[] {
  return todos.map((todo) => ({
    id: todoNodeId(todo),
    kind: "todo",
    label: truncateText(todo.text, 56),
    status: todoNodeStatus(todo),
    ref: { kind: "todo", ...(todo.id ? { todoId: todo.id } : {}) },
    placement: "branch",
    parentId: "root",
  }));
}

export function buildPlanGraph(
  input: ActivityInput,
  specPlan: SpecPlan | null = null,
): FlowResult | null {
  const turns = splitTurns(input.rows);
  const turn = resolveTurn(turns, input.turnIndex);
  if (!turn) return null;
  const isLatest = turn.index === turns.length - 1;
  const live = isLatest && input.running;
  const prompt = turn.userRow.item.type === "user_message" ? turn.userRow.item.text : "";

  const root: GraphNode = {
    id: "root",
    kind: "root",
    label: firstLine(prompt) || "Request",
    status: live ? "running" : "done",
    ref: { kind: "root", seq: turn.userRow.seq },
    placement: "main",
  };
  const nodes: GraphNode[] = [root];

  if (specPlan && specPlan.phases.length > 0) nodes.push(...specPlanNodes(specPlan));
  else nodes.push(...todoPlanNodes(latestTodos(input, turn.endSeq) ?? []));

  const model: GraphModel = {
    view: "plan",
    title: input.title?.trim() || "Agent plan",
    nodes,
  };
  return { model, turns: { turns: summarizeTurns(turns), turnIndex: turn.index, live } };
}
