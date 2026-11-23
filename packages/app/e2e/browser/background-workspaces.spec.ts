import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { gotoAppShell } from "../support/helpers/app";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

test("Show background reveals durable workspaces without changing the sidebar shell", async ({
  page,
}) => {
  const seeded = await seedWorkspace({ repoPrefix: "background-workspace-" });
  try {
    const created = await seeded.client.createWorkspace({
      source: { kind: "directory", path: seeded.repoPath, projectId: seeded.projectId },
      title: "Background workspace",
      background: true,
    });
    expect(created.error).toBeNull();
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${created.workspace!.id}`);
    await expect(row).toHaveCount(0);
    await page
      .getByTestId("sidebar-display-preferences-menu")
      .filter({ visible: true })
      .first()
      .click();
    await page.getByTestId("sidebar-show-background").click();
    await page.keyboard.press("Escape");
    await expect(row).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();
  } finally {
    await seeded.cleanup();
  }
});
