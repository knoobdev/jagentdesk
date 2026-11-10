import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import {
  getJAgentDeskToolLeafName,
  normalizeToolName,
} from "@jagentdesk/protocol/tool-name-normalization";

const SSH_RUN_TOOL_LEAF_NAME = "ssh_run";

/** True for the ssh_run tool however the agent names it: plain (`ssh_run`),
 * daemon-prefixed (`jagentdesk.ssh_run`), MCP-prefixed (`mcp__jagentdesk__ssh_run`)
 * or OpenCode-flattened (`jagentdesk_ssh_run`). */
export function isSshRunToolName(toolName: string): boolean {
  return (
    (getJAgentDeskToolLeafName(toolName) ?? normalizeToolName(toolName)) === SSH_RUN_TOOL_LEAF_NAME
  );
}

/** The part of an `ssh_run` call the result card needs (spec 33.9 / ADR-0045 §7). */
export interface SshRunToolResult {
  serverId: string;
  /** Command, taken from the call input — the result payload does not repeat it. */
  command: string;
  stdout: string;
  stderr: string;
  /** null when the channel closed without a status or the command was killed by a signal. */
  exitCode: number | null;
  signal: string | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
}

/**
 * Extracts the ssh_run result from a tool call's detail. The output is the JSON result
 * (object or string) or an MCP content array whose text item holds the JSON; the command
 * comes from the call input. Returns null for pending calls and malformed results.
 */
export function readSshRunToolResult(
  toolName: string,
  detail: ToolCallDetail | undefined,
): SshRunToolResult | null {
  if (!detail || !isSshRunToolName(toolName)) return null;
  let raw: unknown;
  let input: unknown = null;
  if (detail.type === "unknown") {
    raw = detail.output;
    input = detail.input;
  } else if (detail.type === "plain_text") {
    raw = detail.text;
  } else {
    return null;
  }
  const parsed = parseSshRunResult(raw);
  if (!parsed) return null;
  return { ...parsed, command: readCommand(input) };
}

function readCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : "";
}

/**
 * Parses the ssh_run result payload: the JSON object itself, a JSON string, or an MCP
 * content array whose first text item holds the JSON. Malformed payloads → null.
 */
export function parseSshRunResult(raw: unknown): Omit<SshRunToolResult, "command"> | null {
  let value = raw;
  if (typeof value === "string") {
    value = parseJsonObject(value);
  } else if (isMcpContentArray(value)) {
    const text = firstMcpContentText(value.content);
    if (text === null) return null;
    value = parseJsonObject(text);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.serverId !== "string" || record.serverId.length === 0) return null;
  if (typeof record.exitCode !== "number" && record.exitCode !== null) return null;
  return {
    serverId: record.serverId,
    stdout: typeof record.stdout === "string" ? record.stdout : "",
    stderr: typeof record.stderr === "string" ? record.stderr : "",
    exitCode: record.exitCode,
    signal: typeof record.signal === "string" ? record.signal : null,
    stdoutTruncated: record.stdoutTruncated === true,
    stderrTruncated: record.stderrTruncated === true,
    timedOut: record.timedOut === true,
  };
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function isMcpContentArray(
  value: unknown,
): value is { content: unknown[] } & Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).content)
  );
}

function firstMcpContentText(content: unknown[]): string | null {
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") return record.text;
  }
  return null;
}
