import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_PLUGIN_IDS } from "@jagentdesk/protocol/builtin-plugins";
import { MutableDaemonConfigSchema } from "@jagentdesk/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { loadConfig } from "../../config.js";
import { BuiltinPluginState } from "./state.js";
import { BuiltinPluginLoader } from "./index.js";
import { builtinPluginForRpc, builtinPluginForTool } from "./gates.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function setup(overrides: Record<string, unknown> = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "jad-builtin-state-"));
  homes.push(home);
  const initial = MutableDaemonConfigSchema.parse({
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    ...overrides,
  });
  const store = new DaemonConfigStore(home, initial);
  return { home, initial, store, state: new BuiltinPluginState(store) };
}

describe("static built-in plugin registry", () => {
  it("lists exactly 19 features with 16 enabled independently of installed plugins", async () => {
    const { state } = await setup({ pluginsEnabled: false });
    expect(state.list().map(({ id }) => id)).toEqual(BUILTIN_PLUGIN_IDS);
    expect(state.list().filter(({ enabled }) => enabled)).toHaveLength(16);
    expect(
      state
        .list()
        .filter(({ enabled }) => !enabled)
        .map(({ id }) => id),
    ).toEqual(["autorun", "session-share", "browser-tools"]);
    const loader = new BuiltinPluginLoader(undefined, []);
    expect([...loader.ids]).toEqual(BUILTIN_PLUGIN_IDS);
  });

  it("resolves a fresh production host with browser tools off", async () => {
    const { home } = await setup();
    await rm(path.join(home, "config.json"));
    const config = loadConfig(home, { env: { JAGENTDESK_RELAY_ENABLED: "0" } });
    expect(config.browserToolsEnabled).toBe(false);
  });

  it("migrates legacy flags once, persists state, and ignores later legacy edits", async () => {
    const { home, initial, store, state } = await setup({
      browserTools: { enabled: true },
      autorun: { enabled: true },
      sessionSharing: { enabled: true },
    });
    expect(state.isEnabled("browser-tools")).toBe(true);
    expect(state.isEnabled("autorun")).toBe(true);
    expect(state.isEnabled("session-share")).toBe(true);
    await state.set("browser-tools", false);
    store.patch({ browserTools: { enabled: true } });
    const restarted = new BuiltinPluginState(new DaemonConfigStore(home, initial));
    expect(restarted.isEnabled("browser-tools")).toBe(false);
    const persisted = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    expect(persisted.builtinPlugins["browser-tools"]).toEqual({ enabled: false });
    expect(Object.keys(persisted.builtinPlugins)).toHaveLength(19);
  });

  it("logs migration only on the first boot", async () => {
    const { home, initial } = await setup();
    await rm(path.join(home, "config.json"));
    const lines: string[] = [];
    const logger = pino(
      {},
      {
        write: (line) => {
          lines.push(line);
        },
      },
    );
    const first = new DaemonConfigStore(home, initial, logger);
    const second = new DaemonConfigStore(home, initial, logger);
    expect(second.get().builtinPlugins).toEqual(first.get().builtinPlugins);
    expect(lines.filter((line) => line.includes("Migrated built-in plugin flags"))).toHaveLength(1);
  });

  it("requires an explicit cascade and changes the full dependency closure atomically", async () => {
    const { state } = await setup();
    await expect(state.set("ssh-servers", false)).rejects.toMatchObject({
      code: "plugin_dependency",
    });
    expect(state.isEnabled("ssh-servers")).toBe(true);
    expect(state.isEnabled("remote-tasks")).toBe(true);
    await state.set("ssh-servers", false, true);
    expect(state.isEnabled("ssh-servers")).toBe(false);
    expect(state.isEnabled("remote-tasks")).toBe(false);
    await expect(state.set("remote-tasks", true)).rejects.toMatchObject({
      code: "plugin_dependency",
    });
    await state.set("remote-tasks", true, true);
    expect(state.isEnabled("ssh-servers")).toBe(true);
    expect(state.isEnabled("remote-tasks")).toBe(true);
    await state.set("clusters", false, true);
    expect(state.isEnabled("argocd")).toBe(false);
    await state.set("skills", false, true);
    expect(state.isEnabled("spec-mode")).toBe(false);
    expect(state.isEnabled("autorun")).toBe(false);
  });

  it("makes unavailable host features and their dependents unavailable without deleting preference", async () => {
    const { state } = await setup();
    await state.setCapabilities({
      androidDevices: {
        state: "missing_tool",
        reason: "Install adb",
        version: null,
        installable: ["adb"],
      },
    });
    expect(state.list().find(({ id }) => id === "devices")).toMatchObject({
      enabled: true,
      available: false,
      unavailableReason: "Install adb",
    });
    expect(state.isEnabled("devices")).toBe(false);
    expect(state.list().find(({ id }) => id === "workbench")).toMatchObject({ available: false });
    await expect(state.set("devices", true)).rejects.toMatchObject({ code: "plugin_unavailable" });
    await state.setCapabilities({
      androidDevices: { state: "available", reason: "", version: "1", installable: [] },
    });
    expect(state.isEnabled("devices")).toBe(true);
    expect(state.isEnabled("workbench")).toBe(true);
  });

  it("stops dependents first, restarts without a daemon restart, and preserves old agent snapshots", async () => {
    const { state } = await setup();
    const calls: string[] = [];
    for (const id of ["ssh-servers", "remote-tasks"] as const) {
      await state.registerLifecycle(id, {
        start: () => {
          calls.push(`start:${id}`);
        },
        stop: () => {
          calls.push(`stop:${id}`);
        },
      });
    }
    expect(state.forAgent("old").has("remote-tasks")).toBe(true);
    await state.set("ssh-servers", false, true);
    expect(calls).toEqual([
      "start:ssh-servers",
      "start:remote-tasks",
      "stop:remote-tasks",
      "stop:ssh-servers",
    ]);
    expect(state.forAgent("old").has("remote-tasks")).toBe(true);
    expect(state.forAgent("new").has("remote-tasks")).toBe(false);
    await state.set("remote-tasks", true, true);
    expect(calls.slice(-2)).toEqual(["start:ssh-servers", "start:remote-tasks"]);
    expect(state.forAgent("new").has("remote-tasks")).toBe(false);
    expect(state.forAgent("newer").has("remote-tasks")).toBe(true);
  });

  it("gates all feature RPC namespaces while retaining core forge checkout and search", () => {
    const pairs = [
      ["docker/list", "docker"],
      ["cluster/list", "clusters"],
      ["database/list", "databases"],
      ["ssh.forward.start.request", "ssh-servers"],
      ["remote_exec.run.request", "remote-tasks"],
      ["providers.custom.save.request", "custom-providers"],
      ["figma.file.get.request", "figma"],
      ["jira.board.list.request", "jira"],
      ["argocd.app.sync.request", "argocd"],
      ["simulator/list", "devices"],
      ["sideload.apps.list.request", "devices"],
      ["android.install.start.request", "devices"],
      ["proxy/capture/start", "workbench"],
      ["forge.connection.list.request", "forge-hub"],
      ["skills.catalog.request", "skills"],
      ["agent.skills.save_selection.request", "skills"],
      ["agent.spec_mode.enable.request", "spec-mode"],
      ["autorun.start.request", "autorun"],
      ["agent.activity_graph.get.request", "activity-graph"],
      ["usage.history.get.request", "insights"],
      ["session.share.create.request", "session-share"],
      ["browser.automation.command.request", "browser-tools"],
    ];
    for (const [rpc, id] of pairs) expect(builtinPluginForRpc(rpc)).toBe(id);
    for (const rpc of [
      "checkout.forge.set_auto_merge.request",
      "forge.search.request",
      "pairing.device.list.request",
      "schedule.create.request",
      "orchestration.status.request",
    ])
      expect(builtinPluginForRpc(rpc)).toBe(null);
    expect(builtinPluginForTool("docker_ps")).toBe("docker");
    expect(builtinPluginForTool("send_agent_prompt")).toBe(null);
  });
});
