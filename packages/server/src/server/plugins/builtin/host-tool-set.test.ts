import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MutableDaemonConfigSchema } from "@jagentdesk/protocol/messages";
import { DaemonConfigStore } from "../../daemon-config-store.js";
import { diffHostToolSets } from "../../agent/host-tool-set.js";
import { createBuiltinHostToolSet } from "./host-tool-set.js";
import { BuiltinPluginState } from "./state.js";
import { builtinServerRegistry } from "./loaded.js";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setup() {
  const home = await mkdtemp(path.join(os.tmpdir(), "jad-host-tool-set-"));
  homes.push(home);
  const store = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({
      mcp: { injectIntoAgents: true },
      browserTools: { enabled: false },
    }),
  );
  const state = new BuiltinPluginState(store);
  return { state, ...createBuiltinHostToolSet({ state, registry: builtinServerRegistry }) };
}

describe("built-in host tool set (spec 04 §27b.1)", () => {
  test("an agent's runtime keeps its tool groups until the next launch adopts the host's", async () => {
    const { state, source } = await setup();
    source.adopt("agent-1");
    expect(source.launched("agent-1").has("browser-tools")).toBe(false);
    expect(source.inAppBrowser("agent-1")).toBe(false);

    await state.set("browser-tools", true, true);

    // Stateless MCP requests of the running runtime still see the old snapshot…
    expect(state.forAgent("agent-1").has("browser-tools")).toBe(false);
    // …and the manager sees the difference at the next turn.
    expect(diffHostToolSets(source.launched("agent-1"), source.current())).toEqual({
      added: ["browser-tools"],
      removed: [],
    });

    source.adopt("agent-1");
    expect(diffHostToolSets(source.launched("agent-1"), source.current())).toBeNull();
    expect(source.inAppBrowser("agent-1")).toBe(true);
    expect(state.forAgent("agent-1").has("browser-tools")).toBe(true);
  });

  test("built-ins without agent tools never count as a tool change", async () => {
    const { state, source } = await setup();
    source.adopt("agent-1");
    await state.set("insights", !state.isEnabled("insights"), true);
    expect(diffHostToolSets(source.launched("agent-1"), source.current())).toBeNull();
  });

  test("instructions follow the adopted set; the off list names Browser tools", async () => {
    const { state, source } = await setup();
    source.adopt("agent-1");
    expect(source.instructions("agent-1").join("\n")).toContain("Browser tools (`browser-tools`)");
    await state.set("browser-tools", true, true);
    source.adopt("agent-1");
    const instructions = source.instructions("agent-1").join("\n");
    expect(instructions).not.toContain("Browser tools (`browser-tools`)");
    expect(instructions).toContain("`browser_*` tools");
  });

  test("turnOn enables the group for the host", async () => {
    const { state, groups } = await setup();
    await groups.turnOn("browser-tools");
    expect(state.isEnabled("browser-tools")).toBe(true);
    expect(groups.list("agent-2").find((entry) => entry.id === "browser-tools")).toEqual(
      expect.objectContaining({ name: "Browser tools", on: true }),
    );
    await expect(groups.turnOn("insights")).rejects.toThrow("Unknown tool group: insights");
  });
});
