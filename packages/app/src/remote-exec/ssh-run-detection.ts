import type { ToolCallDetail } from "@jagentdesk/protocol/agent-types";
import {
  getJAgentDeskToolLeafName,
  normalizeToolName,
} from "@jagentdesk/protocol/tool-name-normalization";
import { unwrapToolResultPayload } from "./tool-result-payload";

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
 * Extracts the ssh_run result from a tool call's detail. The output is the JSON result however
 * the provider wraps it (see tool-result-payload.ts); the command comes from the call input
 * (or the shell detail for ACP agents). Returns null for pending calls and malformed results.
 */
export function readSshRunToolResult(
  toolName: string,
  detail: ToolCallDetail | undefined,
): SshRunToolResult | null {
  if (!detail || !isSshRunToolName(toolName)) return null;
  let raw: unknown;
  let input: unknown = null;
  let shellCommand: string | null = null;
  if (detail.type === "unknown") {
    raw = detail.output;
    input = detail.input;
  } else if (detail.type === "plain_text") {
    raw = detail.text;
  } else if (detail.type === "shell") {
    // Generic ACP "execute" tools arrive as shell details with the tool JSON as output text.
    raw = detail.output;
    shellCommand = typeof detail.command === "string" ? detail.command : null;
  } else {
    return null;
  }
  const parsed = parseSshRunResult(raw);
  if (!parsed) return null;
  const command = readCommand(input) ?? shellCommand ?? "";
  return { ...parsed, command };
}

function readCommand(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const command = (input as Record<string, unknown>).command;
  return typeof command === "string" ? command : null;
}

/**
 * Parses the ssh_run result payload: the JSON object itself, a JSON string, an MCP content
 * array whose text item holds the JSON, or a provider wrapper ({type:'command', command,
 * output} / {output}) with the payload under `output`. Malformed payloads → null.
 */
export function parseSshRunResult(raw: unknown): Omit<SshRunToolResult, "command"> | null {
  const payload = unwrapToolResultPayload(raw, isValidSshRunPayload);
  if (!payload) return null;
  return {
    serverId: payload.serverId as string,
    stdout: typeof payload.stdout === "string" ? payload.stdout : "",
    stderr: typeof payload.stderr === "string" ? payload.stderr : "",
    exitCode: payload.exitCode as number | null,
    signal: typeof payload.signal === "string" ? payload.signal : null,
    stdoutTruncated: payload.stdoutTruncated === true,
    stderrTruncated: payload.stderrTruncated === true,
    timedOut: payload.timedOut === true,
  };
}

function isValidSshRunPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.serverId !== "string" || record.serverId.length === 0) return false;
  return typeof record.exitCode === "number" || record.exitCode === null;
}
