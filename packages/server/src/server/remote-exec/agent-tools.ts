// The `remote_*` agent tools of spec 33.7, bound to one caller. Registered like the ssh_* tools
// (ssh/environment/agent-tools.ts): reads auto-run, remote_run / remote_job_stop raise the
// permission card (04.21). Availability is evaluated at listing time and per call: the tools
// exist only while at least one SSH server has remote tasks enabled.
import { z } from "zod";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type {
  JAgentDeskToolConfig,
  JAgentDeskToolDefinition,
  JAgentDeskToolExecutionContext,
  JAgentDeskToolResult,
} from "../agent/tools/types.js";
import {
  REMOTE_OUTPUT_READ_MAX_BYTES,
  REMOTE_RUN_DEFAULT_TIMEOUT_MS,
  REMOTE_RUN_DEFAULT_WAIT_MS,
  REMOTE_RUN_MAX_TIMEOUT_MS,
  REMOTE_RUN_MAX_WAIT_MS,
  RemoteExecError,
  type RemoteExecService,
} from "./types.js";

/** Same request the catalog's `requestHostToolPermission` takes (the permission card, 04.21). */
export interface RemoteExecPermissionRequest {
  name: string;
  kind: "tool";
  title: string;
  description: string;
  input: Record<string, unknown>;
}

export type RequestToolPermission = (
  agentId: string,
  request: RemoteExecPermissionRequest,
) => Promise<AgentPermissionResponse>;

export interface RemoteExecAgentToolDependencies {
  service: RemoteExecService;
  /** True while at least one SSH server opts into remote tasks (spec 33.7). */
  hasEnabledTarget(): boolean;
  /** The calling agent's cwd, resolved per call; null when the agent has none. */
  callerCwd(): string | null;
  /** The agent using this catalog; permission cards are raised on its behalf. */
  callerAgentId: string | null;
  requestPermission: RequestToolPermission;
}

export interface RemoteExecAgentTool extends JAgentDeskToolDefinition {
  /** True for tools that change state; their handler raises a permission card first. */
  requiresPermission: boolean;
}

class ToolFailure extends Error {}

function jsonResult(value: unknown): JAgentDeskToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): JAgentDeskToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toToolMessage(error: unknown): string {
  if (error instanceof RemoteExecError) {
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Clamps an optional duration to the contract limits (spec 33.7). */
function clampMs(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  return Math.min(Math.max(Math.trunc(value), 0), max);
}

interface PermissionAsk {
  name: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
}

async function requireApproval(deps: RemoteExecAgentToolDependencies, ask: PermissionAsk) {
  if (!deps.callerAgentId) {
    throw new ToolFailure(`${ask.name} is only available to agent-scoped tool sessions.`);
  }
  const decision = await deps.requestPermission(deps.callerAgentId, { kind: "tool", ...ask });
  if (decision.behavior !== "allow") throw new ToolFailure("The user declined");
}

interface ToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  requiresPermission: boolean;
  run: (input: z.infer<z.ZodObject<Shape>>) => Promise<JAgentDeskToolResult>;
}

function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): RemoteExecAgentTool {
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
        return errorResult(toToolMessage(error));
      }
    },
  };
}

function requireEnabledTarget(deps: RemoteExecAgentToolDependencies): void {
  if (!deps.hasEnabledTarget()) {
    throw new ToolFailure("No SSH server has remote tasks enabled.");
  }
}

function requireCwd(deps: RemoteExecAgentToolDependencies): string {
  const cwd = deps.callerCwd();
  if (!cwd) {
    throw new ToolFailure("This tool needs a workspace: the agent has no working directory.");
  }
  return cwd;
}

