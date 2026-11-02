import { z } from "zod";
import type { JAgentDeskToolResult } from "../../agent/tools/types.js";
import { execCommand } from "../../../utils/spawn.js";
import type { RequestToolPermission, SshAgentTool } from "../environment/agent-tools.js";
import { remoteDockerArgs } from "./cockpit.js";
import type { RemoteDockerHosts } from "./hosts.js";

// The `docker_*` agent tools (agent/tools/jagentdesk-tools.ts registerDockerTools) with an extra
// `serverId` (spec 25.11). Without a server they behave exactly like today's host tools: same
// argv, same output, no extra approval. With a server they run the daemon's `docker` against the
// server's forwarded socket; changes then raise the permission card first, reads do not.

export interface RemoteDockerToolDependencies {
  hosts: RemoteDockerHosts;
  callerAgentId: string | null;
  /** The server a server-chat agent is bound to; its docker_* calls default to it. */
  defaultServerId: string | null;
  requestPermission: RequestToolPermission;
}

const serverIdInput = z
  .string()
  .optional()
  .describe(
    "SSH server id (srv_…) whose Docker to use. Defaults to the chat's server; omitted outside a server chat = this machine.",
  );

class Denied extends Error {}

async function runDocker(
  dockerHost: string | null,
  args: string[],
  timeoutMs: number,
): Promise<JAgentDeskToolResult> {
  const argv = dockerHost === null ? args : remoteDockerArgs(dockerHost, args);
  try {
    const result = await execCommand("docker", argv, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").trim();
    return { content: [{ type: "text", text: out || "(no output)" }] };
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message?: string };
    const text = (e.stderr || e.stdout || e.message || String(error)).trim();
    return { content: [{ type: "text", text: `docker failed: ${text}` }], isError: true };
  }
}

interface DockerToolSpec<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  /** Changes state on the server: approval card before running remotely. */
  changesState: boolean;
  timeoutMs: number;
  args: (input: z.infer<z.ZodObject<Shape>>) => string[];
}

function defineDockerTool<Shape extends z.ZodRawShape>(
  deps: RemoteDockerToolDependencies,
  spec: DockerToolSpec<Shape>,
): SshAgentTool {
  const inputSchema = { ...spec.inputSchema, serverId: serverIdInput };
  const toolSchema = z.object(spec.inputSchema);
  const targetSchema = z.object({ serverId: serverIdInput });
  async function approve(serverId: string, args: string[]): Promise<void> {
    if (!deps.callerAgentId) {
      throw new Denied(`${spec.name} on a server is only available to agent-scoped tool sessions.`);
    }
    const decision = await deps.requestPermission(deps.callerAgentId, {
      name: spec.name,
      kind: "tool",
      title: `${spec.title} on ${serverId}`,
      description: `docker ${args.join(" ")}`,
      input: { serverId, args },
    });
    if (decision.behavior !== "allow") throw new Denied("Denied by user.");
  }
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema,
    requiresPermission: spec.changesState,
    async handler(raw: unknown) {
      const args = spec.args(toolSchema.parse(raw));
      const serverId = targetSchema.parse(raw).serverId ?? deps.defaultServerId;
      if (serverId === null) return runDocker(null, args, spec.timeoutMs);
      try {
        if (spec.changesState) await approve(serverId, args);
        return await deps.hosts.use(serverId, (attachment) =>
          runDocker(attachment.dockerHost, args, spec.timeoutMs),
        );
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text }], isError: true };
      }
    },
  };
}

function dockerRunArgs(input: {
  image: string;
  name?: string;
  detach?: boolean;
  ports?: string[];
  env?: string[];
  volumes?: string[];
  command?: string[];
}): string[] {
  const args = ["run"];
  if (input.detach !== false) args.push("-d");
  if (input.name) args.push("--name", input.name);
  for (const port of input.ports ?? []) args.push("-p", port);
  for (const entry of input.env ?? []) args.push("-e", entry);
  for (const volume of input.volumes ?? []) args.push("-v", volume);
  args.push(input.image);
  for (const part of input.command ?? []) args.push(part);
  return args;
}

