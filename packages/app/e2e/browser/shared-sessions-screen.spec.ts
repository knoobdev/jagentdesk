import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// The global "Shared sessions" management page (ADR-0019) must live INSIDE the app shell — reachable
// from the left sidebar, with the standard MenuHeader and back navigation — not a full-screen locked
// route with no way out (the regression the user hit). This drives the real host app: open the
// sidebar entry, land on the screen, and confirm the shell chrome (sidebar + header) is still there.
test("Shared sessions is an in-shell page reachable from the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const project = await seedWorkspace({ repoPrefix: "shared-sessions-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const navEntry = page.locator('[data-testid="sidebar-shared-sessions"]:visible').first();
    await expect(navEntry).toBeVisible({ timeout: 30_000 });
    await navEntry.click();

    // The screen renders with its MenuHeader title (visible header instance, not the sidebar label).
    const header = page.getByText("Shared sessions", { exact: true }).locator("visible=true");
    await expect(header.first()).toBeVisible({ timeout: 30_000 });

    // The app chrome (left sidebar) MUST still be mounted on this route, exactly like /sessions and
    // /schedules — the reported regression was a full-screen page with no sidebar and no way back.
    // The sidebar's own Home/Settings entries prove the shell (and thus navigation away) is present.
    await expect(page.locator('[data-testid="sidebar-home"]:visible').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('[data-testid="sidebar-settings"]:visible').first()).toBeVisible();
    // The just-clicked entry stays visible in the sidebar (still highlighted as the active route).
    await expect(navEntry).toBeVisible();

    await page.screenshot({ path: "/tmp/share-shots/10-host-shared-sessions.png" });
  } finally {
    await project.cleanup();
  }
});
