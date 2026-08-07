import { test } from "../support/fixtures";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import {
  expectPairingUnavailable,
  openPairDeviceModal,
  preparePairingHost,
} from "../support/helpers/pair-device";

test("shows the tailnet pairing offer unavailable state in browser web", async ({ page }) => {
  const daemon = await startIsolatedHostDaemon("pair-device-browser-tailnet-off");
  try {
    await preparePairingHost(page, daemon);
    await openPairDeviceModal(page);
    await expectPairingUnavailable(page);
  } finally {
    await daemon.close();
  }
});
