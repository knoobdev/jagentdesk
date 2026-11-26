import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestJAgentDeskDaemon } from "../test-utils/jagentdesk-daemon.js";

test("the configuration example saves Codex options and injects launch-only MCP servers while preserving other configuration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jagentdesk-config-example-"));
  const launches: AgentSessionConfig[] = [];
  const daemon = await createTestJAgentDeskDaemon({
    daemonVersion: "0.14.0-beta.1",
    agentClients: {
      codex: createTestAgentClient("codex", {
        supportsMcpServers: true,
        beforeCreateSession: async (config) => {
          launches.push(config);
        },
      }),
    },
    mcpEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.1",
  });
  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(
      fileURLToPath(new URL("../../../../../plugin-examples/agent-configuration", import.meta.url)),
    );
    const agent = await client.createAgent({
      provider: "codex",
      cwd: directory,
      systemPrompt: "Keep the user's instructions.",
      providerOptions: {
        sandbox_mode: "read-only",
        approval_policy: "never",
        web_search: "disabled",
      },
      mcpServers: { existing: { type: "http", url: "https://existing.example.com/mcp" } },
    });
    expect(daemon.daemon.agentManager.getAgent(agent.id)?.config).toMatchObject({
      provider: "codex",
      cwd: directory,
      systemPrompt: "Keep the user's instructions.",
      providerOptions: {
        sandbox_mode: "workspace-write",
        approval_policy: "on-request",
        web_search: "disabled",
      },
      mcpServers: {
        existing: { type: "http", url: "https://existing.example.com/mcp" },
      },
    });
    expect(daemon.daemon.agentManager.getAgent(agent.id)!.config.mcpServers).toEqual({
      existing: { type: "http", url: "https://existing.example.com/mcp" },
    });
    expect(launches[0].mcpServers).toEqual({
      existing: { type: "http", url: "https://existing.example.com/mcp" },
      company: { type: "http", url: "https://tools.example.com/mcp" },
    });
    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

test("a create hook reads launch-wrap support for a plugin provider that never connected", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jagentdesk-launch-wrap-snapshot-"));
  const daemon = await createTestJAgentDeskDaemon({
    daemonVersion: "0.14.0-beta.2",
    agentClients: { codex: createTestAgentClient("codex") },
    mcpEnabled: false,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.14.0-beta.2",
  });
  try {
    await writeFile(
      path.join(directory, "jagentdesk-plugin.json"),
      JSON.stringify({
        id: "launch-wrap-snapshot",
        requirements: { jagentdesk: ">=0.14.0-beta.2" },
      }),
    );
    // connect() always fails, so nothing negotiated over a connection can reach the snapshot.
    await writeFile(
      path.join(directory, "index.server.ts"),
      `import { runAcpProvider } from "@jagentdesk/plugin/server/acp";
let connects = 0;
export default function contribute(server) {
  const acp = runAcpProvider({ id: "wrap-acp", label: "Wrap ACP", command: [process.execPath, "--version"] });
  server.registerProvider({ ...acp, connect() { connects += 1; throw new Error("not connected in this test"); } });
  return server.before("agent.create", async ({ request }, { jagentdesk }) => {
    const snapshot = await jagentdesk.providers.snapshot();
    const entry = snapshot.entries.find((candidate) => candidate.provider === "wrap-acp");
    return { ...request, metadata: { ...request.metadata, launchWrapProbe: { launchWrap: entry?.launchWrap ?? null, status: entry?.status ?? null, connects } } };
  });
}
`,
    );
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    const agent = await client.createAgent({ provider: "codex", cwd: directory });
    expect(daemon.daemon.agentManager.getAgent(agent.id)?.metadata.launchWrapProbe).toMatchObject({
      launchWrap: true,
      connects: 0,
    });
    await client.archiveAgent(agent.id);
  } finally {
    await client.close();
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
