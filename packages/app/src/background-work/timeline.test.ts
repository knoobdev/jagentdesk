import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  indexBackgroundStarts,
  isBackgroundTimelineItem,
  readBackgroundTimelineEvent,
} from "./timeline";

type ToolCall = Extract<StreamItem, { kind: "tool_call" }>;

function toolCall(input: {
  id: string;
  callId: string;
  name: string;
  at: string;
  detail: ToolCall["payload"]["data"] extends infer D
    ? D extends { detail: infer T }
      ? T
      : never
    : never;
  metadata?: Record<string, unknown>;
}): ToolCall {
  return {
    kind: "tool_call",
    id: input.id,
    timestamp: new Date(input.at),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: input.callId,
        name: input.name,
        status: "completed",
        error: null,
        detail: input.detail,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      },
    },
  } as ToolCall;
}

const start = toolCall({
  id: "a",
  callId: "toolu_1",
  name: "Bash",
  at: "2026-11-26T10:00:00Z",
  detail: { type: "shell", command: "sleep 120" },
  metadata: { background: true },
});
const foreground = toolCall({
  id: "b",
  callId: "toolu_2",
  name: "Bash",
  at: "2026-11-26T10:00:01Z",
  detail: { type: "shell", command: "pwd" },
});
const finish = toolCall({
  id: "c",
  callId: "task_notification_x",
  name: "task_notification",
  at: "2026-11-26T10:02:00Z",
  detail: { type: "plain_text", label: 'Background command "sleep 120" completed (exit code 0)' },
  metadata: { source: "claude_task_notification", toolUseId: "toolu_1", synthetic: true },
});
const subagentNotice = toolCall({
  id: "d",
  callId: "task_notification_y",
  name: "task_notification",
  at: "2026-11-26T10:03:00Z",
  detail: { type: "plain_text", label: 'Agent "review" completed' },
  metadata: { source: "claude_task_notification", toolUseId: "toolu_9" },
});

describe("background timeline rows", () => {
  it("shows a background Bash call as a start row with its command", () => {
    expect(readBackgroundTimelineEvent(start, () => undefined)).toEqual({
      kind: "started",
      label: "sleep 120",
    });
    expect(readBackgroundTimelineEvent(foreground, () => undefined)).toBeNull();
  });

  it("names the finished task and its duration from the start it links to", () => {
    const starts = indexBackgroundStarts([start, foreground], [finish]);
    expect(readBackgroundTimelineEvent(finish, (id) => starts.get(id))).toEqual({
      kind: "finished",
      label: "sleep 120",
      durationMs: 120_000,
      exitCode: 0,
    });
  });

  it("falls back to the summary's command when the start is not loaded", () => {
    expect(readBackgroundTimelineEvent(finish, () => undefined)).toEqual({
      kind: "finished",
      label: "sleep 120",
      durationMs: null,
      exitCode: 0,
    });
  });

  it("recognises a stopped task whose summary is its description by the linked start", () => {
    const stopped = toolCall({
      id: "e",
      callId: "task_notification_z",
      name: "task_notification",
      at: "2026-11-26T10:00:30Z",
      detail: { type: "plain_text", label: "Wait 120 seconds in background" },
      metadata: { source: "claude_task_notification", toolUseId: "toolu_1", status: "stopped" },
    });
    const starts = indexBackgroundStarts([start]);
    expect(readBackgroundTimelineEvent(stopped, (id) => starts.get(id))).toEqual({
      kind: "finished",
      label: "sleep 120",
      durationMs: 30_000,
      exitCode: null,
    });
    expect(readBackgroundTimelineEvent(stopped, () => undefined)).toBeNull();
  });

  it("leaves other task notifications as tool calls and keeps rows out of groups", () => {
    expect(readBackgroundTimelineEvent(subagentNotice, () => undefined)).toBeNull();
    expect(isBackgroundTimelineItem(start)).toBe(true);
    expect(isBackgroundTimelineItem(finish)).toBe(true);
    expect(isBackgroundTimelineItem(foreground)).toBe(false);
    expect(isBackgroundTimelineItem(subagentNotice)).toBe(false);
  });

  // Codex, OpenCode and other providers: rows the daemon writes from the background inventory.
  it("reads the daemon's inventory rows for providers other than Claude", () => {
    const inventoryStart = toolCall({
      id: "f",
      callId: "background_work:p1:1:started",
      name: "background_work",
      at: "2026-11-26T10:00:00Z",
      detail: { type: "plain_text", label: "Started in background · npm test" },
      metadata: { source: "background_work", phase: "started", label: "npm test" },
    });
    const inventoryFinish = toolCall({
      id: "g",
      callId: "background_work:p1:1:finished",
      name: "background_work",
      at: "2026-11-26T10:01:35Z",
      detail: { type: "plain_text", label: "Background task finished · npm test" },
      metadata: {
        source: "background_work",
        phase: "finished",
        label: "npm test",
        durationMs: 95_000,
      },
    });
    expect(readBackgroundTimelineEvent(inventoryStart, () => undefined)).toEqual({
      kind: "started",
      label: "npm test",
    });
    expect(readBackgroundTimelineEvent(inventoryFinish, () => undefined)).toEqual({
      kind: "finished",
      label: "npm test",
      durationMs: 95_000,
      exitCode: null,
    });
    expect(isBackgroundTimelineItem(inventoryStart)).toBe(true);
    expect(isBackgroundTimelineItem(inventoryFinish)).toBe(true);
  });
});
