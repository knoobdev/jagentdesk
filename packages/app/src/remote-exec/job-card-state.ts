import type { RemoteJob, RemoteJobStatus } from "@jagentdesk/protocol/remote-exec/rpc-schemas";

/** The card keeps at most the last 64 KiB of job output in memory (spec 33.9). */
export const REMOTE_JOB_OUTPUT_TAIL_LIMIT = 64 * 1024;

/** Terminal statuses stop the live update loop (spec 33.6): no further reads or listens. */
const TERMINAL_STATUSES: ReadonlySet<RemoteJobStatus> = new Set([
  "succeeded",
  "failed",
  "stopped",
  "timed_out",
  "lost",
]);

export function isTerminalRemoteJobStatus(status: RemoteJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export interface RemoteJobCardState {
  job: RemoteJob | null;
  /** Tail of the combined output, at most REMOTE_JOB_OUTPUT_TAIL_LIMIT characters. */
  output: string;
  /** Byte offset the next `remote_exec.read_job_output` starts at. */
  nextOffset: number;
  totalBytes: number;
}

export type RemoteJobCardAction =
  /** A `remote_exec.job_updated` push, a get/stop response, or the tool result's job. */
  | { type: "job"; job: RemoteJob }
  /** Mount fetch that replaces the tail (history restore: the middle is not kept). */
  | {
      type: "loaded";
      job: RemoteJob | null;
      output: string;
      nextOffset: number;
      totalBytes: number;
    }
  /** One `remote_exec.read_job_output` response appended to the tail. */
  | { type: "chunk"; chunk: string; nextOffset: number; totalBytes: number };

export function appendOutputTail(
  existing: string,
  chunk: string,
  limit: number = REMOTE_JOB_OUTPUT_TAIL_LIMIT,
): string {
  if (chunk.length >= limit) return chunk.slice(chunk.length - limit);
  const combined = existing + chunk;
  return combined.length > limit ? combined.slice(combined.length - limit) : combined;
}

export function remoteJobCardReducer(
  state: RemoteJobCardState,
  action: RemoteJobCardAction,
): RemoteJobCardState {
  switch (action.type) {
    case "job":
      return { ...state, job: action.job };
    case "loaded":
      return {
        job: action.job ?? state.job,
        output: action.output,
        nextOffset: Math.max(state.nextOffset, action.nextOffset),
        totalBytes: Math.max(state.totalBytes, action.totalBytes),
      };
    case "chunk":
      return {
        ...state,
        output: appendOutputTail(state.output, action.chunk),
        nextOffset: Math.max(state.nextOffset, action.nextOffset),
        totalBytes: Math.max(state.totalBytes, action.totalBytes),
      };
  }
}
