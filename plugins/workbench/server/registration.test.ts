import { describe, expect, it } from "vitest";
import { BuiltinServerRegistry } from "../../../packages/server/src/server/plugins/builtin/host-test-api.js";
import type { RegisterBuiltinTool } from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { register } from "./index.js";

function succeeded(udid: string) {
  return { udid, ok: true, error: null };
}

describe("workbench registration", () => {
  it("registers every proxy/* request once and installs through the Devices simulator installer", async () => {
    const registry = new BuiltinServerRegistry();
    const installs: string[][] = [];
    const installOnMany = async (udids: string[], filePath: string) => {
      installs.push([...udids, filePath]);
      return udids.map(succeeded);
    };
    registry.forPlugin("devices").provide("devices.simulator-installer", { installOnMany });
    register(registry.forPlugin("workbench"));
    expect(registry.rpcNames()).toHaveLength(20);
    expect(registry.rpcNames().every((name) => name.startsWith("proxy/"))).toBe(true);
    const tools = new Map<string, Parameters<RegisterBuiltinTool>[2]>();
    registry.registerAgentTools(
      undefined,
      (name, _config, handler) => tools.set(name, handler),
      undefined,
      {},
      "late",
    );
    expect(
      [...tools.keys()].every((name) => name.startsWith("proxy_") || name === "sim_install_batch"),
    ).toBe(true);
    const batch = tools.get("sim_install_batch");
    if (batch) {
      await batch({ udids: ["A", "B"], filePath: "/tmp/app.ipa" }, {} as never);
      expect(installs).toEqual([["A", "B", "/tmp/app.ipa"]]);
    }
  });
});
