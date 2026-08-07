import { test } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { expectLocalHostEntryFirst } from "../../app/e2e/support/helpers/settings";

test("sidebar pins the local desktop daemon host first", async ({ page }) => {
  const serverId = getServerId();

  await page.addInitScript((localServerId) => {
    (window as unknown as { jagentdeskDesktop: unknown }).jagentdeskDesktop = {
      platform: "darwin",
      invoke: async (command: string) => {
        if (command === "desktop_daemon_status") {
          return {
            serverId: localServerId,
            status: "running",
            listen: null,
            hostname: null,
            pid: null,
            home: "",
            version: null,
            desktopManaged: true,
            error: null,
          };
        }
        if (command === "get_desktop_settings") {
          return {
            daemon: { manageBuiltInDaemon: false, keepRunningAfterQuit: true },
          };
        }
        return null;
      },
      getPendingOpenProject: async () => null,
      events: { on: async () => () => undefined },
    };
  }, serverId);

  await gotoAppShell(page);
  await openSettings(page);
  await expectLocalHostEntryFirst(page, serverId);
  if (process.env.E2E_ARTIFACT_DIR) {
    await page.screenshot({
      path: `${process.env.E2E_ARTIFACT_DIR}/desktop-local-daemon-settings.png`,
      fullPage: true,
    });
  }
});
