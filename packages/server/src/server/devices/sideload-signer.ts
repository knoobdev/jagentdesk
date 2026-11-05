import { createHash } from "node:crypto";
import type { SideloadAccountSummary } from "@jagentdesk/protocol/sideload/rpc-schemas";
import type { SimSignerAccount } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type { SideloadSigner } from "../sideload/sideload-service.js";
import type { DeviceSigner } from "./wda-prepare.js";

/** Label shown in "Signing WebDriverAgent with …" and the Enable touch account picker. */
export function signerAccountLabel(account: SideloadAccountSummary): string {
  const team = account.teamName ? ` · ${account.teamName}` : "";
  return `${account.appleId} (${account.kind === "paid" ? "Paid" : "Free"}${team})`;
}

/**
 * Spec 27.4: touch setup signs WebDriverAgent with an Apple account from Sideload (26). The
 * Sideload service is created after the device hub at boot, so it is resolved on each call.
 * Accounts that need "Sign in again" are left out: signing with them would fail at Apple.
 */
export function createSideloadDeviceSigner(resolve: () => SideloadSigner | null): DeviceSigner {
  const signer = (): SideloadSigner => {
    const value = resolve();
    if (!value) throw new Error("Sideload is not running on this host");
    return value;
  };
  return {
    async listAccounts(): Promise<SimSignerAccount[]> {
      const accounts = await signer().listAccounts();
      return accounts
        .filter((account) => account.signedIn)
        .map((account) => ({ id: account.id, label: signerAccountLabel(account) }));
    },
    async installedExpiry(deviceUdid, bundleId) {
      const app = (signer().listApps?.() ?? []).find(
        (entry) => entry.deviceUdid === deviceUdid && entry.bundleId === bundleId,
      );
      return app ? app.expiresAt_ms : null;
    },
    async signAndInstall(input) {
      const service = signer();
      const existingBundleId = input.options?.bundleId;
      let bundleId: string;
      if (typeof existingBundleId === "string" && existingBundleId.trim()) {
        bundleId = existingBundleId;
      } else {
        const account = (await service.listAccounts()).find(
          (entry) => entry.id === input.accountId,
        );
        // The upstream Facebook identifier cannot be registered by the user's Apple team.
        // Keep one stable App ID per team (account fallback), including across retries/devices.
        const key = createHash("sha256")
          .update(account?.teamId || input.accountId)
          .digest("hex")
          .slice(0, 20);
        bundleId = `dev.jagentdesk.wda.${key}.xctrunner`;
      }
      return service.signAndInstall({
        accountId: input.accountId,
        deviceUdid: input.deviceUdid,
        ipaPath: input.ipaPath,
        autoRefresh: input.autoRefresh,
        options: { bundleId },
      });
    },
  };
}
