import { buildToolCallDisplayModel } from "@jagentdesk/protocol/tool-call-display";
import type { ActivityGraphNodeStatus } from "@jagentdesk/protocol/agent-activity-graph";
import type {
  AgentPermissionRequest,
  AgentTaskItem,
  AgentTimelineItem,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import {
  LABEL_UNITS,
  MAX_FLOW_NODES,
  SUBLABEL_UNITS,
  TURN_PICKER_LIMIT,
  firstLine,
  splitPromptLabel,
  hashNodeId,
  stableNodeId,
  truncateText,
  type ActivityGraphTurns,
  type GraphModel,
  type GraphNode,
} from "./model.js";

// Flow view (spec 31.1/31.2): one turn as a left-to-right path built algorithmically from the
// projected timeline. No model calls, no free-text inference: "will do" comes only from todos.

export interface ActivityRow {
  // Projected row identity: seq is the last source seq of the row (what the app's timeline cursor
  // carries), seqStart the first.
  seq: number;
  seqStart?: number;
  item: AgentTimelineItem;
  turnId?: string;
}

export interface ActivitySubagent {
  id: string;
  title: string | null;
  description: string | null;
  status: "running" | "completed" | "failed" | "canceled";
  toolCallId: string | null;
}

export interface ActivityPermission {
  request: Pick<AgentPermissionRequest, "id" | "name" | "title" | "kind">;
  state: "pending" | "allowed" | "denied";
  // Latest committed timeline seq when the request arrived; places the branch in its turn.
  afterSeq: number;
}

export type ActivityTurnOutcome = "completed" | "failed" | "canceled";

export interface ActivityInput {
  rows: readonly ActivityRow[];
  subagents?: readonly ActivitySubagent[];
  permissions?: readonly ActivityPermission[];
  // A turn is in progress (applies to the latest turn only).
  running: boolean;
  // How the latest turn ended, when the daemon saw it end.
  latestTurnOutcome?: ActivityTurnOutcome | null;
  // 0-based turn index; omitted = latest.
  turnIndex?: number;
  title?: string;
  cwd?: string;
}

export interface TurnSlice {
  index: number;
  userRow: ActivityRow;
  rows: ActivityRow[];
  // First seq of the next turn (exclusive upper bound), or null for the latest turn.
  endSeq: number | null;
}

export function splitTurns(rows: readonly ActivityRow[]): TurnSlice[] {
  const turns: TurnSlice[] = [];
  for (const row of rows) {
    if (row.item.type === "user_message") {
      const previous = turns.at(-1);
      if (previous) previous.endSeq = row.seqStart ?? row.seq;
      turns.push({ index: turns.length, userRow: row, rows: [], endSeq: null });
      continue;
    }
    // Rows before the first prompt (imported history, system notices) belong to no turn.
    turns.at(-1)?.rows.push(row);
  }
  return turns;
}

export function summarizeTurns(turns: readonly TurnSlice[]): ActivityGraphTurns["turns"] {
  return turns.slice(-TURN_PICKER_LIMIT).map((turn) => ({
    turnIndex: turn.index,
    label: firstLine(userText(turn.userRow), 48) || `Turn ${turn.index + 1}`,
    seq: turn.userRow.seq,
  }));
}

function userText(row: ActivityRow): string {
  return row.item.type === "user_message" ? row.item.text : "";
}

export function resolveTurn(
  turns: readonly TurnSlice[],
  requested: number | undefined,
): TurnSlice | null {
  if (turns.length === 0) return null;
  if (requested === undefined) return turns.at(-1) ?? null;
  return turns[requested] ?? null;
}

function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/[.\s-]+/g, "_")
    .toLowerCase();
}

// Tool calls the app turns into its todo list instead of a tool row (types/stream.ts
// reduceTimelineToolCall, utils/tool-call-parsers.ts extractTaskEntriesFromToolCall).
const TASK_LIST_TOOLS = new Set(["todowrite", "todo_write", "update_plan"]);