/** serverId is optional only when exactly one target is enabled (spec 33.7). */
async function resolveTarget(
  deps: RemoteExecAgentToolDependencies,
  requested: string | undefined,
): Promise<{ serverId: string; label: string }> {
  const targets = await deps.service.listTargets();
  if (requested !== undefined) {
    const target = targets.find((candidate) => candidate.serverId === requested);
    if (!target) {
      const names =
        targets.map((t) => `${t.serverId} (${t.label})`).join(", ") ||
        "none have remote tasks enabled";
      throw new ToolFailure(`No remote task target ${requested}. Enabled targets: ${names}`);
    }
    return { serverId: target.serverId, label: target.label };
  }
  if (targets.length === 0) {
    throw new ToolFailure("No SSH server has remote tasks enabled.");
  }
  if (targets.length > 1) {
    const names = targets.map((t) => `${t.serverId} (${t.label})`).join(", ");
    throw new ToolFailure(`Several remote task targets are enabled; pass serverId: ${names}`);
  }
  return { serverId: targets[0].serverId, label: targets[0].label };
}

const remoteRunDescription =
  "Run a shell command on another machine for project work — build, test, scripts, long jobs — on a " +
  "copy of the current workspace (git or not, including uncommitted changes and new files): it " +
  "syncs the code to the SSH target and runs the command there. In a folder containing many " +
  "repositories, pass source (a path, or an array of 1-8 paths, relative to the workspace) to send " +
  "only those directories; commands that need no code (system checks, installs) take sendCode: " +
  "false to run in an empty directory. Secrets like .env files are not sent. Results from a " +
  "Linux/WSL target do not prove macOS/iOS behaviour. serverId may be omitted when exactly one " +
  "target is enabled. timeoutMs defaults to 7200000 (max 86400000); waitMs defaults to 120000 (max " +
  "1800000). Requires the user's approval. Returns the job plus the last 64 KiB of output; when " +
  "status is 'running', keep waiting with remote_job_wait.";

