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
    signAndInstall(input) {
      return signer().signAndInstall({
        accountId: input.accountId,
        deviceUdid: input.deviceUdid,
        ipaPath: input.ipaPath,
        autoRefresh: input.autoRefresh,
      });
    },
  };
}
