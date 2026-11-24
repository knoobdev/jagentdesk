import { describe, expect, it } from "vitest";
import { BUILTIN_PLUGIN_IDS } from "@jagentdesk/protocol/builtin-plugins";
import { builtinPluginEnabled, builtinPluginForRoute } from "./registry";
import type { DaemonServerInfo } from "@/stores/session-store";

const host = (enabled: boolean): DaemonServerInfo => ({
  serverId: "host",
  hostname: null,
  version: "0.9.59",
  features: { builtinPlugins: true, docker: enabled, figma: enabled, bots: enabled },
});
describe("built-in app registry", () => {
  it("gates live host state and keeps old hosts compatible in one boundary", () => {
    expect(builtinPluginEnabled(host(true), "docker")).toBe(true);
    expect(builtinPluginEnabled(host(false), "docker")).toBe(false);
    expect(
      builtinPluginEnabled({ serverId: "old", hostname: null, version: "0.8.0" }, "docker"),
    ).toBe(true);
    for (const id of BUILTIN_PLUGIN_IDS) expect(builtinPluginEnabled(host(false), id)).toBe(false);
  });
  it("gates deep links and nested resource routes without affecting core routes", () => {
    expect(builtinPluginForRoute("/h/one/bots?botId=b")).toBe("bots");
    expect(builtinPluginForRoute("/h/one/docker")).toBe("docker");
    expect(builtinPluginForRoute("/h/two/cluster/c1/workloads")).toBe("clusters");
    expect(builtinPluginForRoute("/h/two/database/db/tables")).toBe("databases");
    expect(builtinPluginForRoute("/h/one/settings")).toBe(null);
    expect(builtinPluginForRoute("/h/one/workspace/w1")).toBe(null);
  });
});