const jobTools = (deps: RemoteExecAgentToolDependencies): RemoteExecAgentTool[] => [
  defineTool({
    name: "remote_targets",
    title: "List remote task targets",
    description:
      "List the SSH servers that have remote tasks enabled (serverId, label, address, via, connection state, detected environment). Pass a serverId to remote_run. Auto-approved (read-only).",
    inputSchema: {},
    requiresPermission: false,
    async run() {
      requireEnabledTarget(deps);
      return jsonResult({ targets: await deps.service.listTargets() });
    },
  }),
  defineTool({
    name: "remote_run",
    title: "Run a command on a remote target",
    description: remoteRunDescription,
    inputSchema: {
      serverId: z
        .string()
        .optional()
        .describe("Target server id (srv_…). Optional when exactly one target is enabled."),
      command: z.string().min(1),
      source: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(
          "Directory (or array of 1-8 directories) inside the workspace to send instead of the " +
            "whole workspace; each must be a directory inside the workspace.",
        ),
      sendCode: z
        .boolean()
        .optional()
        .describe(
          "Set false to run without sending any code (empty directory on the target). " +
            "Cannot be combined with source.",
        ),
      timeoutMs: z.number().int().positive().optional(),
      waitMs: z.number().int().nonnegative().optional(),
    },
    requiresPermission: true,
    async run(input) {
      requireEnabledTarget(deps);
      const workspacePath = requireCwd(deps);
      const { serverId, label } = await resolveTarget(deps, input.serverId);
      // Source errors (33.4) throw here, before the permission card, and no job is created.
      // Snapshot stats for the card first (spec 33.7); the run's snapshot is created after approval.
      const preview = await deps.service.previewSnapshot({
        workspacePath,
        ...(input.source !== undefined ? { source: input.source } : {}),
        // sendCode defaults to true (spec 33.7); only an explicit false runs without code.
        ...(input.sendCode === false ? { noCode: true } : {}),
      });
      // Card input (spec 33.7): snapshot stats plus the source list, or code:"none" for noCode runs.
      const cardInput: Record<string, unknown> = {
        server: label,
        command: input.command,
        cwd: workspacePath,
      };
      if (preview.noCode === true) {
        cardInput.code = "none";
      } else {
        cardInput.files = preview.filesTotal;
        cardInput.bytes = preview.bytesTotal;
        cardInput.excludedSecrets = preview.excludedSecrets.length;
        if (preview.sources) cardInput.sources = preview.sources;
      }
      await requireApproval(deps, {
        name: "remote_run",
        title: `Run on ${label}`,
        description: input.command,
        input: cardInput,
      });
      const job = await deps.service.startJob({
        serverId,
        workspacePath,
        command: input.command,
        timeoutMs: clampMs(
          input.timeoutMs,
          REMOTE_RUN_DEFAULT_TIMEOUT_MS,
          REMOTE_RUN_MAX_TIMEOUT_MS,
        ),
        agentId: deps.callerAgentId,
        ...(input.source !== undefined ? { source: input.source } : {}),
        ...(input.sendCode === false ? { noCode: true } : {}),
      });
      return jsonResult(
        await deps.service.waitForJob(
          job.id,
          clampMs(input.waitMs, REMOTE_RUN_DEFAULT_WAIT_MS, REMOTE_RUN_MAX_WAIT_MS),
        ),
      );
    },
  }),
  defineTool({
    name: "remote_job_wait",
    title: "Wait for a remote job",
    description:
      "Wait for a remote job to finish or for waitMs to elapse (default 120000, max 1800000). Use this when remote_run returned status 'running'. Returns the job plus the last 64 KiB of output. Auto-approved (read-only).",
    inputSchema: {
      jobId: z.string().min(1),
      waitMs: z.number().int().nonnegative().optional(),
    },
    requiresPermission: false,
    async run(input) {
      requireEnabledTarget(deps);
      return jsonResult(
        await deps.service.waitForJob(
          input.jobId,
          clampMs(input.waitMs, REMOTE_RUN_DEFAULT_WAIT_MS, REMOTE_RUN_MAX_WAIT_MS),
        ),
      );
    },
  }),
  defineTool({
    name: "remote_job_output",
    title: "Read remote job output",
    description: `Read a remote job's combined stdout+stderr by byte offset (limit defaults to and max ${REMOTE_OUTPUT_READ_MAX_BYTES}). Auto-approved (read-only).`,
    inputSchema: {
      jobId: z.string().min(1),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(REMOTE_OUTPUT_READ_MAX_BYTES).optional(),
    },
    requiresPermission: false,
    async run(input) {
      requireEnabledTarget(deps);
      return jsonResult(
        await deps.service.readOutput(
          input.jobId,
          input.offset ?? 0,
          clampMs(input.limit, REMOTE_OUTPUT_READ_MAX_BYTES, REMOTE_OUTPUT_READ_MAX_BYTES),
        ),
      );
    },
  }),
  defineTool({
    name: "remote_job_stop",
    title: "Stop a remote job",
    description:
      "Stop a running remote job on the target machine (SIGTERM, then SIGKILL after 10 s). Requires the user's approval.",
    inputSchema: { jobId: z.string().min(1) },
    requiresPermission: true,
    async run(input) {
      requireEnabledTarget(deps);
      await requireApproval(deps, {
        name: "remote_job_stop",
        title: `Stop remote job ${input.jobId}`,
        description: input.jobId,
        input: { jobId: input.jobId },
      });
      return jsonResult(await deps.service.stopJob(input.jobId));
    },
  }),
  defineTool({
    name: "remote_jobs",
    title: "List remote jobs",
    description:
      "List the 20 most recent remote jobs for the current workspace (newest first, with status, exit code and sync summary). Auto-approved (read-only).",
    inputSchema: {},
    requiresPermission: false,
    async run() {
      requireEnabledTarget(deps);
      const workspacePath = requireCwd(deps);
      return jsonResult({ jobs: deps.service.listJobs({ workspacePath, limit: 20 }) });
    },
  }),
];

/**
 * The spec 33.7 tool set for one caller. Empty when no SSH server has remote tasks enabled —
 * an advertised tool must work, so the tools are not offered at all (evaluated per listing;
 * handlers re-check per call).
 */
export function createRemoteExecAgentTools(
  deps: RemoteExecAgentToolDependencies,
): RemoteExecAgentTool[] {
  if (!deps.hasEnabledTarget()) return [];
  return jobTools(deps);
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
export function registerRemoteExecAgentTools(
  registerTool: RegisterTool,
  tools: RemoteExecAgentTool[],
): void {
  for (const tool of tools) {
    registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      tool.handler,
    );
  }
}
