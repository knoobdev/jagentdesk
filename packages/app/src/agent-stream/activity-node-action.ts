import {
  ACTIVITY_GRAPH_SELECT_MESSAGE,
  type ActivityGraphNodeRef,
} from "@jagentdesk/protocol/agent-activity-graph";
import type { StreamItem } from "@/types/stream";

// Spec 31.6: the frame may send one kind of message; the app acts on it only when the node id
// belongs to the version it is showing.
export function acceptSelectMessage(
  data: unknown,
  nodeIndex: Readonly<Record<string, ActivityGraphNodeRef>> | null,
): string | null {
  if (!nodeIndex || !data || typeof data !== "object") return null;
  const message = data as { type?: unknown; nodeId?: unknown };
  if (message.type !== ACTIVITY_GRAPH_SELECT_MESSAGE) return null;
  if (typeof message.nodeId !== "string") return null;
  return Object.prototype.hasOwnProperty.call(nodeIndex, message.nodeId) ? message.nodeId : null;
}

export type ActivityNodeAction =
  | { kind: "subagent"; subagentId: string }
  | { kind: "timeline"; itemId: string }
  | { kind: "bottom" }
  | { kind: "none" };

function callIdOf(item: StreamItem): string | null {
  return item.kind === "tool_call" && item.payload.source === "agent"
    ? item.payload.data.callId
    : null;
}

function byCallId(ref: ActivityGraphNodeRef, items: readonly StreamItem[]): string | null {
  const callId = ref.callIds?.[0] ?? ref.callId;
  if (!callId) return null;
  return items.find((item) => callIdOf(item) === callId)?.id ?? null;
}

function latestTodoList(items: readonly StreamItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index]!.kind === "todo_list") return items[index]!.id;
  }
  return null;
}

// The row with this seq, else the first row after it (projected rows merge several seqs).
function bySeq(seq: number, items: readonly StreamItem[]): string | null {
  let best: StreamItem | null = null;
  let bestSeq = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const itemSeq = item.timelineCursor?.seq;
    if (typeof itemSeq !== "number" || itemSeq < seq || itemSeq >= bestSeq) continue;
    best = item;
    bestSeq = itemSeq;
  }
  return best?.id ?? null;
}

function timeline(itemId: string | null): ActivityNodeAction {
  return itemId ? { kind: "timeline", itemId } : { kind: "none" };
}

// Where a node leads in the chat (spec 31.4): a subagent opens its panel; a tool node its group
// (the first call of the run is the group's row); other nodes the timeline row with their seq,
// or the nearest row after it; a pending approval the bottom of the chat, where it is answered.
export function resolveNodeAction(
  ref: ActivityGraphNodeRef,
  items: readonly StreamItem[],
): ActivityNodeAction {
  if (ref.kind === "subagent" && ref.subagentId) {
    return { kind: "subagent", subagentId: ref.subagentId };
  }
  if (ref.kind === "permission") return { kind: "bottom" };
  const call = byCallId(ref, items);
  if (call) return timeline(call);
  if (ref.kind === "todo") return timeline(latestTodoList(items));
  return typeof ref.seq === "number" ? timeline(bySeq(ref.seq, items)) : { kind: "none" };
}
