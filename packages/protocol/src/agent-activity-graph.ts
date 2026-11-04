import { z } from "zod";

// Agent activity graph (spec 31, ADR-0031): the daemon draws what an agent did, is doing and will do
// as an archify diagram built algorithmically from the agent stream (no model calls) and pushes
// re-render / status notifications to subscribed clients.

export const ActivityGraphViewSchema = z.enum(["flow", "plan"]);
export type ActivityGraphView = z.infer<typeof ActivityGraphViewSchema>;

// Node status painted by the app's overlay (spec 31.3). Colors come from the design system §1.4.
export const ActivityGraphNodeStatusSchema = z.enum([
  "pending",
  "running",
  "waiting",
  "failed",
  "done",
]);
export type ActivityGraphNodeStatus = z.infer<typeof ActivityGraphNodeStatusSchema>;

export const ActivityGraphNodeKindSchema = z.enum([
  "start",
  "tools",
  "subagent",
  "permission",
  "compaction",
  "error",
  "todo",
  "end",
  "earlier",
  "root",
  "phase",
  "task",
]);
export type ActivityGraphNodeKind = z.infer<typeof ActivityGraphNodeKindSchema>;

// Where a node leads in the app: the timeline row (seq / callId), the provider subagent panel
// (subagentId), the permission prompt (requestId) or the todo list (todoId).
export const ActivityGraphNodeRefSchema = z.object({
  kind: ActivityGraphNodeKindSchema,
  seq: z.number().int().nonnegative().optional(),
  callId: z.string().optional(),
  // Every call grouped into a tools node, in order; the app opens the group at the first one.
  callIds: z.array(z.string()).optional(),
  subagentId: z.string().optional(),
  requestId: z.string().optional(),
  todoId: z.string().optional(),
});
export type ActivityGraphNodeRef = z.infer<typeof ActivityGraphNodeRefSchema>;

export const ActivityGraphTurnSummarySchema = z.object({
  turnIndex: z.number().int().nonnegative(),
  label: z.string(),
  // Timeline seq of the user message that opened the turn.
  seq: z.number().int().nonnegative(),
});
export type ActivityGraphTurnSummary = z.infer<typeof ActivityGraphTurnSummarySchema>;

export const ActivityGraphNodeStatusEntrySchema = z.object({
  id: z.string(),
  status: ActivityGraphNodeStatusSchema,
});
export type ActivityGraphNodeStatusEntry = z.infer<typeof ActivityGraphNodeStatusEntrySchema>;

export const ActivityGraphErrorCodeSchema = z.enum([
  "no_activity",
  "not_found",
  "unsupported",
  "render_failed",
]);
export type ActivityGraphErrorCode = z.infer<typeof ActivityGraphErrorCodeSchema>;

export const ActivityGraphGetRequestSchema = z.object({
  type: z.literal("agent.activity_graph.get.request"),
  requestId: z.string(),
  agentId: z.string(),
  view: ActivityGraphViewSchema,
  // 0-based index into the agent's turns; omitted = the latest (live) turn.
  turnIndex: z.number().int().nonnegative().optional(),
});

export const ActivityGraphGetResponseSchema = z.object({
  type: z.literal("agent.activity_graph.get.response"),
  payload: z.object({
    requestId: z.string(),
    agentId: z.string(),
    view: ActivityGraphViewSchema,
    graphVersion: z.number().int().nonnegative(),
    html: z.string(),
    nodeIndex: z.record(z.string(), ActivityGraphNodeRefSchema),
    // Node statuses at render time, so the overlay is correct before the first status push.
    nodes: z.array(ActivityGraphNodeStatusEntrySchema),
    // The turn this graph draws, whether it is the live (latest) turn, and the most recent turns
    // for the picker (spec 31.4: up to 10).
    turnIndex: z.number().int().nonnegative(),
    live: z.boolean(),
    turns: z.array(ActivityGraphTurnSummarySchema),
    error: ActivityGraphErrorCodeSchema.nullable(),
  }),
});

export const ActivityGraphSubscribeRequestSchema = z.object({
  type: z.literal("agent.activity_graph.subscribe.request"),
  requestId: z.string(),
  agentId: z.string(),
  view: ActivityGraphViewSchema,
});

export const ActivityGraphSubscribeResponseSchema = z.object({
  type: z.literal("agent.activity_graph.subscribe.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().nullable(),
    error: ActivityGraphErrorCodeSchema.nullable(),
  }),
});

export const ActivityGraphUnsubscribeRequestSchema = z.object({
  type: z.literal("agent.activity_graph.unsubscribe.request"),
  requestId: z.string(),
  subscriptionId: z.string(),
});

export const ActivityGraphUnsubscribeResponseSchema = z.object({
  type: z.literal("agent.activity_graph.unsubscribe.response"),
  payload: z.object({
    requestId: z.string(),
  }),
});

// Structure changed (nodes or edges added/removed): the client fetches the new HTML.
export const ActivityGraphChangedMessageSchema = z.object({
  type: z.literal("agent.activity_graph.changed"),
  payload: z.object({
    agentId: z.string(),
    view: ActivityGraphViewSchema,
    graphVersion: z.number().int().nonnegative(),
  }),
});

// Only node statuses changed: the client forwards them into the frame without reloading it.
export const ActivityGraphStatusMessageSchema = z.object({
  type: z.literal("agent.activity_graph.status"),
  payload: z.object({
    agentId: z.string(),
    view: ActivityGraphViewSchema,
    graphVersion: z.number().int().nonnegative(),
    nodes: z.array(ActivityGraphNodeStatusEntrySchema),
  }),
});

export type ActivityGraphGetResponse = z.infer<typeof ActivityGraphGetResponseSchema>;
export type ActivityGraphGetResponsePayload = ActivityGraphGetResponse["payload"];
export type ActivityGraphChangedMessage = z.infer<typeof ActivityGraphChangedMessageSchema>;
export type ActivityGraphStatusMessage = z.infer<typeof ActivityGraphStatusMessageSchema>;

// Messages from the sandboxed diagram frame to the app (spec 31.6). The frame may send exactly one
// kind of message outward; the app accepts a nodeId only when it is in the shown version's nodeIndex.
export const ACTIVITY_GRAPH_SELECT_MESSAGE = "jad-archify-select";
// Message the app posts into the frame with node statuses (spec 31.3).
export const ACTIVITY_GRAPH_STATUS_MESSAGE = "jad-archify-status";
