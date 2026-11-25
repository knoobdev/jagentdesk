import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { z } from "zod";
import { createTestLogger } from "../../../../../test-utils/test-logger.js";
import { OpenCodeBridge } from "../bridge.js";

interface Binding {
  sessionID: string;
  baseUrl: string;
  token: string;
}
interface TestTool {
  name: string;
  execute(input: { value: string }, call: { sessionID: string }): Promise<unknown>;
}
interface TestContext {
  sessionID: string;
  tools: Record<string, unknown>;
  system: unknown[];
}

test("a shared plugin binds JAgentDesk sessions without involving unrelated sessions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "jagentdesk-shared-bridge-"));
  const bridge = new OpenCodeBridge({ jagentdeskHome: home, logger: createTestLogger() });
  const tool = { name: "echo", description: "echo", inputSchema: { value: z.string() } };
  const tools = new Map([[tool.name, tool]]);
  // Session-only tools must survive plugin reload without a global definition.
  bridge.setManifestCatalog({ tools: new Map() });
  await bridge.start();
  const unbind = bridge.bindSession({
    sessionId: "jagentdesk",
    env: {},
    tools: {
      tools,
      getTool: (name) => tools.get(name),
      executeTool: async (_name, input) => ({
        content: [{ type: "text", text: String((input as { value: string }).value) }],
      }),
    },
  });
  expect(() => bridge.bindSession({ sessionId: "jagentdesk", env: {} })).toThrow("already bound");
  try {
    const plugin = {
      package: await bridge.materializeV2Plugin(),
      options: bridge.sharedV2Connection(),
    };
    const module = await import(
      pathToFileURL(path.join(fileURLToPath(plugin.package), "server.js")).href
    );
    const installed = new Map<string, TestTool>();
    const hooks: Array<(input: TestContext) => Promise<void>> = [];
    const refreshed: string[] = [];
    let structured = false;
    let rpc: Record<string, (input: Binding) => Promise<unknown>> = {};
    const context = {
      options: {},
      location: { directory: home },
      provider: {
        reload: async () => {
          refreshed.push("provider");
        },
      },
      model: {
        reload: async () => {
          refreshed.push("model");
        },
      },
      agent: {
        reload: async () => {
          refreshed.push("agent");
        },
      },
      command: {
        reload: async () => {
          refreshed.push("command");
        },
      },
      skill: {
        reload: async () => {
          refreshed.push("skill");
        },
      },
      rpc: {
        register: async (_definition: unknown, handlers: typeof rpc) => {
          rpc = handlers;
          return { dispose: async () => {} };
        },
      },
      tool: {
        transform: async (fn: (editor: { add(item: TestTool): void }) => void) => {
          fn({ add: (item) => installed.set(item.name, item) });
          return { dispose: async () => {} };
        },
      },
      session: {
        context: async () =>
          structured
            ? [{ type: "user", metadata: { jagentdeskOutputSchema: { type: "string" } } }]
            : [],
        get: async () => ({ parentID: "" }),
        hook: async (_name: string, fn: (input: TestContext) => Promise<void>) => {
          hooks.push(fn);
          return { dispose: async () => {} };
        },
      },
    };
    let dispose = await module.default.setup(context);
    await rpc.bind({ sessionID: "jagentdesk", ...plugin.options });
    await rpc.refresh({ sessionID: "jagentdesk", ...plugin.options });
    expect(refreshed).toEqual(["provider", "model", "agent", "command", "skill"]);
    await expect(
      rpc.bind({ sessionID: "jagentdesk", ...plugin.options, token: "another-daemon" }),
    ).resolves.toEqual({ error: "OpenCode session is already bound to another JAgentDesk bridge" });
    const own = { sessionID: "jagentdesk", tools: { jagentdesk_echo: {}, native: {} }, system: [] };
    for (const hook of hooks) await hook(own);
    expect(Object.keys(own.tools)).toEqual(["jagentdesk_echo", "native"]);
    expect(
      await installed.get("jagentdesk_echo")!.execute({ value: "ok" }, { sessionID: "jagentdesk" }),
    ).toMatchObject({ content: [{ type: "text", text: "ok" }] });
    await dispose();
    hooks.length = 0;
    installed.clear();
    dispose = await module.default.setup(context);
    const afterReload = {
      sessionID: "jagentdesk",
      tools: { jagentdesk_echo: {}, native: {} },
      system: [],
    };
    for (const hook of hooks) await hook(afterReload);
    expect(Object.keys(afterReload.tools)).toEqual(["jagentdesk_echo", "native"]);
    expect(
      await installed
        .get("jagentdesk_echo")!
        .execute({ value: "reloaded" }, { sessionID: "jagentdesk" }),
    ).toMatchObject({ content: [{ type: "text", text: "reloaded" }] });
    await bridge.close();
    await dispose();
    hooks.length = 0;
    installed.clear();
    dispose = await module.default.setup(context);
    const unrelated = {
      sessionID: "other",
      tools: { jagentdesk_echo: {}, native: {} },
      system: [],
    };
    for (const hook of hooks) await hook(unrelated);
    expect(Object.keys(unrelated.tools)).toEqual(["native"]);
    structured = true;
    const structuredOnly = {
      sessionID: "other",
      tools: { jagentdesk_structured_output: {} },
      system: [],
    };
    for (const hook of hooks) await hook(structuredOnly);
    expect(Object.keys(structuredOnly.tools)).toEqual(["jagentdesk_structured_output"]);
    const restarted = new OpenCodeBridge({
      jagentdeskHome: home,
      logger: createTestLogger(),
      port: Number(new URL(plugin.options.baseUrl).port),
    });
    restarted.setManifestCatalog({ tools });
    await restarted.start();
    const releaseRestarted = restarted.bindSession({ sessionId: "jagentdesk", env: {} });
    try {
      await expect(
        rpc.bind({ sessionID: "jagentdesk", ...restarted.sharedV2Connection() }),
      ).resolves.toEqual({});
    } finally {
      releaseRestarted();
      await restarted.close();
    }
    await dispose();
  } finally {
    unbind();
    await bridge.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("a shared plugin rebinds a session after the previous bridge stops listening", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "jagentdesk-shared-bridge-refused-"));
  const previous = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(JSON.stringify({ tools: [] }));
  });
  await new Promise<void>((resolve) => previous.listen(0, "127.0.0.1", resolve));
  const previousPort = (previous.address() as AddressInfo).port;
  const current = new OpenCodeBridge({ jagentdeskHome: home, logger: createTestLogger() });
  current.setManifestCatalog({ tools: new Map() });
  let rpc: Record<string, (input: Binding) => Promise<unknown>> = {};
  let dispose: (() => Promise<void>) | undefined;
  let releaseCurrent: (() => void) | undefined;
  try {
    const plugin = {
      package: await current.materializeV2Plugin(),
      options: { baseUrl: `http://127.0.0.1:${previousPort}`, token: "previous-bridge" },
    };
    const module = await import(
      pathToFileURL(path.join(fileURLToPath(plugin.package), "server.js")).href
    );
    dispose = await module.default.setup({
      options: {},
      location: { directory: home },
      provider: { reload: async () => {} },
      model: { reload: async () => {} },
      agent: { reload: async () => {} },
      command: { reload: async () => {} },
      skill: { reload: async () => {} },
      rpc: {
        register: async (_definition: unknown, handlers: typeof rpc) => {
          rpc = handlers;
          return { dispose: async () => {} };
        },
      },
      tool: { transform: async () => ({ dispose: async () => {} }) },
      session: {
        context: async () => [],
        get: async () => ({ parentID: "" }),
        hook: async () => ({ dispose: async () => {} }),
      },
    });
    await expect(rpc.bind({ sessionID: "jagentdesk", ...plugin.options })).resolves.toEqual({});
    await current.start();
    // The restarted daemon owns the agent again, so its bridge serves this session.
    releaseCurrent = current.bindSession({ sessionId: "jagentdesk", env: {} });
    await new Promise<void>((resolve) => {
      previous.close(() => resolve());
      previous.closeAllConnections();
    });
    await expect(
      rpc.bind({ sessionID: "jagentdesk", ...current.sharedV2Connection() }),
    ).resolves.toEqual({});
  } finally {
    await dispose?.();
    releaseCurrent?.();
    await current.close();
    await new Promise<void>((resolve) => previous.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});

test("a refused connection is the only probe failure that clears a binding", async () => {
  const source = new URL("./shared-bridge-plugin.mjs", import.meta.url).href;
  const { isRefused } = (await import(source)) as { isRefused: (error: unknown) => boolean };
  const nodeShape = Object.assign(new Error("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
  const olderBunShape = Object.assign(new TypeError("Unable to connect"), {
    code: "ConnectionRefused",
  });
  // OpenCode 2.2.5 runs on Bun 1.4.4, which carries the code on the error and
  // leaves `cause` unset. Node puts the same failure on `cause` instead.
  const bunShape = Object.assign(
    new TypeError("ECONNREFUSED: Unable to connect. Is the computer able to access the url?"),
    { code: "ECONNREFUSED" },
  );
  const inconclusive = Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" });
  expect(isRefused(nodeShape)).toBe(true);
  expect(isRefused(olderBunShape)).toBe(true);
  expect(isRefused(bunShape)).toBe(true);
  expect(isRefused(inconclusive)).toBe(false);
  expect(isRefused(undefined)).toBe(false);
});
