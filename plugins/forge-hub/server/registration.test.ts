import { describe, expect, it } from "vitest";
import { BuiltinServerRegistry } from "../../../packages/server/src/server/plugins/builtin/host-test-api.js";
import { FORGE_HUB_REQUEST_TYPES } from "./forge-hub-session.js";
import { register } from "./index.js";

// The one built-in registration admits and dispatches every forge.* request ForgeHubSession
// handles; forge.search.request stays with the core checkout search.
describe("forge hub registration", () => {
  it("registers every Forge Hub request and the forge_* tools in the late catalog slot", () => {
    const registry = new BuiltinServerRegistry();
    register(registry.forPlugin("forge-hub"));
    expect(registry.rpcNames()).toEqual([...FORGE_HUB_REQUEST_TYPES].sort());
    expect(registry.rpcNames()).toHaveLength(40);
    expect(registry.owns("forge.search.request")).toBe(false);
    const tools: string[] = [];
    registry.registerAgentTools(undefined, (name) => tools.push(name), undefined, {}, "late");
    expect(tools).toHaveLength(12);
    expect(tools.every((name) => name.startsWith("forge_"))).toBe(true);
  });
});
