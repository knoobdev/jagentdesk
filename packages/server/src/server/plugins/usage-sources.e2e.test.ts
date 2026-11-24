import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, it } from "vitest";
import type { ProviderLaunch } from "@jagentdesk/plugin/server/provider";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { PluginService } from "./index.js";

it("discovers quota with the provider launch and removes accounts when the CLI disappears", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "jagentdesk-usage-launch-"));
  await writeFile(path.join(home, "jagentdesk-plugin.json"), JSON.stringify({ id: "quota" }));
  await writeFile(
    path.join(home, "index.server.ts"),
    `
    import { z } from "zod";
    export default function(server) {
      server.registerProvider({ id: "quota-provider", label: "Quota", command: ["quota-cli"], connect() { throw new Error("Usage must not open a provider connection"); } });
      server.registerUsageSource({ id: "quota", label: "Quota", provider: "quota-provider", input: z.object({ command: z.string() }),
        async discover(scope) { return scope.launch ? [{ key: "account", input: { command: scope.launch.command } }] : []; },
        async fetch(input) { return { status: "available", windows: [], details: [{ id: "launch", label: "Executable", value: input.command }] }; }
      });
      return () => {};
    }
  `,
  );
  let launch: ProviderLaunch | undefined = { command: process.execPath, args: ["acp"], env: {} };
  const store = new DaemonConfigStore(home, {
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    pluginsEnabled: true,
    plugins: { quota: { source: "directory", path: home } },
  });
  const service = new PluginService(pino({ level: "silent" }), store, "0.9.59", {
    resolveUsageLaunch: async (provider) => {
      expect(provider).toBe("quota-provider");
      return launch;
    },
  });
  bindTestSessionHost(service);
  try {
    await service.start();
    const reports = await service.listUsageReports();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.report).toEqual({
      status: "available",
      windows: [],
      details: [{ id: "launch", label: "Executable", value: process.execPath }],
    });
    launch = undefined;
    expect(await service.listUsageReports()).toEqual([]);
  } finally {
    await service.stopAllPlugins();
    await rm(home, { recursive: true, force: true });
  }
});

function bindTestSessionHost(service: PluginService): PluginService {
  service.bindJAgentDeskSessionHost({
    async attachPluginSocket(_pluginId, socket) {
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      socket.on("message", (data) => {
        if (typeof data !== "string") return;
        const message = JSON.parse(data);
        if (message.type !== "hello") return;
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "plugin-service-test",
                hostname: "plugin-service-test",
                version: "0.4.0",
                features: {},
              },
            },
          }),
        );
      });
      return { closed };
    },
  });
  return service;
}
