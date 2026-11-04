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

  it("forwards signing to Sideload without extra options", async () => {
    const signAndInstall = vi.fn(async () => ({
      appId: "app_1",
      bundleId: "com.facebook.WebDriverAgentRunner.xctrunner",
      expiresAt_ms: 1,
    }));
    const signer = createSideloadDeviceSigner(() => ({
      listAccounts: async () => [],
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
    });
  });

  it("fails clearly when Sideload is not running yet", async () => {
    const signer = createSideloadDeviceSigner(() => null);
    await expect(signer.listAccounts()).rejects.toThrow("Sideload is not running on this host");
  });
});
