import type { Client } from "ssh2";
import { z } from "zod";
import type { AgentPermissionResponse } from "../../agent/agent-sdk-types.js";
import type {
  JAgentDeskToolConfig,
  JAgentDeskToolDefinition,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
} from "../../agent/tools/types.js";
import type { AcquireSshClient } from "../ssh-client-lease.js";
import { listRemoteDir, readRemoteFile, writeRemoteFile } from "./remote-files.js";
import { runRemoteCommand } from "./remote-exec.js";

// Limits from spec 25.11.
export const SSH_RUN_MAX_TIMEOUT_MS = 600_000;
export const SSH_RUN_DEFAULT_TIMEOUT_MS = 60_000;
export const SSH_RUN_MAX_BYTES_PER_STREAM = 64 * 1024;
export const SSH_READ_FILE_MAX_BYTES = 1024 * 1024;
const LIST_DIR_MAX_ENTRIES = 1000;
const CAPTURE_DEFAULT_LINES = 200;
const CAPTURE_MAX_LINES = 2000;

/** Same request the catalog's `requestHostToolPermission` takes (the permission card, 04.21). */
export interface HostToolPermissionRequest {
  name: string;
  kind: "tool";
  title: string;
  description: string;
  input: Record<string, unknown>;
}

export type RequestToolPermission = (
  agentId: string,
  request: HostToolPermissionRequest,
) => Promise<AgentPermissionResponse>;

export interface SshTerminalTab {
  terminalId: string;
  serverId: string;
  title: string;
}

/** Open SSH terminal tabs (milestone S1 owns them). */
export interface SshTerminalAccess {
  list(serverId: string): SshTerminalTab[];
  /** Writes raw bytes to the tab's shell, exactly as if the user typed them. */
  send(terminalId: string, data: string): Promise<void>;
  /** The last `lines` lines of the tab's screen + scrollback, ANSI stripped. */
  capture(terminalId: string, options: { lines: number }): Promise<string>;
}

export const SshForwardKindSchema = z.enum(["local", "remote", "dynamic"]);
export type SshForwardKind = z.infer<typeof SshForwardKindSchema>;

export interface SshForwardStartInput {
  serverId: string;
  kind: SshForwardKind;
  bindAddress: string;
  bindPort: number;
  destHost: string | null;
  destPort: number | null;
}

export interface SshForwardStarted {
  forwardId: string;
  description: string;
}

/** Port forwarding (milestone S3 owns it). */
export interface SshForwardAccess {
  start(input: SshForwardStartInput): Promise<SshForwardStarted>;
  stop(forwardId: string): Promise<void>;
}

export interface SshServerSummary {
  serverId: string;
  label: string;
  address: string;
  port: number;
  username: string | null;
  state: string;
}

/** Saved servers (milestone S1 owns them). */
export interface SshServerDirectory {
  list(): Promise<SshServerSummary[]>;
  openTerminal(serverId: string): Promise<SshTerminalTab>;
}

export interface SshAgentToolDependencies {
  acquire: AcquireSshClient;
  /** The agent using this catalog; permission cards are raised on its behalf. */
  callerAgentId: string | null;
  /** The server a server-chat agent is bound to (its `SSH_SERVER_AGENT_LABEL`), else null. */
  defaultServerId: string | null;
  requestPermission: RequestToolPermission;
  /** Tools whose access is null are not offered: an advertised tool must work. */
  terminals: SshTerminalAccess | null;
  forwards: SshForwardAccess | null;
  servers: SshServerDirectory | null;
}

export interface SshAgentTool extends JAgentDeskToolDefinition {
  /** True for tools that change state; their handler raises a permission card first (25.11). */
  requiresPermission: boolean;
}

class ToolFailure extends Error {}

function jsonResult(value: unknown): JAgentDeskToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function resolveServerId(deps: SshAgentToolDependencies, requested: string | undefined): string {
  const serverId = requested ?? deps.defaultServerId;
  if (!serverId) {
    throw new ToolFailure("serverId is required: this chat is not bound to an SSH server.");
  }
  return serverId;
}

