import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { acceptSelectMessage, resolveNodeAction } from "./activity-graph-target";

// Spec 31.6 (only jad-archify-select for a node of the shown version) and 31.4 (node → row).

const nodeIndex = {
  "tools-call_read": {
    kind: "tools" as const,
    callId: "call_read",
    callIds: ["call_read", "call_grep"],
    seq: 3,
  },
  start: { kind: "start" as const, seq: 1 },
};

function toolItem(id: string, callId: string, seq: number): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date(0),
    timelineCursor: { epoch: "e", seq },
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId,
        name: "Read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "a.ts" },
      },
    },
  } as StreamItem;
}

const items: StreamItem[] = [
  {
    kind: "user_message",
    id: "msg_user",
    text: "Go",
    timestamp: new Date(0),
    timelineCursor: { epoch: "e", seq: 1 },
  } as StreamItem,
  toolItem("row_read", "call_read", 3),
  toolItem("row_grep", "call_grep", 4),
  {
    kind: "todo_list",
    id: "row_todo",
    timestamp: new Date(0),
    provider: "claude",
    items: [],
  } as StreamItem,
];

describe("acceptSelectMessage", () => {
  it("accepts a node of the shown version", () => {
    expect(acceptSelectMessage({ type: "jad-archify-select", nodeId: "start" }, nodeIndex)).toBe(
      "start",
    );
  });
  it("ignores unknown node ids, other types and malformed data", () => {
    expect(
      acceptSelectMessage({ type: "jad-archify-select", nodeId: "evil" }, nodeIndex),
    ).toBeNull();
    expect(
      acceptSelectMessage({ type: "jad-archify-select", nodeId: "__proto__" }, nodeIndex),
    ).toBeNull();
    expect(acceptSelectMessage({ type: "jad-archify-size", height: 10 }, nodeIndex)).toBeNull();
    expect(acceptSelectMessage({ type: "jad-archify-select", nodeId: 7 }, nodeIndex)).toBeNull();
    expect(acceptSelectMessage("jad-archify-select", nodeIndex)).toBeNull();
    expect(acceptSelectMessage({ type: "jad-archify-select", nodeId: "start" }, null)).toBeNull();
  });
});

describe("resolveNodeAction", () => {
  it("opens a tool group at the row of its first call (same callId)", () => {
    expect(resolveNodeAction(nodeIndex["tools-call_read"], items)).toEqual({
      kind: "timeline",
      itemId: "row_read",
    });
  });
  it("finds rows by seq, else the nearest later row", () => {
    expect(resolveNodeAction({ kind: "start", seq: 1 }, items)).toEqual({
      kind: "timeline",
      itemId: "msg_user",
    });
    expect(resolveNodeAction({ kind: "end", seq: 2 }, items)).toEqual({
      kind: "timeline",
      itemId: "row_read",
    });
  });
  it("opens the subagent panel, the todo list, or the pending approval", () => {
    expect(
      resolveNodeAction({ kind: "subagent", callId: "call_task", subagentId: "sub_1" }, items),
    ).toEqual({ kind: "subagent", subagentId: "sub_1" });
    expect(resolveNodeAction({ kind: "todo", todoId: "2" }, items)).toEqual({
      kind: "timeline",
      itemId: "row_todo",
    });
    expect(resolveNodeAction({ kind: "permission", requestId: "p" }, items)).toEqual({
      kind: "bottom",
    });
  });
});
