import type { StreamItem } from "@/types/stream";

/** What the timeline knows about a background task's start, keyed by the starting call's id. */
export interface BackgroundStart {
  command: string;
  startedAtMs: number;
}

export type BackgroundTimelineEvent =
  | { kind: "started"; label: string }
  | {
      kind: "finished";
      label: string | null;
      durationMs: number | null;
      exitCode: number | null;
    };

type ToolCallStreamItem = Extract<StreamItem, { kind: "tool_call" }>;

// Claude's own wording for a background Bash task ending: `Background command "npm test"
// completed (exit code 0)`, `… failed with exit code 1`, `… was stopped`.
const FINISHED_SUMMARY = /^Background command\b/;
const SUMMARY_COMMAND = /^Background command "(.*)"/s;
const SUMMARY_EXIT_CODE = /exit code (-?\d+)/;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A Bash call the provider ran with `run_in_background` (server metadata `background: true`). */
export function readBackgroundStart(item: StreamItem): BackgroundStart | null {
  if (item.kind !== "tool_call" || item.payload.source !== "agent") return null;
  const { data } = item.payload;
  if (data.metadata?.background !== true || data.detail.type !== "shell") return null;
  return { command: data.detail.command, startedAtMs: item.timestamp.getTime() };
}

function readTaskNotification(item: ToolCallStreamItem): {
  summary: string;
  toolUseId: string | null;
} | null {
  if (item.payload.source !== "agent") return null;
  const { data } = item.payload;
  if (data.name !== "task_notification") return null;
  if (data.metadata?.source !== "claude_task_notification") return null;
  const summary = data.detail.type === "plain_text" ? readString(data.detail.label) : null;
  if (!summary) return null;
  return { summary, toolUseId: readString(data.metadata.toolUseId) };
}

/**
 * True for the timeline items drawn as background rows; they stay out of tool call groups. A
 * finish whose summary is a description is only known once its start is looked up, so it may sit
 * in a group; the group then draws it as the same row.
 */
export function isBackgroundTimelineItem(item: StreamItem): boolean {
  if (readBackgroundStart(item)) return true;
  if (item.kind !== "tool_call") return false;
  const notification = readTaskNotification(item);
  return notification !== null && FINISHED_SUMMARY.test(notification.summary);
}

export function readBackgroundTimelineEvent(
  item: ToolCallStreamItem,
  lookupStart: (callId: string) => BackgroundStart | undefined,
): BackgroundTimelineEvent | null {
  const start = readBackgroundStart(item);
  if (start) return { kind: "started", label: start.command };
  const notification = readTaskNotification(item);
  if (!notification) return null;
  // The notification names the Bash call that started the task. Its summary is either Claude's
  // "Background command …" sentence or the task's own description, so the link decides.
  const started = notification.toolUseId ? lookupStart(notification.toolUseId) : undefined;
  if (!started && !FINISHED_SUMMARY.test(notification.summary)) return null;
  const exit = SUMMARY_EXIT_CODE.exec(notification.summary);
  return {
    kind: "finished",
    label: started?.command ?? SUMMARY_COMMAND.exec(notification.summary)?.[1] ?? null,
    durationMs: started ? Math.max(0, item.timestamp.getTime() - started.startedAtMs) : null,
    exitCode: exit ? Number(exit[1]) : null,
  };
}

/** Every background start in a stream, for the finish row to name its command and duration. */
export function indexBackgroundStarts(
  ...streams: ReadonlyArray<readonly StreamItem[] | undefined>
): Map<string, BackgroundStart> {
  const starts = new Map<string, BackgroundStart>();
  for (const stream of streams) {
    for (const item of stream ?? []) {
      const start = readBackgroundStart(item);
      if (start && item.kind === "tool_call" && item.payload.source === "agent")
        starts.set(item.payload.data.callId, start);
    }
  }
  return starts;
}