function readTools(deps: RemoteDockerToolDependencies): SshAgentTool[] {
  return [
    defineDockerTool(deps, {
      name: "docker_ps",
      title: "Docker ps",
      description:
        "List Docker containers (running, or all with allContainers=true), on this machine or on an SSH server (serverId). Auto-approved (read-only).",
      inputSchema: { allContainers: z.boolean().optional() },
      changesState: false,
      timeoutMs: 120_000,
      args: (input) => [
        "ps",
        ...(input.allContainers ? ["--all"] : []),
        "--format",
        "{{.ID}}  {{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}",
      ],
    }),
    defineDockerTool(deps, {
      name: "docker_images",
      title: "Docker images",
      description: "List Docker images, here or on an SSH server. Auto-approved (read-only).",
      inputSchema: {},
      changesState: false,
      timeoutMs: 120_000,
      args: () => ["images", "--format", "{{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}"],
    }),
    defineDockerTool(deps, {
      name: "docker_logs",
      title: "Docker logs",
      description:
        "Read a container's logs (last `tail` lines, default 200), here or on an SSH server. Auto-approved (read-only).",
      inputSchema: { container: z.string().min(1), tail: z.number().int().positive().optional() },
      changesState: false,
      timeoutMs: 120_000,
      args: (input) => ["logs", "--tail", String(input.tail ?? 200), input.container],
    }),
    defineDockerTool(deps, {
      name: "docker_inspect",
      title: "Docker inspect",
      description:
        "Inspect a container or image (JSON), here or on an SSH server. Auto-approved (read-only).",
      inputSchema: { target: z.string().min(1) },
      changesState: false,
      timeoutMs: 120_000,
      args: (input) => ["inspect", input.target],
    }),
  ];
}

function containerAction(
  deps: RemoteDockerToolDependencies,
  name: string,
  title: string,
  verb: "start" | "stop" | "restart",
): SshAgentTool {
  return defineDockerTool(deps, {
    name,
    title,
    description: `${title} a container, here or on an SSH server (serverId; needs the user's approval there).`,
    inputSchema: { container: z.string().min(1) },
    changesState: true,
    timeoutMs: 120_000,
    args: (input) => [verb, input.container],
  });
}

function writeTools(deps: RemoteDockerToolDependencies): SshAgentTool[] {
  return [
    defineDockerTool(deps, {
      name: "docker_run",
      title: "Docker run",
      description:
        "Create + run a container from an image, here or on an SSH server (serverId; needs approval there). Detached by default. ports are 'host:container', env 'KEY=value', volumes 'host:container' (host = the machine running Docker). Returns the container id.",
      inputSchema: {
        image: z.string().min(1),
        name: z.string().optional(),
        detach: z.boolean().optional(),
        ports: z.array(z.string()).optional(),
        env: z.array(z.string()).optional(),
        volumes: z.array(z.string()).optional(),
        command: z.array(z.string()).optional(),
      },
      changesState: true,
      timeoutMs: 180_000,
      args: dockerRunArgs,
    }),
    defineDockerTool(deps, {
      name: "docker_exec",
      title: "Docker exec",
      description:
        "Run a command inside a running container, here or on an SSH server (needs approval there). `command` is argv (e.g. ['psql','-c','SELECT 1']).",
      inputSchema: { container: z.string().min(1), command: z.array(z.string()).min(1) },
      changesState: true,
      timeoutMs: 120_000,
      args: (input) => ["exec", input.container, ...input.command],
    }),
    defineDockerTool(deps, {
      name: "docker_build",
      title: "Docker build",
      description:
        "Build an image from a build context directory (absolute path on this machine; with serverId the context is sent to the server's Docker) and tag it. Optional dockerfile path (relative to context).",
      inputSchema: {
        contextPath: z.string().min(1),
        tag: z.string().min(1),
        dockerfile: z.string().optional(),
      },
      changesState: true,
      timeoutMs: 600_000,
      args: (input) => [
        "build",
        "-t",
        input.tag,
        ...(input.dockerfile ? ["-f", input.dockerfile] : []),
        input.contextPath,
      ],
    }),
    containerAction(deps, "docker_start", "Docker start", "start"),
    containerAction(deps, "docker_stop", "Docker stop", "stop"),
    containerAction(deps, "docker_restart", "Docker restart", "restart"),
    defineDockerTool(deps, {
      name: "docker_rm",
      title: "Docker rm",
      description:
        "Remove a container (force=true to kill+remove a running one), here or on an SSH server (needs approval there).",
      inputSchema: { container: z.string().min(1), force: z.boolean().optional() },
      changesState: true,
      timeoutMs: 120_000,
      args: (input) => ["rm", ...(input.force ? ["-f"] : []), input.container],
    }),
  ];
}

/** Replaces registerDockerTools' set: same tools plus docker_start/docker_restart and serverId. */
export function createRemoteDockerTools(deps: RemoteDockerToolDependencies): SshAgentTool[] {
  return [...readTools(deps), ...writeTools(deps)];
}
