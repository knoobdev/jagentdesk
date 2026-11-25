import { z } from "zod";
import {
  execCommand,
  type JAgentDeskToolResult,
  type RegisterBuiltinTool,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
// Docker container management for agents (agents spin up + run services
// themselves). Backed by the host `docker` CLI via execCommand — read tools return output,
// write tools (run/exec/build/stop/rm) go through the normal tool-approval flow.
async function runDocker(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<JAgentDeskToolResult> {
  try {
    const result = await execCommand("docker", args, {
      cwd: opts?.cwd,
      timeout: opts?.timeoutMs ?? 120_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n").trim();
    return { content: [{ type: "text", text: out || "(no output)" }] };
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const text = (e.stderr || e.stdout || e.message || String(err)).trim();
    return { content: [{ type: "text", text: `docker failed: ${text}` }], isError: true };
  }
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
  for (const p of input.ports ?? []) args.push("-p", p);
  for (const e of input.env ?? []) args.push("-e", e);
  for (const v of input.volumes ?? []) args.push("-v", v);
  args.push(input.image);
  for (const c of input.command ?? []) args.push(c);
  return args;
}

export function registerDockerTools(params: { registerTool: RegisterBuiltinTool }): void {
  const { registerTool } = params;

  registerTool(
    "docker_ps",
    {
      title: "Docker ps",
      description:
        "List Docker containers (running, or all with allContainers=true). Auto-approved (read-only).",
      inputSchema: { allContainers: z.boolean().optional() },
    },
    async (input: { allContainers?: boolean }) =>
      runDocker([
        "ps",
        ...(input.allContainers ? ["--all"] : []),
        "--format",
        "{{.ID}}  {{.Names}}  {{.Image}}  {{.Status}}  {{.Ports}}",
      ]),
  );

  registerTool(
    "docker_images",
    {
      title: "Docker images",
      description: "List local Docker images. Auto-approved (read-only).",
      inputSchema: {},
    },
    async () => runDocker(["images", "--format", "{{.Repository}}:{{.Tag}}  {{.ID}}  {{.Size}}"]),
  );

  registerTool(
    "docker_logs",
    {
      title: "Docker logs",
      description:
        "Read a container's logs (last `tail` lines, default 200). Auto-approved (read-only).",
      inputSchema: { container: z.string().min(1), tail: z.number().int().positive().optional() },
    },
    async (input: { container: string; tail?: number }) =>
      runDocker(["logs", "--tail", String(input.tail ?? 200), input.container]),
  );

  registerTool(
    "docker_inspect",
    {
      title: "Docker inspect",
      description: "Inspect a container or image (JSON). Auto-approved (read-only).",
      inputSchema: { target: z.string().min(1) },
    },
    async (input: { target: string }) => runDocker(["inspect", input.target]),
  );

  registerTool(
    "docker_run",
    {
      title: "Docker run",
      description:
        "Create + run a container from an image. Detached by default. ports are 'host:container' (e.g. '5432:5432'), env are 'KEY=value', volumes are 'host:container'. Returns the container id. Use this to spin up the services your work needs (a DB, a cache, your app) so the human can see them.",
      inputSchema: {
        image: z.string().min(1),
        name: z.string().optional(),
        detach: z.boolean().optional(),
        ports: z.array(z.string()).optional(),
        env: z.array(z.string()).optional(),
        volumes: z.array(z.string()).optional(),
        command: z.array(z.string()).optional(),
      },
    },
    async (input: {
      image: string;
      name?: string;
      detach?: boolean;
      ports?: string[];
      env?: string[];
      volumes?: string[];
      command?: string[];
    }) => runDocker(dockerRunArgs(input), { timeoutMs: 180_000 }),
  );

  registerTool(
    "docker_exec",
    {
      title: "Docker exec",
      description:
        "Run a command inside a running container. `command` is argv (e.g. ['psql','-c','SELECT 1']).",
      inputSchema: { container: z.string().min(1), command: z.array(z.string()).min(1) },
    },
    async (input: { container: string; command: string[] }) =>
      runDocker(["exec", input.container, ...input.command]),
  );

  registerTool(
    "docker_build",
    {
      title: "Docker build",
      description:
        "Build an image from a build context directory (absolute path) and tag it. Optional dockerfile path (relative to context).",
      inputSchema: {
        contextPath: z.string().min(1),
        tag: z.string().min(1),
        dockerfile: z.string().optional(),
      },
    },
    async (input: { contextPath: string; tag: string; dockerfile?: string }) =>
      runDocker(
        [
          "build",
          "-t",
          input.tag,
          ...(input.dockerfile ? ["-f", input.dockerfile] : []),
          input.contextPath,
        ],
        { timeoutMs: 600_000 },
      ),
  );

  registerTool(
    "docker_stop",
    {
      title: "Docker stop",
      description: "Stop a running container.",
      inputSchema: { container: z.string().min(1) },
    },
    async (input: { container: string }) => runDocker(["stop", input.container]),
  );

  registerTool(
    "docker_rm",
    {
      title: "Docker rm",
      description: "Remove a container (force=true to kill+remove a running one).",
      inputSchema: { container: z.string().min(1), force: z.boolean().optional() },
    },
    async (input: { container: string; force?: boolean }) =>
      runDocker(["rm", ...(input.force ? ["-f"] : []), input.container]),
  );
}
