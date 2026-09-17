import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

// Team mode / Agent Forum (docs/plans/active/agent-forum.md) must be an in-shell page reachable from
// the sidebar, exactly like Shared sessions. Drives the real host app: open the sidebar entry, land
// on the screen, and confirm the app shell (left sidebar) stays mounted.
test("Team (agent forum) is an in-shell page reachable from the sidebar", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const project = await seedWorkspace({ repoPrefix: "agent-forum-" });
  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const navEntry = page.locator('[data-testid="sidebar-agent-forum"]:visible').first();
    await expect(navEntry).toBeVisible({ timeout: 30_000 });
    await navEntry.click();

    // The screen's blurb is unique to it (the header + sidebar both say "Team").
    await expect(
      page.getByText("Turn on Team mode in an agent chat", { exact: false }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // The app shell (left sidebar) is still mounted — not a full-screen route.
    await expect(page.locator('[data-testid="sidebar-home"]:visible').first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(navEntry).toBeVisible();

    await page.screenshot({ path: "/tmp/share-shots/11-agent-forum.png" });
  } finally {
    await project.cleanup();
  }
});
