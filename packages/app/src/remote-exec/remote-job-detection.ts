import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import type { RemoteJob } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import {
  getJAgentDeskToolLeafName,
  normalizeToolName,
} from "@jagentdesk/protocol/tool-name-normalization";

const REMOTE_JOB_TOOL_LEAF_NAMES: ReadonlySet<string> = new Set(["remote_run", "remote_job_wait"]);

/** True for the remote job tools however the agent names them: plain (`remote_run`),
 * daemon-prefixed (`jagentdesk.remote_run`) or MCP-prefixed (`mcp__jagentdesk__remote_run`). */
export function isRemoteJobToolName(toolName: string): boolean {
  return REMOTE_JOB_TOOL_LEAF_NAMES.has(remoteJobLeafName(toolName));
}

/**
 * `remote_run` keeps the full card with the output box; `remote_job_wait` results are terminal,
 * so they render as a compact card with a collapsed "Show output" toggle (spec 33.9 follow-up).
 */
export function remoteJobCardVariant(toolName: string): "full" | "compact" {
  return remoteJobLeafName(toolName) === "remote_job_wait" ? "compact" : "full";
}

function remoteJobLeafName(toolName: string): string {
  return getJAgentDeskToolLeafName(toolName) ?? normalizeToolName(toolName);
}

/** The part of a `remote_run` / `remote_job_wait` result the job card needs (spec 33.7). */
export interface RemoteJobToolResult {
  job: RemoteJob;
  /** Tail of the output at result time; empty while the job is still pending. */
  output: string;
  /** Byte offset `output` starts at in the full output stream. */
  outputOffset: number;
  /** True when the result dropped an output head (spec 33.7 `outputTruncatedHead`). */
  outputTruncatedHead: boolean;
}

/**
 * Extracts the job from a remote job tool call's result. Tools arrive with `unknown` details
 * whose output is the JSON result (object or string); `plain_text` carries the JSON as text.
 * Returns null for pending calls (no result yet) and for results without a `rjb_` job.
 */
export function readRemoteJobToolResult(
  toolName: string,
  detail: ToolCallDetail | undefined,
): RemoteJobToolResult | null {
  if (!detail || !isRemoteJobToolName(toolName)) return null;
  let raw: unknown;
  if (detail.type === "unknown") {
    raw = detail.output;
  } else if (detail.type === "plain_text") {
    raw = detail.text;
  } else {
    return null;
  }
  if (raw === undefined || raw === null) return null;
  return parseRemoteJobResult(raw);
}

function parseRemoteJobResult(raw: unknown): RemoteJobToolResult | null {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const job = record.job;
  if (!job || typeof job !== "object") return null;
  const jobRecord = job as Record<string, unknown>;
  if (typeof jobRecord.id !== "string" || !jobRecord.id.startsWith("rjb_")) return null;
  if (typeof jobRecord.status !== "string") return null;
  return {
    job: job as RemoteJob,
    output: typeof record.output === "string" ? record.output : "",
    outputOffset: typeof record.outputOffset === "number" ? record.outputOffset : 0,
    outputTruncatedHead: record.outputTruncatedHead === true,
  };
}
