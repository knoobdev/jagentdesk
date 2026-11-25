import { describe, expect, it, vi } from "vitest";
import type { SideloadAccountSummary } from "@jagentdesk/protocol/sideload/rpc-schemas";
import type { SideloadSigner } from "../sideload/sideload-service.js";
import { createSideloadDeviceSigner } from "./sideload-signer.js";

function account(overrides: Partial<SideloadAccountSummary>): SideloadAccountSummary {
  return {
    id: "apl_a1b2c3",
    appleId: "<apple-id>",
    kind: "free",
    auth: "apple_id",
    teamId: "TEAM000001",
    teamName: "Personal Team",
    keepSignedIn: false,
    anisetteSource: "native",
    anisetteUrl: null,
    createdAt_ms: 0,
    signedIn: true,
    appIdsUsed: 0,
    appIdsLimit: 10,
    nextAppIdAt_ms: null,
    ...overrides,
  } as SideloadAccountSummary;
}

describe("createSideloadDeviceSigner", () => {
  it("lists only signed-in accounts with a readable label", async () => {
    const sideload: SideloadSigner = {
      listAccounts: async () => [
        account({}),
        account({ id: "apl_d4e5f6", signedIn: false }),
        account({ id: "apl_g7h8i9", kind: "paid", teamName: null }),
      ],
      signAndInstall: vi.fn(),
    };
    const signer = createSideloadDeviceSigner(() => sideload);
    expect(await signer.listAccounts()).toEqual([
      { id: "apl_a1b2c3", label: "<apple-id> (Free · Personal Team)" },
      { id: "apl_g7h8i9", label: "<apple-id> (Paid)" },
    ]);
  });

  it("signs a new WDA with an owned namespace instead of registering the upstream App ID", async () => {
    const signAndInstall = vi.fn(async () => ({
      appId: "app_1",
      bundleId: "com.facebook.WebDriverAgentRunner.xctrunner",
      expiresAt_ms: 1,
    }));
    const signer = createSideloadDeviceSigner(() => ({
      listAccounts: async () => [account({})],
      signAndInstall,
    }));
    await signer.signAndInstall({
      accountId: "apl_a1b2c3",
      deviceUdid: "00008110-000A1B2C3D4E5F60",
      ipaPath: "/tmp/wda.ipa",
      options: { ignored: true },
      autoRefresh: true,
    });
    expect(signAndInstall).toHaveBeenCalledWith({
      accountId: "apl_a1b2c3",
      deviceUdid: "00008110-000A1B2C3D4E5F60",
      ipaPath: "/tmp/wda.ipa",
      autoRefresh: true,
      options: {
        bundleId: expect.stringMatching(/^dev\.jagentdesk\.wda\.[a-f0-9]{20}\.xctrunner$/),
      },
    });
  });

  it("reuses the same App ID across retries and accounts on the same team", async () => {
    const accounts = [
      account({}),
      account({ id: "apl_d4e5f6" }),
      account({ id: "apl_g7h8i9", teamId: "TEAM000002" }),
    ];
    const signAndInstall = vi.fn<SideloadSigner["signAndInstall"]>(async (input) => ({
      appId: "app_1",
      bundleId: input.options?.bundleId ?? "com.facebook.WebDriverAgentRunner.xctrunner",
      expiresAt_ms: 1,
    }));
    const signer = createSideloadDeviceSigner(() => ({
      listAccounts: async () => accounts,
      signAndInstall,
    }));
    const sign = (accountId: string) =>
      signer.signAndInstall({ accountId, deviceUdid: "<udid>", ipaPath: "/tmp/wda.ipa" });
    const first = await sign(accounts[0].id);
    expect(await sign(accounts[0].id)).toEqual(first);
    expect(await sign(accounts[1].id)).toEqual(first);
    expect((await sign(accounts[2].id)).bundleId).not.toBe(first.bundleId);
    expect(first.bundleId).not.toBe("com.facebook.WebDriverAgentRunner.xctrunner");
  });

  it("keeps the bundle ID of an existing WDA when reinstalling with its account", async () => {
    const bundleId = "dev.jagentdesk.wda.a1b2c3.xctrunner";
    const signAndInstall = vi.fn<SideloadSigner["signAndInstall"]>(async () => ({
      appId: "app_1",
      bundleId,
      expiresAt_ms: 1,
    }));
    const signer = createSideloadDeviceSigner(() => ({
      listAccounts: async () => [account({})],
      signAndInstall,
    }));
    await signer.signAndInstall({
      accountId: "apl_a1b2c3",
      deviceUdid: "<udid>",
      ipaPath: "/tmp/wda.ipa",
      options: { bundleId, ignored: true },
      autoRefresh: true,
    });
    expect(signAndInstall).toHaveBeenCalledWith({
      accountId: "apl_a1b2c3",
      deviceUdid: "<udid>",
      ipaPath: "/tmp/wda.ipa",
      options: { bundleId },
      autoRefresh: true,
    });
  });

  it("has a stable account-scoped identifier when team metadata is not available", async () => {
    const signAndInstall = vi.fn<SideloadSigner["signAndInstall"]>(async (input) => ({
      appId: "app_1",
      bundleId: input.options?.bundleId ?? "com.facebook.WebDriverAgentRunner.xctrunner",
      expiresAt_ms: 1,
    }));
    const signer = createSideloadDeviceSigner(() => ({
      listAccounts: async () => [account({ teamId: null })],
      signAndInstall,
    }));
    const input = { accountId: "apl_a1b2c3", deviceUdid: "<udid>", ipaPath: "/tmp/wda.ipa" };
    const first = await signer.signAndInstall(input);
    expect(await signer.signAndInstall(input)).toEqual(first);
    expect(first.bundleId).toMatch(/^dev\.jagentdesk\.wda\.[a-f0-9]{20}\.xctrunner$/);
  });

  it("fails clearly when Sideload is not running yet", async () => {
    const signer = createSideloadDeviceSigner(() => null);
    await expect(signer.listAccounts()).rejects.toThrow("Sideload is not running on this host");
  });
});
