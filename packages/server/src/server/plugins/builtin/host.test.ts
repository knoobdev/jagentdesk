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
import { ClusterRegistry } from "../../cluster/cluster-registry.js";
import { DatabaseRegistry } from "../../database/database-registry.js";

const registries = () => ({ clusters: new ClusterRegistry(), databases: new DatabaseRegistry() });
const sessionServices = () => ({
  remoteDocker: () => undefined,
  remoteK8s: () => undefined,
  remoteDb: () => undefined,
  supportsClientCapability: () => false,
  push: () => {},
  pushBinary: () => {},
});
const toolContext = { callerAgentId: null, callerLabels: () => undefined };

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
    createBuiltinCoreServices(home, pino({ level: "silent" }), config, registries()),
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
    ...createBuiltinCoreServices(home, pino({ level: "silent" }), config, registries()),
    ...sessionServices(),
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
    registry.registerAgentTools(before, (name) => oldNames.push(name), toolContext);
    const reserved: string[] = [];
    registry.registerAgentTools(
      state.forAgent("after"),
      (name) => newNames.push(name),
      toolContext,
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

test("eager contributions open with the session, follow toggles and capability changes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "jad-builtin-eager-"));
  const config = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false } }),
  );
  const state = new BuiltinPluginState(config);
  const registry = new BuiltinServerRegistry();
  const host = registry.forPlugin("argocd");
  const calls: string[] = [];
  let created = 0;
  const shared = host.shared(() => ({ instance: ++created }));
  host.rpc(
    "argocd.",
    ["argocd.instances.list.request"],
    (services) => ({
      start: () => {
        calls.push(`start:${shared(services).instance}`);
      },
      stop: () => {
        calls.push("stop");
      },
      capabilitiesChanged: () => {
        calls.push("capabilities");
      },
      handle: () => {
        calls.push("list");
      },
    }),
    { eager: true },
  );
  const core = createBuiltinCoreServices(home, pino({ level: "silent" }), config, registries());
  const session = registry.session(state, { ...core, ...sessionServices() });
  try {
    await session.dispatch({ type: "argocd.instances.list.request", requestId: "one" });
    expect(calls).toEqual(["start:1", "list"]);
    session.capabilitiesChanged();
    await state.set("argocd", false);
    session.capabilitiesChanged();
    await state.set("argocd", true);
    await session.dispatch({ type: "argocd.instances.list.request", requestId: "two" });
    expect(calls).toEqual(["start:1", "list", "capabilities", "stop", "start:1", "list"]);
    // A second session of the same daemon reuses the shared value.
    expect(shared(core).instance).toBe(1);
  } finally {
    await session.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test("tool slots install features in the requested catalog order", () => {
  const registry = new BuiltinServerRegistry();
  for (const id of ["docker", "clusters", "argocd"] as const)
    registry
      .forPlugin(id)
      .agentTools((register) =>
        register(`${id}_tool`, { inputSchema: {} }, async () => ({ content: [] })),
      );
  const names: string[] = [];
  const add = (name: string) => names.push(name);
  registry.registerAgentTools(undefined, add, toolContext, undefined, {
    only: ["clusters", "docker"],
  });
  registry.registerAgentTools(undefined, add, toolContext, undefined, {
    except: ["clusters", "docker"],
  });
  expect(names).toEqual(["clusters_tool", "docker_tool", "argocd_tool"]);
});
