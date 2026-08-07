import { test } from "../../app/e2e/support/fixtures";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import {
  loadRealDaemonState,
  installDesktopRuntime,
  openDesktopSettings,
  interceptDaemonManagementConfirmDialog,
  toggleDaemonManagement,
  expectDaemonManagementConfirmDialog,
  expectDaemonManagementEnabled,
  expectDaemonManagementDisabled,
  expectDaemonStatusPid,
  expectDaemonStatusLogPath,
  expectDaemonStatusVersion,
} from "./support/runtime";

// No Playwright Electron runner exists; we simulate the desktop bridge via
// addInitScript so Electron-gated daemon settings activate without a real
// Electron process.
test.describe("Desktop daemon management", () => {
  test("disabling built-in daemon management shows confirm dialog with correct copy", async ({
    page,
  }) => {
    const serverId = getServerId();
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
      confirmShouldAccept: false,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    const dialogArgs = await interceptDaemonManagementConfirmDialog(page);
    expectDaemonManagementConfirmDialog(dialogArgs);

    await expectDaemonManagementEnabled(page);
  });

  test("cancelling the confirm dialog leaves the daemon management toggle on", async ({ page }) => {
    const serverId = getServerId();
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
      confirmShouldAccept: false,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expectDaemonManagementEnabled(page);
    await toggleDaemonManagement(page, "disable");
    await expectDaemonManagementEnabled(page);
  });

  test("confirming the dialog disables built-in daemon management", async ({ page }) => {
    const serverId = getServerId();
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
      confirmShouldAccept: true,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await toggleDaemonManagement(page, "disable");

    await expectDaemonManagementDisabled(page);
  });

  test("daemon status panel renders version, PID, and log path from the real daemon", async ({
    page,
  }) => {
    const serverId = getServerId();
    const realState = await loadRealDaemonState();
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: false,
      daemonPid: realState.pid,
      daemonVersion: realState.version,
      daemonLogPath: realState.logPath,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expectDaemonStatusVersion(page, realState.version);
    await expectDaemonStatusPid(page, realState.pid);
    await expectDaemonStatusLogPath(page, realState.logPath);
  });

  test("stopping and restarting the daemon updates the PID", async ({ page }) => {
    const serverId = getServerId();
    const realState = await loadRealDaemonState();
    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
      daemonPid: realState.pid,
      daemonVersion: realState.version,
      daemonLogPath: realState.logPath,
      confirmShouldAccept: true,
    });
    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expectDaemonStatusPid(page, realState.pid);

    await toggleDaemonManagement(page, "disable");
    await expectDaemonManagementDisabled(page);
    await expectDaemonStatusPid(page, null);

    await toggleDaemonManagement(page, "enable");
    await expectDaemonManagementEnabled(page);
    const newPid = realState.pid !== null ? realState.pid + 1000 : 11000;
    await expectDaemonStatusPid(page, newPid);
  });
});