async function withClient<T>(
  deps: SshAgentToolDependencies,
  serverId: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const lease = await deps.acquire(serverId);
  try {
    return await run(lease.client);
  } finally {
    lease.release();
  }
}

interface PermissionAsk {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
}

async function requireApproval(deps: SshAgentToolDependencies, ask: PermissionAsk): Promise<void> {
  if (!deps.callerAgentId) {
    throw new ToolFailure(`${ask.name} is only available to agent-scoped tool sessions.`);
  }
  const decision = await deps.requestPermission(deps.callerAgentId, { kind: "tool", ...ask });
  if (decision.behavior !== "allow") throw new ToolFailure("Denied by user.");
}

interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  requiresPermission: boolean;
  run: (input: z.infer<z.ZodObject<Shape>>) => Promise<JAgentDeskToolResult>;
}

function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): SshAgentTool {
  const schema = z.object(spec.inputSchema);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    requiresPermission: spec.requiresPermission,
    async handler(input: unknown) {
      try {
        return await spec.run(schema.parse(input));
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

const serverIdInput = z
  .string()
  .optional()
  .describe("SSH server id (srv_…). Defaults to the server this chat is bound to.");

function execTools(deps: SshAgentToolDependencies): SshAgentTool[] {
  const run = defineTool({
    name: "ssh_run",
    title: "Run a command on an SSH server",
    description: `Run a shell command on the SSH server over an exec channel and return stdout, stderr and the exit code (each stream cut at ${SSH_RUN_MAX_BYTES_PER_STREAM / 1024} KB). For quick inspection and administration of the server itself (uptime, disk, services, packages): it runs in the home directory, sends no code, is capped at ${SSH_RUN_MAX_TIMEOUT_MS / 1000} s and ${SSH_RUN_MAX_BYTES_PER_STREAM / 1024} KB per stream. To build or test project code on another machine, use remote_run. Not a TTY: interactive programs will not work, use ssh_terminal_send for those. Requires the user's approval.`,
    inputSchema: {
      serverId: serverIdInput,
      command: z.string().min(1),
      timeoutMs: z.number().int().positive().max(SSH_RUN_MAX_TIMEOUT_MS).optional(),
    },
    requiresPermission: true,
    async run(input) {
      const serverId = resolveServerId(deps, input.serverId);
      await requireApproval(deps, {
        name: "ssh_run",
        title: `Run on ${serverId}`,
        description: input.command,
        input: { serverId, command: input.command },
      });
      const result = await withClient(deps, serverId, (client) =>
        runRemoteCommand(client, {
          command: input.command,
          timeoutMs: input.timeoutMs ?? SSH_RUN_DEFAULT_TIMEOUT_MS,
          maxBytesPerStream: SSH_RUN_MAX_BYTES_PER_STREAM,
        }),
      );
      return jsonResult({ serverId, ...result });
    },
  });
  return [run];
}

function fileTools(deps: SshAgentToolDependencies): SshAgentTool[] {
  const read = defineTool({
    name: "ssh_read_file",
    title: "Read a file on an SSH server",
    description: `Read a text file on the SSH server over SFTP (first ${SSH_READ_FILE_MAX_BYTES / 1024 / 1024} MB). Binary files return their size only. Auto-approved (read-only).`,
    inputSchema: { serverId: serverIdInput, path: z.string().min(1) },
    requiresPermission: false,
    async run(input) {
      const serverId = resolveServerId(deps, input.serverId);
      const file = await withClient(deps, serverId, (client) =>
        readRemoteFile(client, { path: input.path, maxBytes: SSH_READ_FILE_MAX_BYTES }),
      );
      return jsonResult({ serverId, ...file });
    },
  });
  const write = defineTool({
    name: "ssh_write_file",
    title: "Write a file on an SSH server",
    description:
      "Create or replace a file on the SSH server over SFTP with the given UTF-8 content. Requires the user's approval.",
    inputSchema: { serverId: serverIdInput, path: z.string().min(1), content: z.string() },
    requiresPermission: true,
    async run(input) {
      const serverId = resolveServerId(deps, input.serverId);
      await requireApproval(deps, {
        name: "ssh_write_file",
        title: `Write ${input.path} on ${serverId}`,
        description: input.content,
        input: { serverId, path: input.path, bytes: Buffer.byteLength(input.content) },
      });
      await withClient(deps, serverId, (client) =>
        writeRemoteFile(client, { path: input.path, content: input.content }),
      );
      return jsonResult({ serverId, path: input.path, written: true });
    },
  });
  const list = defineTool({
    name: "ssh_list_dir",
    title: "List a directory on an SSH server",
    description:
      "List a directory on the SSH server over SFTP (name, type, size, mtime, mode; directories first). Auto-approved (read-only).",
    inputSchema: { serverId: serverIdInput, path: z.string().min(1) },
    requiresPermission: false,
    async run(input) {
      const serverId = resolveServerId(deps, input.serverId);
      const listing = await withClient(deps, serverId, (client) =>
        listRemoteDir(client, { path: input.path, maxEntries: LIST_DIR_MAX_ENTRIES }),
      );
      return jsonResult({ serverId, ...listing });
    },
  });
  return [read, write, list];
}

function pickTerminal(
  terminals: SshTerminalAccess,
  serverId: string,
  terminalId: string | undefined,
): SshTerminalTab {
  const tabs = terminals.list(serverId);
  if (terminalId) {
    const tab = tabs.find((candidate) => candidate.terminalId === terminalId);
    if (!tab) throw new ToolFailure(`No open SSH tab ${terminalId} on ${serverId}.`);
    return tab;
  }
  if (tabs.length === 1) return tabs[0];
  if (tabs.length === 0) {
    throw new ToolFailure(`No SSH tab is open on ${serverId}. Ask the user to open one.`);
  }
  const ids = tabs.map((tab) => `${tab.terminalId} (${tab.title})`).join(", ");
  throw new ToolFailure(`Several SSH tabs are open on ${serverId}; pass terminalId: ${ids}`);
}

function terminalTools(deps: SshAgentToolDependencies, terminals: SshTerminalAccess) {
  const terminalIdInput = z
    .string()
    .optional()
    .describe("Tab to use; may be omitted when exactly one SSH tab is open on the server.");
  const send = defineTool({
    name: "ssh_terminal_send",
    title: "Type into an SSH terminal tab",
    description:
      "Type text into an open SSH terminal tab; the user sees it typed. Set pressEnter to submit a command. Requires the user's approval.",
    inputSchema: {
      serverId: serverIdInput,
      terminalId: terminalIdInput,
      text: z.string(),
      pressEnter: z.boolean().optional(),
    },
    requiresPermission: true,
    async run(input) {
      const serverId = resolveServerId(deps, input.serverId);
      const tab = pickTerminal(terminals, serverId, input.terminalId);
      await requireApproval(deps, {
        name: "ssh_terminal_send",
        title: `Type into ${tab.title}`,
        description: input.text,
        input: { serverId, terminalId: tab.terminalId, text: input.text },
      });
      const data = input.pressEnter ? `${input.text}\r` : input.text;
      await terminals.send(tab.terminalId, data);
      return jsonResult({ serverId, terminalId: tab.terminalId, sent: true });
    },
  });
  const capture = defineTool({
    name: "ssh_terminal_capture",
    title: "Read an SSH terminal tab",
    description: `Read the last lines of an open SSH terminal tab's screen (default ${CAPTURE_DEFAULT_LINES}). Auto-approved (read-only).`,
    inputSchema: {
      serverId: serverIdInput,
      terminalId: terminalIdInput,
      lines: z.number().int().positive().max(CAPTURE_MAX_LINES).optional(),
    },
    requiresPermission: false,
    async run(input) {
      const serverId = resolveServerId(deps, input.serverId);
      const tab = pickTerminal(terminals, serverId, input.terminalId);
      const screen = await terminals.capture(tab.terminalId, {
        lines: input.lines ?? CAPTURE_DEFAULT_LINES,
      });
      return jsonResult({ serverId, terminalId: tab.terminalId, screen });
    },
  });
  return [send, capture];
}

function forwardTools(deps: SshAgentToolDependencies, forwards: SshForwardAccess) {
  const start = defineTool({
    name: "ssh_forward_start",
    title: "Start a port forward",
    description:
      "Start a port forward through the SSH server: local (-L, listen on this machine, connect to destHost:destPort from the server), remote (-R, listen on the server, connect back to destHost:destPort here) or dynamic (-D, SOCKS5 on this machine). Requires the user's approval.",
    inputSchema: {
      serverId: serverIdInput,
      kind: SshForwardKindSchema,
      bindAddress: z.string().optional().describe("Default 127.0.0.1"),
      bindPort: z.number().int().min(0).max(65535),
      destHost: z.string().optional(),
      destPort: z.number().int().min(1).max(65535).optional(),
    },
    requiresPermission: true,
    async run(input) {
      const serverId = resolveServerId(deps, input.serverId);
      const needsDestination = input.kind !== "dynamic";
      const hasDestination = input.destHost !== undefined && input.destPort !== undefined;
      if (needsDestination && !hasDestination) {
        throw new ToolFailure(`${input.kind} forwarding needs destHost and destPort.`);
      }
      const request: SshForwardStartInput = {
        serverId,
        kind: input.kind,
        bindAddress: input.bindAddress ?? "127.0.0.1",
        bindPort: input.bindPort,
        destHost: input.destHost ?? null,
        destPort: input.destPort ?? null,
      };
      await requireApproval(deps, {
        name: "ssh_forward_start",
        title: `Start ${input.kind} forward on ${serverId}`,
        description: JSON.stringify(request),
        input: { ...request },
      });
      return jsonResult(await forwards.start(request));
    },
  });
  const stop = defineTool({
    name: "ssh_forward_stop",
    title: "Stop a port forward",
    description: "Stop a running port forward by forwardId. Requires the user's approval.",
    inputSchema: { forwardId: z.string().min(1) },
    requiresPermission: true,
    async run(input) {
      await requireApproval(deps, {
        name: "ssh_forward_stop",
        title: `Stop forward ${input.forwardId}`,
        description: input.forwardId,
        input: { forwardId: input.forwardId },
      });
      await forwards.stop(input.forwardId);
      return jsonResult({ forwardId: input.forwardId, stopped: true });
    },
  });
  return [start, stop];
}

function directoryTools(servers: SshServerDirectory) {
  const list = defineTool({
    name: "ssh_list_servers",
    title: "List SSH servers",
    description:
      "List the SSH servers saved in JAgentDesk (serverId, label, address, user, state). Pass a serverId to the ssh_* and docker_* tools. Auto-approved (read-only).",
    inputSchema: {},
    requiresPermission: false,
    async run() {
      return jsonResult({ servers: await servers.list() });
    },
  });
  const open = defineTool({
    name: "ssh_open_terminal",
    title: "Open an SSH terminal tab",
    description: "Connect to a saved SSH server and open a terminal tab the user can see.",
    inputSchema: { serverId: z.string().min(1) },
    requiresPermission: false,
    async run(input) {
      return jsonResult(await servers.openTerminal(input.serverId));
    },
  });
  return [list, open];
}

/** The `ssh_*` agent tools of spec 25.11, bound to one caller. */
export function createSshAgentTools(deps: SshAgentToolDependencies): SshAgentTool[] {
  return [
    ...execTools(deps),
    ...fileTools(deps),
    ...(deps.terminals ? terminalTools(deps, deps.terminals) : []),
    ...(deps.forwards ? forwardTools(deps, deps.forwards) : []),
    ...(deps.servers ? directoryTools(deps.servers) : []),
  ];
}

type RegisterTool = (
  name: string,
  config: JAgentDeskToolConfig,
  handler: (
    input: unknown,
    context: JAgentDeskToolExecutionContext,
  ) => Promise<JAgentDeskToolResult>,
) => void;

/** Adds the tools to a catalog through its `registerTool` (jagentdesk-tools.ts). */
export function registerSshAgentTools(registerTool: RegisterTool, tools: SshAgentTool[]): void {
  for (const tool of tools) {
    registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      tool.handler,
    );
  }
}
