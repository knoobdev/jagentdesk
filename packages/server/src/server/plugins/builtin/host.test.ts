import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@jagentdesk/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { BuiltinPluginState } from "./state.js";
import { BuiltinServerRegistry } from "./host.js";
import { createBuiltinCoreServices } from "./services.js";

test("one RPC registration admits and dispatches, toggles lifecycle once, and snapshots new tools", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jad-builtin-host-"));
  const config = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
  );
  const state = new BuiltinPluginState(config);
  const registry = new BuiltinServerRegistry();
  const host = registry.forPlugin("docker");
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  host.backgroundService(() => ({
    start: (signal) => {
      signals.push(signal);
    },
    stop() {},
  }));
  const stopBackground = await registry.start(
    state,
    createBuiltinCoreServices(home, pino({ level: "silent" }), config),
  );
  host.rpc("docker/", ["docker/list"], () => ({
    start: () => {
      calls.push("start");
    },
    stop: () => {
      calls.push("stop");
    },
    handle: () => {
      calls.push("list");
    },
  }));
  host.agentTools((register) =>
    register("docker_ps", { inputSchema: {} }, async () => ({ content: [] })),
  );
  const session = registry.session(state, {
    ...createBuiltinCoreServices(home, pino({ level: "silent" }), config),
    service: registry.lookup(home),
    provided: registry.provided,
    supportsClientCapability: () => false,
    transportBufferedAmount: () => null,
    remoteDocker: () => undefined,
    push: () => {},
    pushBinary: () => {},
  });
  try {
    expect(registry.rpcNames()).toEqual(["docker/list"]);
    expect(registry.owns("docker/list")).toBe(true);
    expect(
      session.dispatch({ type: "docker/inspect", requestId: "other", container: "x" }),
    ).toBeUndefined();
    const before = state.forAgent("before");
    await session.dispatch({ type: "docker/list", requestId: "one" });
    await state.set("docker", false);
    expect(signals[0]?.aborted).toBe(true);
    await expect(session.dispatch({ type: "docker/list", requestId: "two" })).rejects.toMatchObject(
      { code: "plugin_disabled" },
    );
    const oldNames: string[] = [],
      newNames: string[] = [];
    registry.registerAgentTools(before, (name) => oldNames.push(name));
    const reserved: string[] = [];
    registry.registerAgentTools(
      state.forAgent("after"),
      (name) => newNames.push(name),
      (name) => reserved.push(name),
    );
    expect(reserved).toEqual(["docker_ps"]);
    expect(oldNames).toEqual(["docker_ps"]);
    expect(newNames).toEqual([]);
    await state.set("docker", true);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
    await session.dispatch({ type: "docker/list", requestId: "three" });
    expect(calls).toEqual(["start", "list", "stop", "start", "list"]);
  } finally {
    await session.dispose();
    await stopBackground();
    expect(signals[1]?.aborted).toBe(true);
    await rm(home, { recursive: true, force: true });
  }
});

test("duplicate or foreign RPC names fail at registration", () => {
  const registry = new BuiltinServerRegistry();
  const host = registry.forPlugin("docker");
  const create = () => ({ handle() {}, stop() {} });
  expect(() => host.rpc("docker/", ["cluster/list"], create)).toThrow("Invalid or duplicate");
  host.rpc("docker/", ["docker/list"], create);
  expect(() => host.rpc("docker/", ["docker/list"], create)).toThrow("Invalid or duplicate");
});

test("daemon services resolve per home; eager sessions, tool slots and bot triggers follow state", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jad-builtin-host-"));
  const config = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
  );
  const state = new BuiltinPluginState(config);
  const registry = new BuiltinServerRegistry();
  const host = registry.forPlugin("jira");
  const events: string[] = [];
  const handle = host.backgroundService(() => ({
    value: "jira-service",
    start() {
      events.push("service-start");
    },
    stop() {
      events.push("service-stop");
    },
  }));
  host.rpc(
    "jira.",
    ["jira.connections.list.request"],
    (services) => ({
      start: () => {
        events.push(`session-start:${services.service(handle)?.value}`);
      },
      stop: () => {
        events.push("session-stop");
      },
      handle: () => {},
    }),
    { eager: true },
  );
  host.agentTools(
    (register, context) =>
      register(`jira_${context.service(handle)?.value}`, { inputSchema: {} }, async () => ({
        content: [],
      })),
    { slot: "integrations" },
  );
  host.botTriggerSource({
    name: "jira",
    poll: async (_bot, context) => [
      { key: String(context.service(handle)?.value), text: "t", source: "jira" },
    ],
  });
  expect(registry.lookup(home)(handle)).toBeUndefined();
  const stop = await registry.start(
    state,
    createBuiltinCoreServices(home, pino({ level: "silent" }), config),
  );
  const session = registry.session(state, {
    ...createBuiltinCoreServices(home, pino({ level: "silent" }), config),
    service: registry.lookup(home),
    provided: registry.provided,
    supportsClientCapability: () => false,
    transportBufferedAmount: () => null,
    remoteDocker: () => undefined,
    push: () => {},
    pushBinary: () => {},
  });
  try {
    expect(registry.lookup(home)(handle)?.value).toBe("jira-service");
    expect(registry.lookup(`${home}-other`)(handle)).toBeUndefined();
    await session.dispose().then(() => undefined);
    expect(events).toEqual(["service-start", "session-start:jira-service", "session-stop"]);
    const tools: string[] = [];
    registry.registerAgentTools(undefined, (name) => tools.push(name), undefined, {
      service: registry.lookup(home),
    });
    expect(tools).toEqual([]);
    registry.registerAgentTools(
      undefined,
      (name) => tools.push(name),
      undefined,
      { service: registry.lookup(home) },
      "integrations",
    );
    expect(tools).toEqual(["jira_jira-service"]);
    const sources = registry.botTriggerSources(state, home);
    expect(sources.map((source) => source.name)).toEqual(["jira"]);
    const context = { now: 0, state: () => undefined, setState: () => {} };
    const bot = {} as Parameters<(typeof sources)[number]["poll"]>[0];
    expect((await sources[0]!.poll(bot, context))[0]?.key).toBe("jira-service");
    await state.set("jira", false);
    expect(registry.botTriggerSources(state, home)).toEqual([]);
  } finally {
    await stop();
    expect(registry.lookup(home)(handle)).toBeUndefined();
    await rm(home, { recursive: true, force: true });
  }
});
