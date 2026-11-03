import { describe, expect, it } from "vitest";
import type { AgentTimelineItem, ToolCallDetail } from "../agent-sdk-types.js";
import { toLifecycleJson } from "./archify-json.js";
import { buildFlowGraph, type ActivityInput, type ActivityRow } from "./flow-builder.js";
import { MAX_FLOW_NODES } from "./model.js";

// Spec 31.2 mapping: stream rows → Flow graph → archify lifecycle JSON, with stable node ids.

function rowsBuilder() {
  let seq = 0;
  const rows: ActivityRow[] = [];
  const push = (item: AgentTimelineItem) => {
    seq += 1;
    rows.push({ seq, seqStart: seq, item });
    return seq;
  };
  const tool = (
    callId: string,
    name: string,
    detail: ToolCallDetail,
    status: "running" | "completed" | "failed" = "completed",
  ) =>
    push({
      type: "tool_call",
      callId,
      name,
      detail,
      status,
      error: status === "failed" ? "exit 1" : null,
    } as AgentTimelineItem);
  return { rows, push, tool };
}

const READ: ToolCallDetail = { type: "read", filePath: "src/auth/session.ts" };
const GREP: ToolCallDetail = { type: "search", query: "refreshToken", toolName: "grep" };
const EDIT: ToolCallDetail = { type: "edit", filePath: "src/auth/session.ts" };
const TASK: ToolCallDetail = {
  type: "sub_agent",
  subAgentType: "Explore",
  description: "Map session refresh callers",
  log: "",
};

// 31.7 #1: three tool calls, one subagent, a four-item todo list (one in progress).
function criterionOneTurn() {
  const b = rowsBuilder();
  b.push({ type: "user_message", text: "Fix the refresh race in the session module" });
  b.push({
    type: "todo",
    items: [
      { id: "1", text: "Inspect the session module", status: "in_progress", completed: false },
      { id: "2", text: "Find the refresh race", status: "pending", completed: false },
      { id: "3", text: "Patch expiry handling", status: "pending", completed: false },
      { id: "4", text: "Add a regression test", status: "pending", completed: false },
    ],
  });
  b.tool("call_read", "Read", READ);
  b.tool("call_grep", "Grep", GREP);
  b.push({ type: "reasoning", text: "Tracing the callers." });
  b.tool("call_task", "Task", TASK, "running");
  b.tool("call_edit", "Edit", EDIT, "running");
  return b;
}

function input(rows: ActivityRow[], extra: Partial<ActivityInput> = {}): ActivityInput {
  return {
    rows,
    running: true,
    subagents: [
      {
        id: "sub_explore",
        title: "Explore",
        description: "Map session refresh callers",
        status: "running",
        toolCallId: "call_task",
      },
    ],
    ...extra,
  };
}

