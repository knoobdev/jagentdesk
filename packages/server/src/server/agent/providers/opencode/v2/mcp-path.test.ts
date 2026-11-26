import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";
import { bridgeBindings, OPENCODE_MCP_PATH_ENV } from "./shared-service.js";

type RpcHandlers = Record<string, (input: Record<string, unknown>) => Promise<unknown>>;

interface LoadedPlugin {
  client: Parameters<typeof bridgeBindings>[0];
  binds: string[];
  bound: () => Promise<{ bound: boolean }>;
  dispose: () => Promise<void>;
}

// Spec 33.7: the real v2 plugin, in a fake OpenCode location. `permission.assert` exists from
// OpenCode 2.0.29; without it the plugin reports no `features.mcpTools`.
async function loadPlugin(
  bridge: OpenCodeBridge,
  home: string,
  withPermissionAssert: boolean,
): Promise<LoadedPlugin> {
  const plugin = await bridge.materializeV2Plugin();
  const module = await import(pathToFileURL(path.join(fileURLToPath(plugin), "server.js")).href);
  let rpc: RpcHandlers = {};
  const binds: string[] = [];
  const dispose: () => Promise<void> = await module.default.setup({
    options: {},
    location: { directory: home },
    ...Object.fromEntries(
      ["provider", "model", "agent", "command", "skill"].map((name) => [
        name,
        { reload: async () => {} },
      ]),
    ),
    rpc: {
      register: async (_definition: unknown, handlers: RpcHandlers) => {
        rpc = handlers;
        return { dispose: async () => {} };
      },
    },
    tool: {
      transform: async (fn: (editor: { get(): undefined; add(): void }) => void) => {
        fn({ get: () => undefined, add: () => {} });
        return { dispose: async () => {} };
      },
    },
    ...(withPermissionAssert ? { permission: { assert: async () => {} } } : {}),
    session: {
      context: async () => [],
      get: async () => ({ parentID: "" }),
      hook: async () => ({ dispose: async () => {} }),
    },
  });
  const client = {
    plugin: {
      list: async () => ({
        location: { directory: home },
        data: [{ id: "jagentdesk", state: { status: "active" } }],
      }),
    },
    rpc: {
      call: async (input: { method: string; input: Record<string, unknown> }) => {
        if (input.method === "bind") binds.push(String(input.input.sessionID));
        return { output: await rpc[input.method](input.input) };
      },
    },
  } as unknown as Parameters<typeof bridgeBindings>[0];
  return {
    client,
    binds,
    // Whether the last probe left its binding behind in the plugin.
    bound: async () => (await rpc.status({ sessionID: binds.at(-1) ?? "" })) as { bound: boolean },
    dispose,
  };
}

function capturingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = pino(
    { level: "info" },
    {
      write: (line: string) => {
        lines.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { logger, lines };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(withPermissionAssert: boolean) {
  const home = await mkdtemp(path.join(tmpdir(), "jagentdesk-mcp-path-"));
  const bridge = new OpenCodeBridge({ jagentdeskHome: home, logger: createTestLogger() });
  bridge.setManifestCatalog({ tools: new Map() });
  await bridge.start();
  const plugin = await loadPlugin(bridge, home, withPermissionAssert);
  cleanups.push(async () => {
    await plugin.dispose();
    await bridge.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, bridge, plugin };
}

test("uses the session path once a server's plugin reports features.mcpTools", async () => {
  const { home, bridge, plugin } = await setup(true);
  const { logger, lines } = capturingLogger();
  const bindings = bridgeBindings(plugin.client, bridge, undefined, undefined, {
    logger,
    version: "2.4.2",
  });

  await expect(bindings.mcpPath(home)).resolves.toBe("session");
  await expect(bindings.mcpPath(home)).resolves.toBe("session");

  // One probe per server, and it leaves no binding behind.
  expect(plugin.binds).toHaveLength(1);
  await expect(plugin.bound()).resolves.toMatchObject({ bound: false });
  expect(lines.filter((line) => "opencode_mcp_path" in line)).toEqual([
    expect.objectContaining({ opencode_mcp_path: "session", opencodeVersion: "2.4.2" }),
  ]);
});

test("falls back to the legacy path when the server has no permission.assert", async () => {
  const { home, bridge, plugin } = await setup(false);
  const { logger, lines } = capturingLogger();
  const bindings = bridgeBindings(plugin.client, bridge, undefined, undefined, {
    logger,
    version: "2.0.28",
  });

  await expect(bindings.mcpPath(home)).resolves.toBe("legacy");
  expect(lines.filter((line) => "opencode_mcp_path" in line)).toEqual([
    expect.objectContaining({ opencode_mcp_path: "legacy", opencodeVersion: "2.0.28" }),
  ]);
  // A session without its own MCP servers still binds on that server.
  const release = bridge.bindSession({ sessionId: "plain", env: {} });
  await expect(bindings.bindSession("plain", home)).resolves.toBeUndefined();
  release();
});

test("records the path from the first real bind, without a probe", async () => {
  const { home, bridge, plugin } = await setup(true);
  const { logger, lines } = capturingLogger();
  const bindings = bridgeBindings(plugin.client, bridge, undefined, undefined, { logger });
  const release = bridge.bindSession({ sessionId: "first", env: {} });

  await bindings.bindSession("first", home);
  await expect(bindings.mcpPath(home)).resolves.toBe("session");

  expect(plugin.binds).toEqual(["first"]);
  expect(lines.filter((line) => "opencode_mcp_path" in line)).toHaveLength(1);
  release();
});

test("a new server generation decides again", async () => {
  const { home, bridge, plugin } = await setup(true);
  const { logger } = capturingLogger();
  const first = bridgeBindings(plugin.client, bridge, undefined, undefined, { logger });
  await first.mcpPath(home);
  const restarted = bridgeBindings(plugin.client, bridge, undefined, undefined, { logger });
  await restarted.mcpPath(home);
  expect(plugin.binds).toHaveLength(2);
});

test("the legacy path can be forced for every server", async () => {
  vi.stubEnv(OPENCODE_MCP_PATH_ENV, "legacy");
  const { home, bridge, plugin } = await setup(true);
  const { logger, lines } = capturingLogger();
  const bindings = bridgeBindings(plugin.client, bridge, undefined, undefined, { logger });

  await expect(bindings.mcpPath(home)).resolves.toBe("legacy");
  expect(lines.filter((line) => "opencode_mcp_path" in line)).toEqual([
    expect.objectContaining({
      opencode_mcp_path: "legacy",
      reason: `${OPENCODE_MCP_PATH_ENV}=legacy`,
    }),
  ]);
});

test("without the tool bridge every server uses the legacy path", async () => {
  const { home, plugin } = await setup(true);
  const bindings = bridgeBindings(plugin.client, undefined);
  await expect(bindings.mcpPath(home)).resolves.toBe("legacy");
  expect(plugin.binds).toEqual([]);
});

test("a failed probe uses the legacy path for that session and probes again next time", async () => {
  const { home, bridge, plugin } = await setup(true);
  const { logger, lines } = capturingLogger();
  let fail = true;
  const client = {
    ...plugin.client,
    rpc: {
      call: async (...args: Parameters<typeof plugin.client.rpc.call>) => {
        if (fail && args[0].method === "bind") throw new Error("plugin is reloading");
        return plugin.client.rpc.call(...args);
      },
    },
  } as Parameters<typeof bridgeBindings>[0];
  const bindings = bridgeBindings(client, bridge, undefined, undefined, { logger });

  await expect(bindings.mcpPath(home)).resolves.toBe("legacy");
  expect(lines.some((line) => line.level === 40)).toBe(true);
  fail = false;
  await expect(bindings.mcpPath(home)).resolves.toBe("session");
});
