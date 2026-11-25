import { describe, expect, it } from "vitest";
import type { SideloadAccountSummary } from "@jagentdesk/protocol/sideload/rpc-schemas";
import { createSideloadAgentTools, type SideloadToolService } from "./agent-tools.js";

const ACCOUNT: SideloadAccountSummary = {
  id: "apl_a1b2c3d4",
  appleId: "secondary@example.invalid",
  kind: "free",
  auth: "apple_id",
  teamId: "A1B2C3D4E5",
  teamName: "Tester",
  keepSignedIn: false,
  anisetteSource: "native",
  anisetteUrl: null,
  createdAt_ms: 0,
  signedIn: true,
  appIdsUsed: 2,
  appIdsLimit: 10,
  nextAppIdAt_ms: null,
};

function fakeService() {
  const installs: string[] = [];
  const service: SideloadToolService = {
    listAccounts: async () => [ACCOUNT],
    listApps: () => [],
    signAndInstall: async (input) => {
      installs.push(input.ipaPath);
      return { appId: "sla_1", bundleId: "dev.example.app", expiresAt_ms: 1 };
    },
    androidInstall: async (_serial, paths) => {
      installs.push(paths[0]!);
      return "Success";
    },
  };
  return { service, installs };
}

function tool(tools: ReturnType<typeof createSideloadAgentTools>, name: string) {
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
}

describe("sideload agent tools (26.10)", () => {
  it("asks before installing and installs nothing when denied", async () => {
    const { service, installs } = fakeService();
    const asked: string[] = [];
    const tools = createSideloadAgentTools({
      service,
      callerAgentId: "agent-1",
      requestPermission: async (_agent, request) => {
        asked.push(request.name);
        return { behavior: "deny", message: "no" };
      },
    });
    const ios = await tool(tools, "sideload_install").handler(
      { deviceId: "00008110-A", path: "/tmp/App.ipa" },
      {},
    );
    const android = await tool(tools, "android_install").handler(
      { deviceId: "R5CT", path: "/tmp/app.apk" },
      {},
    );
    expect(asked).toEqual(["sideload_install", "android_install"]);
    expect(installs).toEqual([]);
    expect(ios.isError).toBe(true);
    expect(android.content[0]!.text).toContain("denied");
  });

  it("installs after the user allows it, and lists without asking", async () => {
    const { service, installs } = fakeService();
    let asked = 0;
    const tools = createSideloadAgentTools({
      service,
      callerAgentId: "agent-1",
      requestPermission: async () => {
        asked += 1;
        return { behavior: "allow", updatedInput: {} };
      },
    });
    const accounts = await tool(tools, "sideload_list_accounts").handler({}, {});
    expect(asked).toBe(0);
    expect(accounts.content[0]!.text).not.toContain("password");
    await tool(tools, "sideload_install").handler(
      { deviceId: "00008110-A", path: "/tmp/App.ipa" },
      {},
    );
    expect(asked).toBe(1);
    expect(installs).toEqual(["/tmp/App.ipa"]);
    expect(tools.map((entry) => [entry.name, entry.requiresPermission])).toEqual([
      ["sideload_list_accounts", false],
      ["sideload_list_apps", false],
      ["sideload_install", true],
      ["android_install", true],
    ]);
  });
});
