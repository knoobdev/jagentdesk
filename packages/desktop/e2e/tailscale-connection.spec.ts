import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { expectAppRoute } from "../../app/e2e/support/helpers/route-assertions";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { buildSettingsHostSectionRoute } from "../../app/src/utils/host-routes";
import { installDesktopRuntime, openDesktopSettings } from "./support/runtime";

test.describe("Desktop Tailscale connection", () => {
  test("opens the real Tailscale login flow from Host Overview", async ({ page }) => {
    const serverId = getServerId();

    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
    });
    await page.addInitScript(() => {
      localStorage.setItem("@jagentdesk:connection-mode:v3", "local");
    });

    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expect(page.getByTestId("tailscale-connection-section")).toBeVisible();
    await expect(page.getByTestId("tailscale-connection-status")).toHaveText("Needs sign-in");
    await page.getByTestId("tailscale-connection-open").click();

    await expect(page.getByTestId("tailscale-login-screen")).toBeVisible();
    await expect(page.getByText("Join your tailnet", { exact: true })).toBeVisible();
    await expect(page.getByTestId("tailscale-login-interactive")).toBeVisible();
    await expect(page.getByTestId("tailscale-login-authkey-input")).toBeVisible();
    await expect(page.getByTestId("tailscale-login-back-to-overview")).toBeVisible();

    await page.getByTestId("tailscale-login-back-to-overview").click();
    await expectAppRoute(page, buildSettingsHostSectionRoute(serverId, "host"));
    await expect(page.getByTestId("tailscale-connection-section").last()).toBeVisible();
  });

  test("opens a connection status view when Tailscale is already connected", async ({ page }) => {
    const serverId = getServerId();

    await installDesktopRuntime(page, {
      serverId,
      manageBuiltInDaemon: true,
      tailscaleConnected: true,
      tailnetAddress: "e2e.tailnet.ts.net:6768",
      daemonPublicKeyB64: "e2e-daemon-public-key",
    });
    await page.addInitScript(() => {
      localStorage.setItem("@jagentdesk:connection-mode:v3", "local");
    });

    await gotoAppShell(page);
    await openDesktopSettings(page, serverId);

    await expect(page.getByTestId("tailscale-connection-status")).toHaveText("Connected");
    await page.getByRole("button", { name: "Manage connection", exact: true }).click();

    await expect(page.getByTestId("tailscale-login-manage-card")).toBeVisible();
    await expect(
      page.getByTestId("tailscale-login-screen").getByText("Tailscale connection", { exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("tailscale-login-interactive")).toHaveCount(0);
  });
});