export function isTaskListTool(call: ToolCallTimelineItem): boolean {
  return TASK_LIST_TOOLS.has(normalizeToolName(call.name));
}

// Not groupable in the app either (tool-calls/detail-level/grouping.ts isGroupableToolCall).
function isGroupable(call: ToolCallTimelineItem): boolean {
  return call.detail.type !== "plan" && normalizeToolName(call.name) !== "speak";
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Todo snapshot carried by a TodoWrite / update_plan input, for providers whose daemon timeline
// has the tool call but no `todo` item.
export function todoItemsFromTaskTool(call: ToolCallTimelineItem): AgentTaskItem[] | null {
  const detail = call.detail as { type: string; input?: unknown };
  const input = readRecord(detail.type === "unknown" ? detail.input : null);
  if (!input) return null;
  const parseStatus = (value: unknown): AgentTaskItem["status"] =>
    value === "completed" || value === "in_progress" ? value : "pending";
  if (Array.isArray(input.todos)) {
    const items: AgentTaskItem[] = [];
    for (const raw of input.todos) {
      const todo = readRecord(raw);
      const text = typeof todo?.content === "string" ? todo.content.trim() : "";
      if (!todo || !text) continue;
      const status = parseStatus(todo.status);
      items.push({
        text,
        status,
        completed: status === "completed",
        ...(typeof todo.id === "string" ? { id: todo.id } : {}),
        ...(typeof todo.activeForm === "string" ? { activeForm: todo.activeForm } : {}),
      });
    }
    return items;
  }
  if (Array.isArray(input.plan)) {
    const items: AgentTaskItem[] = [];
    for (const raw of input.plan) {
      const entry = readRecord(raw);
      const text = typeof entry?.step === "string" ? entry.step.trim() : "";
      if (!entry || !text) continue;
      const status = parseStatus(entry.status);
      items.push({ text, status, completed: status === "completed" });
    }
    return items;
  }
  return null;
}

export function todoStatus(item: AgentTaskItem): "pending" | "in_progress" | "completed" {
  if (item.status) return item.status;
  return item.completed ? "completed" : "pending";
}

export function todoNodeId(item: AgentTaskItem): string {
  return item.id ? stableNodeId("todo", item.id) : hashNodeId("todo", item.text.trim());
}

interface ToolRun {
  node: GraphNode;
  calls: ToolCallTimelineItem[];
}

function toolStatus(calls: readonly ToolCallTimelineItem[]): ActivityGraphNodeStatus {
  if (calls.some((call) => call.status === "running")) return "running";
  if (calls.some((call) => call.status === "failed")) return "failed";
  return "done";
}

function describeRun(run: ToolRun, cwd: string | undefined): void {
  const displays = run.calls.map((call) =>
    buildToolCallDisplayModel({
      name: call.name,
      status: call.status,
      error: call.error,
      metadata: call.metadata,
      detail: call.detail,
      ...(cwd ? { cwd } : {}),
    }),
  );
  const node = run.node;
  if (run.calls.length === 1) {
    const display = displays[0]!;
    node.label = truncateText(display.displayName, LABEL_UNITS);
    if (display.summary) node.sublabel = truncateText(display.summary, SUBLABEL_UNITS);
    else delete node.sublabel;
    node.tag = "tool";
  } else {
    node.label = `${run.calls.length} tool calls`;
    const names: string[] = [];
    for (const display of displays) {
      if (!names.includes(display.displayName)) names.push(display.displayName);
    }
    node.sublabel = truncateText(names.join(" · "), SUBLABEL_UNITS);
    node.tag = "tools";
  }
  node.status = toolStatus(run.calls);
  node.ref = {
    kind: "tools",
    callId: run.calls[0]!.callId,
    callIds: run.calls.map((call) => call.callId),
    seq: node.ref.seq,
  };
}

function subagentStatus(status: ActivitySubagent["status"]): ActivityGraphNodeStatus {
  if (status === "running") return "running";
  if (status === "failed") return "failed";
  return "done";
}

const PERMISSION_PRESENTATION: Record<
  ActivityPermission["state"],
  { label: string; status: ActivityGraphNodeStatus }
> = {
  pending: { label: "Waiting for approval", status: "waiting" },
  allowed: { label: "Approved", status: "done" },
  denied: { label: "Denied", status: "failed" },
};

function permissionNode(permission: ActivityPermission, parentId: string): GraphNode {
  const { request, state } = permission;
  const presentation = PERMISSION_PRESENTATION[state];
  return {
    id: stableNodeId("perm", request.id),
    kind: "permission",
    label: presentation.label,
    sublabel: truncateText(request.title || request.name, SUBLABEL_UNITS),
    tag: "approval",
    status: presentation.status,
    ref: { kind: "permission", requestId: request.id },
    placement: "branch",
    parentId,
    returns: state === "allowed",
    errorEdge: state === "denied",
  };
}

function callStatus(call: ToolCallTimelineItem): ActivityGraphNodeStatus {
  if (call.status === "running") return "running";
  if (call.status === "failed") return "failed";
  return "done";
}

function toolRunNode(callId: string, seq: number): GraphNode {
  return {
    id: stableNodeId("tools", callId),
    kind: "tools",
    label: "",
    status: "running",
    ref: { kind: "tools", seq },
    placement: "main",
  };
}

interface FlowBuild {
  main: GraphNode[];
  branches: GraphNode[];
}

// Collapse the oldest finished main-path steps (with their branches) into one "N earlier steps"
// node until the turn fits in MAX_FLOW_NODES (spec 31.2).
function capNodes(build: FlowBuild): void {
  const total = () => build.main.length + build.branches.length;
  if (total() <= MAX_FLOW_NODES) return;
  const settled = (status: ActivityGraphNodeStatus) => status === "done" || status === "failed";
  let collapsed = 0;
  let firstSeq: number | undefined;
  // main[0] is the start node; the earlier node will take one slot.
  while (total() + 1 > MAX_FLOW_NODES) {
    const candidate = build.main[1];
    if (!candidate || candidate.kind === "todo" || candidate.kind === "end") break;
    const branches = build.branches.filter((branch) => branch.parentId === candidate.id);
    if (!settled(candidate.status) || branches.some((branch) => !settled(branch.status))) break;
    build.main.splice(1, 1);
    build.branches = build.branches.filter((branch) => branch.parentId !== candidate.id);
    collapsed += 1 + branches.length;
    firstSeq ??= candidate.ref.seq;
  }
  if (collapsed === 0) return;
  build.main.splice(1, 0, {
    id: "earlier",
    kind: "earlier",
    label: `${collapsed} earlier steps`,
    sublabel: "collapsed",
    tag: "history",
    status: "done",
    ref: { kind: "earlier", ...(firstSeq !== undefined ? { seq: firstSeq } : {}) },
    placement: "main",
  });
}

export interface FlowResult {
  model: GraphModel;
  turns: ActivityGraphTurns;
}

// Walks one turn's rows in order and assembles its Flow graph.
class FlowAssembler {
  readonly build: FlowBuild;
  todos: AgentTaskItem[] | null = null;
  lastAssistant: ActivityRow | null = null;
  private run: ToolRun | null = null;
  private readonly permissions: ActivityPermission[];
  private permissionCursor = 0;
  private readonly subagentsByCall = new Map<string, ActivitySubagent>();

  constructor(
    private readonly input: ActivityInput,
    private readonly turn: TurnSlice,
  ) {
    this.build = {
      main: [
        {
          id: "start",
          kind: "start",
          ...splitPromptLabel(firstLine(userText(turn.userRow)) || "Prompt"),
          status: "done",
          ref: { kind: "start", seq: turn.userRow.seq },
          placement: "main",
        },
      ],
      branches: [],
    };
    const turnStartSeq = turn.userRow.seqStart ?? turn.userRow.seq;
    this.permissions = (input.permissions ?? [])
      .filter(
        (permission) =>
          permission.afterSeq >= turnStartSeq &&
          (turn.endSeq === null || permission.afterSeq < turn.endSeq),
      )
      .sort((a, b) => a.afterSeq - b.afterSeq);
    for (const subagent of input.subagents ?? []) {
      if (subagent.toolCallId) this.subagentsByCall.set(subagent.toolCallId, subagent);
    }
  }

  private lastMain(): GraphNode {
    return this.build.main.at(-1)!;
  }

  private placePermissionsUpTo(seq: number): void {
    while (
      this.permissionCursor < this.permissions.length &&
      this.permissions[this.permissionCursor]!.afterSeq < seq
    ) {
      const permission = this.permissions[this.permissionCursor]!;
      this.build.branches.push(permissionNode(permission, this.run?.node.id ?? this.lastMain().id));
      this.permissionCursor += 1;
    }
  }

  private closeRun(): void {
    if (this.run) describeRun(this.run, this.input.cwd);
    this.run = null;
  }

  walk(): void {
    for (const row of this.turn.rows) {
      this.placePermissionsUpTo(row.seqStart ?? row.seq);
      this.visit(row);
    }
    this.closeRun();
    this.placePermissionsUpTo(Number.POSITIVE_INFINITY);
  }

  private visit(row: ActivityRow): void {
    const item = row.item;
    if (item.type === "tool_call") {
      this.visitToolCall(row, item);
      return;
    }
    if (item.type === "user_message") return;
    this.closeRun();
    if (item.type === "todo") this.todos = item.items;
    else if (item.type === "assistant_message") this.lastAssistant = row;
    else if (item.type === "compaction") this.addCompaction(row, item.status, item.trigger);
    else if (item.type === "error") this.addError(row, item.message);
  }

  private visitToolCall(row: ActivityRow, call: ToolCallTimelineItem): void {
    if (isTaskListTool(call)) {
      this.closeRun();
      this.todos = todoItemsFromTaskTool(call) ?? this.todos;
      return;
    }
    if (!isGroupable(call)) {
      this.closeRun();
      const single: ToolRun = { node: toolRunNode(call.callId, row.seq), calls: [call] };
      this.build.main.push(single.node);
      describeRun(single, this.input.cwd);
      return;
    }
    if (!this.run) {
      this.run = { node: toolRunNode(call.callId, row.seq), calls: [] };
      this.build.main.push(this.run.node);
    }
    this.run.calls.push(call);
    if (call.detail.type === "sub_agent") this.addSubagent(row, call, this.run.node.id);
  }

  private addSubagent(row: ActivityRow, call: ToolCallTimelineItem, parentId: string): void {
    if (call.detail.type !== "sub_agent") return;
    const descriptor = this.subagentsByCall.get(call.callId);
    const label = descriptor?.title || call.detail.subAgentType || "Subagent";
    const sublabel = descriptor?.description || call.detail.description;
    this.build.branches.push({
      id: stableNodeId("sa", call.callId),
      kind: "subagent",
      label: truncateText(label, LABEL_UNITS),
      ...(sublabel ? { sublabel: truncateText(sublabel, SUBLABEL_UNITS) } : {}),
      tag: "subagent",
      status: descriptor ? subagentStatus(descriptor.status) : callStatus(call),
      ref: {
        kind: "subagent",
        callId: call.callId,
        seq: row.seq,
        ...(descriptor ? { subagentId: descriptor.id } : {}),
      },
      placement: "branch",
      parentId,
      returns: true,
    });
  }

  private addCompaction(
    row: ActivityRow,
    status: "loading" | "completed",
    trigger: "auto" | "manual" | undefined,
  ): void {
    this.build.main.push({
      id: stableNodeId("compaction", String(row.seqStart ?? row.seq)),
      kind: "compaction",
      label: "Context compacted",
      sublabel: trigger === "manual" ? "manual" : "automatic",
      tag: "context",
      status: status === "loading" ? "running" : "done",
      ref: { kind: "compaction", seq: row.seq },
      placement: "main",
    });
  }

  private addError(row: ActivityRow, message: string): void {
    this.build.main.push({
      id: stableNodeId("error", String(row.seqStart ?? row.seq)),
      kind: "error",
      label: "Error",
      sublabel: truncateText(message, SUBLABEL_UNITS),
      tag: "error",
      status: "failed",
      ref: { kind: "error", seq: row.seq },
      placement: "main",
    });
  }

  // "Will do": unfinished todos of this turn, after the node that is running (spec 31.2).
  appendTodos(): void {
    for (const todo of this.todos ?? []) {
      const status = todoStatus(todo);
      if (status === "completed") continue;
      this.build.main.push({
        id: todoNodeId(todo),
        kind: "todo",
        ...splitPromptLabel(todo.text.replace(/\s+/g, " ").trim()),
        tag: "todo",
        status: status === "in_progress" ? "running" : "pending",
        ref: { kind: "todo", ...(todo.id ? { todoId: todo.id } : {}) },
        placement: "main",
        plannedEdge: true,
      });
    }
  }

  appendEnd(live: boolean, outcome: ActivityTurnOutcome | null | undefined): void {
    const endRef = {
      kind: "end" as const,
      ...(this.lastAssistant ? { seq: this.lastAssistant.seq } : {}),
    };
    const end = (label: string, status: ActivityGraphNodeStatus, sublabel?: string): GraphNode => ({
      id: "end",
      kind: "end",
      label,
      ...(sublabel ? { sublabel } : {}),
      tag: "end",
      status,
      ref: endRef,
      placement: "main",
    });
    if (live) {
      // The turn has started but nothing structured happened yet; archify needs two states on the
      // main path, and the reader needs to see that the agent is at work.
      if (this.build.main.length === 1) {
        this.build.main.push({
          id: "working",
          kind: "end",
          label: "Working",
          sublabel: "reading and reasoning",
          tag: "now",
          status: "running",
          ref: { kind: "end" },
          placement: "main",
        });
      }
      return;
    }
    if (outcome === "failed") this.build.main.push(end("Turn failed", "failed"));
    else if (outcome === "canceled")
      this.build.main.push(end("Stopped", "done", "canceled by user"));
    else if (this.lastAssistant) this.build.main.push(end("Answer", "done", this.answerLine()));
    if (this.build.main.length === 1) this.build.main.push(end("No answer", "done"));
  }

  private answerLine(): string | undefined {
    const item = this.lastAssistant?.item;
    const text = item?.type === "assistant_message" ? item.text.trim() : "";
    return text ? truncateText(firstLine(text, 200), SUBLABEL_UNITS) : undefined;
  }
}

export function buildFlowGraph(input: ActivityInput): FlowResult | null {
  const turns = splitTurns(input.rows);
  const turn = resolveTurn(turns, input.turnIndex);
  if (!turn) return null;
  const isLatest = turn.index === turns.length - 1;
  const live = isLatest && input.running;
  const assembler = new FlowAssembler(input, turn);
  assembler.walk();
  assembler.appendTodos();
  assembler.appendEnd(live, isLatest ? input.latestTurnOutcome : null);
  capNodes(assembler.build);
  return {
    model: {
      view: "flow",
      title: input.title?.trim() || "Agent activity",
      nodes: [...assembler.build.main, ...assembler.build.branches],
    },
    turns: { turns: summarizeTurns(turns), turnIndex: turn.index, live },
  };
}
