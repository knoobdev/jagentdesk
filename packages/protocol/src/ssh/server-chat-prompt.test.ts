import { describe, expect, it } from "vitest";
import type { ServerEnvironment } from "./environment-schemas.js";
import { buildServerChatSystemPrompt } from "./server-chat-prompt.js";

const ENVIRONMENT: ServerEnvironment = {
  serverId: "srv_a1b2c3",
  detectedAtMs: Date.UTC(2026, 10, 3, 9, 30),
  hostname: "<hostname>",
  os: {
    kernelName: "Linux",
    kernelRelease: "6.8.0-45-generic",
    arch: "x86_64",
    distroId: "ubuntu",
    distroName: "Ubuntu",
    distroVersion: "24.04",
    prettyName: "Ubuntu 24.04.1 LTS",
  },
  cpuCores: 8,
  cpuModel: null,
  memoryTotalBytes: 16 * 1024 ** 3,
  memoryAvailableBytes: 12 * 1024 ** 3,
  rootDisk: {
    mount: "/",
    totalBytes: 100 * 1024 ** 3,
    usedBytes: 20 * 1024 ** 3,
    availableBytes: 80 * 1024 ** 3,
  },
  uptimeSeconds: 86400,
  shell: "/bin/bash",
  docker: {
    version: "Docker version 27.3.1, build ce12230",
    socketPath: "/var/run/docker.sock",
    socketAccessible: true,
  },
  podman: null,
  systemctl: { version: "systemd 255" },
  kubectl: null,
  psql: { version: "psql (PostgreSQL) 16.4" },
  mysql: null,
  redisCli: null,
  nginx: null,
  packageManagers: ["apt"],
  systemd: {
    runningServices: ["docker.service", "ssh.service"],
    failedServices: [],
    runningTruncated: false,
  },
};

describe("buildServerChatSystemPrompt", () => {
  it("states the server, its environment, open tabs, forwards and tools", () => {
    const prompt = buildServerChatSystemPrompt({
      server: {
        id: "srv_a1b2c3",
        label: "<label>",
        address: "<address>",
        port: 22,
        username: "deploy",
      },
      environment: ENVIRONMENT,
      terminals: [{ terminalId: "term_1", title: "deploy@<address>" }],
      forwards: [{ forwardId: "fwd_1", description: "local 127.0.0.1:15432 -> db:5432" }],
    });

    expect(prompt).toBe(
      [
        'You are operating the SSH server "<label>" (serverId "srv_a1b2c3", deploy@<address>:22).',
        "Commands run on that server, not on the machine running JAgentDesk.",
        "",
        "Environment (detected 2026-11-03T09:30:00.000Z):",
        "OS: Ubuntu 24.04.1 LTS (Linux 6.8.0-45-generic, x86_64)",
        "CPU: 8 cores",
        "Memory: 16.0 GiB, 12.0 GiB available",
        "Disk /: 20.0 GiB used of 100.0 GiB",
        "Login shell: /bin/bash",
        "Installed: docker (Docker version 27.3.1, build ce12230; socket /var/run/docker.sock), systemctl (systemd 255), psql (psql (PostgreSQL) 16.4)",
        "Package managers: apt",
        "Running services: docker.service, ssh.service",
        "",
        "Open SSH terminal tabs (the user sees what you type there):",
        "  - term_1: deploy@<address>",
        "Active port forwards:",
        "  - fwd_1: local 127.0.0.1:15432 -> db:5432",
        "",
        "Tools (MCP server 'jagentdesk'); every call defaults to serverId \"srv_a1b2c3\":",
        "  - mcp__jagentdesk__ssh_run — run a command over an exec channel (needs the user's approval)",
        "  - mcp__jagentdesk__ssh_read_file / mcp__jagentdesk__ssh_list_dir — read files and directories",
        "  - mcp__jagentdesk__ssh_write_file — write a file (needs approval)",
        "  - mcp__jagentdesk__ssh_terminal_capture / mcp__jagentdesk__ssh_terminal_send — read or type into an open SSH tab (typing needs approval)",
        "  - mcp__jagentdesk__ssh_forward_start / mcp__jagentdesk__ssh_forward_stop — port forwarding (needs approval)",
        "  - mcp__jagentdesk__docker_* with serverId — Docker on this server (listing and logs need no approval)",
        "If a tool is not loaded yet, load it with the ToolSearch tool using `select:<exact name>`.",
        "Wait for the user's question before taking any action.",
      ].join("\n"),
    );
  });

  it("says when nothing was detected and nothing is open", () => {
    const prompt = buildServerChatSystemPrompt({
      server: { id: "srv_x", label: "<label>", address: "<address>", port: 2222, username: null },
      environment: null,
      terminals: [],
      forwards: [],
    });

    expect(prompt).toContain('(serverId "srv_x", <address>:2222)');
    expect(prompt).toContain(
      "The server environment has not been detected yet; inspect it with ssh_run if needed.",
    );
    expect(prompt).toContain("Open SSH terminal tabs: none.");
    expect(prompt).toContain("Active port forwards: none.");
  });
});
