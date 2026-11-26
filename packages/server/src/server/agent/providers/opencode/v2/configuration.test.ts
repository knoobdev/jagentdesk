import { describe, expect, test } from "vitest";

import { features, permissionRules } from "./configuration.js";

describe("OpenCode v2 permission rules", () => {
  test("maps authored native permissions and exact injected MCP grants", () => {
    expect(
      permissionRules({
        provider: "opencode",
        cwd: "/tmp/project",
        providerOptions: { permission: { bash: { pwd: "allow" }, task: "ask" } },
        toolPolicy: { preapproved: [{ server: "jagentdesk.host", tool: "read/info" }] },
      }),
    ).toEqual([
      { action: "jagentdesk_host_read_info", resource: "*", effect: "allow" },
      { action: "shell", resource: "pwd", effect: "allow" },
      { action: "subagent", resource: "*", effect: "ask" },
    ]);
  });
});

describe("OpenCode v2 features", () => {
  test("reports the auto-accept toggle from the session value", () => {
    expect(features({ provider: "opencode", cwd: "/tmp/project" })).toEqual([
      { type: "toggle", id: "auto_accept", label: "Auto-accept", value: false },
    ]);
    expect(
      features({
        provider: "opencode",
        cwd: "/tmp/project",
        featureValues: { auto_accept: true },
      }),
    ).toEqual([{ type: "toggle", id: "auto_accept", label: "Auto-accept", value: true }]);
  });
});