describe("buildFlowGraph", () => {
  it("maps the 31.7 #1 turn to start, grouped tool nodes, a subagent branch and todo nodes", () => {
    const { rows } = criterionOneTurn();
    const result = buildFlowGraph(input(rows));
    expect(result).not.toBeNull();
    const json = toLifecycleJson(result!.model);

    expect(json.mainPath).toEqual([
      "start",
      "tools-call_read",
      "tools-call_task",
      "todo-1",
      "todo-2",
      "todo-3",
      "todo-4",
    ]);
    expect(json.states).toEqual([
      {
        id: "start",
        type: "start",
        label: "Fix the refresh race in the",
        sublabel: "session module",
      },
      {
        id: "tools-call_read",
        type: "active",
        label: "2 tool calls",
        sublabel: "Read · Search",
        tag: "tools",
        step: "01",
        icon: "none",
      },
      {
        id: "tools-call_task",
        type: "active",
        label: "2 tool calls",
        sublabel: "Explore · Edit",
        tag: "tools",
        step: "02",
        icon: "none",
      },
      {
        id: "todo-1",
        type: "neutral",
        label: "Inspect the session module",
        tag: "todo",
        step: "03",
        icon: "none",
      },
      {
        id: "todo-2",
        type: "neutral",
        label: "Find the refresh race",
        tag: "todo",
        step: "04",
        icon: "none",
      },
      {
        id: "todo-3",
        type: "neutral",
        label: "Patch expiry handling",
        tag: "todo",
        step: "05",
        icon: "none",
      },
      {
        id: "todo-4",
        type: "neutral",
        label: "Add a regression test",
        tag: "todo",
        step: "06",
        icon: "none",
      },
      {
        id: "sa-call_task",
        type: "external",
        label: "Explore",
        sublabel: "Map session refresh callers",
        tag: "subagent",
        icon: "none",
      },
    ]);
    expect(json.transitions).toEqual([
      { id: "t-start-tools-call_read", from: "start", to: "tools-call_read" },
      { id: "t-tools-call_read-tools-call_task", from: "tools-call_read", to: "tools-call_task" },
      { id: "t-tools-call_task-todo-1", from: "tools-call_task", to: "todo-1", variant: "dashed" },
      { id: "t-todo-1-todo-2", from: "todo-1", to: "todo-2", variant: "dashed" },
      { id: "t-todo-2-todo-3", from: "todo-2", to: "todo-3", variant: "dashed" },
      { id: "t-todo-3-todo-4", from: "todo-3", to: "todo-4", variant: "dashed" },
      { from: "tools-call_task", to: "sa-call_task" },
      { from: "sa-call_task", to: "tools-call_task", variant: "dashed" },
    ]);

    const statuses = Object.fromEntries(result!.model.nodes.map((node) => [node.id, node.status]));
    expect(statuses).toEqual({
      start: "done",
      "tools-call_read": "done",
      "tools-call_task": "running",
      "todo-1": "running",
      "todo-2": "pending",
      "todo-3": "pending",
      "todo-4": "pending",
      "sa-call_task": "running",
    });
    // The node index leads back to the timeline (31.4) and the subagent panel.
    const refs = Object.fromEntries(result!.model.nodes.map((node) => [node.id, node.ref]));
    expect(refs["tools-call_read"]).toEqual({
      kind: "tools",
      callId: "call_read",
      callIds: ["call_read", "call_grep"],
      seq: 3,
    });
    expect(refs["sa-call_task"]).toEqual({
      kind: "subagent",
      callId: "call_task",
      seq: 6,
      subagentId: "sub_explore",
    });
    expect(refs["todo-2"]).toEqual({ kind: "todo", todoId: "2" });
  });

  it("keeps node ids stable as the turn grows and finishes", () => {
    const b = criterionOneTurn();
    const before = buildFlowGraph(input(b.rows))!.model.nodes.map((node) => node.id);
    b.tool("call_edit", "Edit", EDIT, "completed");
    b.push({ type: "reasoning", text: "Now the test." });
    b.tool("call_test", "Bash", { type: "shell", command: "npm test" });
    b.push({
      type: "todo",
      items: [
        { id: "1", text: "Inspect the session module", status: "completed", completed: true },
        { id: "2", text: "Find the refresh race", status: "completed", completed: true },
        { id: "3", text: "Patch expiry handling", status: "in_progress", completed: false },
        { id: "4", text: "Add a regression test", status: "pending", completed: false },
      ],
    });
    b.push({ type: "assistant_message", text: "Fixed." });
    const after = buildFlowGraph(
      input(b.rows, { running: false, latestTurnOutcome: "completed" }),
    )!.model;
    const afterIds = after.nodes.map((node) => node.id);
    for (const id of [
      "start",
      "tools-call_read",
      "tools-call_task",
      "sa-call_task",
      "todo-3",
      "todo-4",
    ]) {
      expect(before).toContain(id);
      expect(afterIds).toContain(id);
    }
    expect(afterIds).toContain("tools-call_test");
    const mainIds = after.nodes.filter((node) => node.placement === "main").map((node) => node.id);
    expect(mainIds.at(-1)).toBe("end");
    expect(after.nodes.find((node) => node.id === "end")).toMatchObject({
      label: "Answer",
      sublabel: "Fixed.",
      status: "done",
    });
    // Completed todos leave the graph; the remaining ones follow the last step.
    expect(afterIds).not.toContain("todo-1");
    expect(after.nodes.find((node) => node.id === "todo-3")?.status).toBe("running");
  });

  it("draws a pending permission as a waiting branch and a denial as a failed one with an error edge", () => {
    const { rows } = criterionOneTurn();
    const pending = buildFlowGraph(
      input(rows, {
        permissions: [
          {
            request: { id: "perm_1", name: "Bash", title: "Run npm test", kind: "tool" },
            state: "pending",
            afterSeq: 7,
          },
        ],
      }),
    )!.model;
    expect(pending.nodes.find((node) => node.id === "perm-perm_1")).toMatchObject({
      label: "Waiting for approval",
      sublabel: "Run npm test",
      status: "waiting",
      placement: "branch",
      parentId: "tools-call_task",
    });
    const denied = buildFlowGraph(
      input(rows, {
        permissions: [
          {
            request: { id: "perm_1", name: "Bash", title: "Run npm test", kind: "tool" },
            state: "denied",
            afterSeq: 7,
          },
        ],
      }),
    )!.model;
    const transitions = toLifecycleJson(denied).transitions as Array<Record<string, unknown>>;
    expect(transitions).toContainEqual({
      from: "tools-call_task",
      to: "perm-perm_1",
      variant: "security",
    });
    expect(denied.nodes.find((node) => node.id === "perm-perm_1")?.status).toBe("failed");
  });

  it("caps a 60-step turn at 40 nodes with an 'N earlier steps' node", () => {
    const b = rowsBuilder();
    b.push({ type: "user_message", text: "Run sixty steps" });
    for (let index = 1; index <= 60; index += 1) {
      b.push({ type: "reasoning", text: `step ${index}` });
      b.tool(`step_${index}`, "Bash", { type: "shell", command: `echo ${index}` });
    }
    b.push({ type: "assistant_message", text: "Done." });
    const model = buildFlowGraph({ rows: b.rows, running: false })!.model;
    expect(model.nodes.length).toBeLessThanOrEqual(MAX_FLOW_NODES);
    const earlier = model.nodes.find((node) => node.id === "earlier");
    expect(earlier?.label).toMatch(/^\d+ earlier steps$/);
    expect(model.nodes[1]?.id).toBe("earlier");
    // The most recent steps stay visible.
    expect(model.nodes.map((node) => node.id)).toContain("tools-step_60");
  });

  it("splits turns at user messages and lists the 10 most recent", () => {
    const b = rowsBuilder();
    for (let turn = 1; turn <= 12; turn += 1) {
      b.push({ type: "user_message", text: `Prompt ${turn}` });
      b.push({ type: "assistant_message", text: `Answer ${turn}` });
    }
    const latest = buildFlowGraph({ rows: b.rows, running: false })!;
    expect(latest.turns.turnIndex).toBe(11);
    expect(latest.turns.turns.map((turn) => turn.turnIndex)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    const third = buildFlowGraph({ rows: b.rows, running: false, turnIndex: 2 })!;
    expect(third.model.nodes[0]).toMatchObject({ id: "start", label: "Prompt 3" });
    expect(third.turns.live).toBe(false);
  });

  it("returns null when the agent has no turn yet", () => {
    expect(buildFlowGraph({ rows: [], running: false })).toBeNull();
  });

  it("marks errors, compaction and a failed turn", () => {
    const b = rowsBuilder();
    b.push({ type: "user_message", text: "Try" });
    b.push({ type: "compaction", status: "completed", trigger: "auto" });
    b.tool("call_fail", "Bash", { type: "shell", command: "false" }, "failed");
    b.push({ type: "error", message: "Provider stream ended" });
    const model = buildFlowGraph({
      rows: b.rows,
      running: false,
      latestTurnOutcome: "failed",
    })!.model;
    expect(model.nodes.map((node) => [node.kind, node.status])).toEqual([
      ["start", "done"],
      ["compaction", "done"],
      ["tools", "failed"],
      ["error", "failed"],
      ["end", "failed"],
    ]);
  });

  it("never draws reasoning or free text as a step", () => {
    const b = rowsBuilder();
    b.push({ type: "user_message", text: "Explain" });
    b.push({ type: "reasoning", text: "I will first read the file, then edit it." });
    const live = buildFlowGraph({ rows: b.rows, running: true })!.model;
    expect(live.nodes.map((node) => node.id)).toEqual(["start", "working"]);
  });

  it("sanitises provider ids that archify would reject", () => {
    const b = rowsBuilder();
    b.push({ type: "user_message", text: "Go" });
    b.tool("item.42:call/7", "Read", READ);
    const ids = buildFlowGraph({ rows: b.rows, running: true })!.model.nodes.map((node) => node.id);
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });
});
