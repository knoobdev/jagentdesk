import type { ServerEnvironment, ServerTool } from "./environment-schemas.js";

// Agent label that binds a chat agent to one SSH server (spec 25.11): the daemon resolves the
// default `serverId` of every `ssh_*` / `docker_*` tool call from it, and the app files the chat
// under that server's screen, like `jagentdesk.cluster.id` does for cluster chats.
export const SSH_SERVER_AGENT_LABEL = "jagentdesk.ssh.server.id";

// What the agent may know about the server. Deliberately no secret-bearing fields: identity ids,
// passwords, keys and proxy credentials never reach a prompt.
export interface ServerChatServer {
  id: string;
  label: string;
  address: string;
  port: number;
  username: string | null;
}

export interface ServerChatTerminal {
  terminalId: string;
  title: string;
}

export interface ServerChatForward {
  forwardId: string;
  description: string; // e.g. "local 127.0.0.1:15432 -> db:5432"
}

export interface ServerChatContext {
  server: ServerChatServer;
  environment: ServerEnvironment | null;
  terminals: ServerChatTerminal[];
  forwards: ServerChatForward[];
}

const TOOL_PREFIX = "mcp__jagentdesk__";

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function osLine(environment: ServerEnvironment): string {
  const { os } = environment;
  const distro = os.prettyName ?? os.distroName ?? os.kernelName;
  return `OS: ${distro} (${os.kernelName} ${os.kernelRelease}, ${os.arch})`;
}

function resourceLines(environment: ServerEnvironment): string[] {
  const lines: string[] = [];
  if (environment.cpuCores !== null) {
    const model = environment.cpuModel ? ` (${environment.cpuModel})` : "";
    lines.push(`CPU: ${environment.cpuCores} cores${model}`);
  }
  if (environment.memoryTotalBytes !== null) {
    const available =
      environment.memoryAvailableBytes === null
        ? ""
        : `, ${formatBytes(environment.memoryAvailableBytes)} available`;
    lines.push(`Memory: ${formatBytes(environment.memoryTotalBytes)}${available}`);
  }
  if (environment.rootDisk) {
    const disk = environment.rootDisk;
    lines.push(
      `Disk ${disk.mount}: ${formatBytes(disk.usedBytes)} used of ${formatBytes(disk.totalBytes)}`,
    );
  }
  if (environment.shell) lines.push(`Login shell: ${environment.shell}`);
  return lines;
}

function toolLine(name: string, tool: ServerTool | null): string | null {
  if (tool === null) return null;
  return tool.version ? `${name} (${tool.version})` : name;
}

function dockerLine(environment: ServerEnvironment): string | null {
  const docker = environment.docker;
  if (docker === null) return null;
  const version = docker.version ?? "engine socket only";
  const socket = docker.socketPath ?? "not found";
  const access = docker.socketAccessible ? "" : ", not accessible to this user";
  return `docker (${version}; socket ${socket}${access})`;
}

function installedLines(environment: ServerEnvironment): string[] {
  const entries = [
    dockerLine(environment),
    toolLine("podman", environment.podman),
    toolLine("systemctl", environment.systemctl),
    toolLine("kubectl", environment.kubectl),
    toolLine("psql", environment.psql),
    toolLine("mysql", environment.mysql),
    toolLine("redis-cli", environment.redisCli),
    toolLine("nginx", environment.nginx),
  ].filter((entry): entry is string => entry !== null);
  const lines = [
    `Installed: ${entries.length > 0 ? entries.join(", ") : "none of the probed tools"}`,
  ];
  if (environment.packageManagers.length > 0) {
    lines.push(`Package managers: ${environment.packageManagers.join(", ")}`);
  }
  if (environment.systemd) {
    const running = environment.systemd.runningServices.join(", ") || "none";
    const more = environment.systemd.runningTruncated ? " (list truncated)" : "";
    lines.push(`Running services: ${running}${more}`);
    if (environment.systemd.failedServices.length > 0) {
      lines.push(`Failed services: ${environment.systemd.failedServices.join(", ")}`);
    }
  }
  return lines;
}

function environmentLines(environment: ServerEnvironment | null): string[] {
  if (environment === null) {
    return ["The server environment has not been detected yet; inspect it with ssh_run if needed."];
  }
  const detectedAt = new Date(environment.detectedAtMs).toISOString();
  return [
    `Environment (detected ${detectedAt}):`,
    osLine(environment),
    ...resourceLines(environment),
    ...installedLines(environment),
  ];
}

function sessionLines(context: ServerChatContext): string[] {
  const terminals =
    context.terminals.length === 0
      ? ["Open SSH terminal tabs: none."]
      : [
          "Open SSH terminal tabs (the user sees what you type there):",
          ...context.terminals.map((tab) => `  - ${tab.terminalId}: ${tab.title}`),
        ];
  const forwards =
    context.forwards.length === 0
      ? ["Active port forwards: none."]
      : [
          "Active port forwards:",
          ...context.forwards.map((forward) => `  - ${forward.forwardId}: ${forward.description}`),
        ];
  return [...terminals, ...forwards];
}

function toolLines(serverId: string): string[] {
  return [
    `Tools (MCP server 'jagentdesk'); every call defaults to serverId "${serverId}":`,
    `  - ${TOOL_PREFIX}ssh_run — run a command over an exec channel (needs the user's approval)`,
    `  - ${TOOL_PREFIX}ssh_read_file / ${TOOL_PREFIX}ssh_list_dir — read files and directories`,
    `  - ${TOOL_PREFIX}ssh_write_file — write a file (needs approval)`,
    `  - ${TOOL_PREFIX}ssh_terminal_capture / ${TOOL_PREFIX}ssh_terminal_send — read or type into an open SSH tab (typing needs approval)`,
    `  - ${TOOL_PREFIX}ssh_forward_start / ${TOOL_PREFIX}ssh_forward_stop — port forwarding (needs approval)`,
    `  - ${TOOL_PREFIX}docker_* with serverId — Docker on this server (listing and logs need no approval)`,
    "If a tool is not loaded yet, load it with the ToolSearch tool using `select:<exact name>`.",
  ];
}

/**
 * The hidden system prompt of a server's chat agent (spec 25.11): which server it operates, what
 * was detected there, what is open right now, and which tools reach it.
 */
export function buildServerChatSystemPrompt(context: ServerChatContext): string {
  const { server } = context;
  const user = server.username ? `${server.username}@` : "";
  return [
    `You are operating the SSH server "${server.label}" (serverId "${server.id}", ${user}${server.address}:${server.port}).`,
    "Commands run on that server, not on the machine running JAgentDesk.",
    "",
    ...environmentLines(context.environment),
    "",
    ...sessionLines(context),
    "",
    ...toolLines(server.id),
    "Wait for the user's question before taking any action.",
  ].join("\n");
}
