import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { gotoWorkspace } from "../../app/e2e/support/helpers/launcher";
import { openSettingsHostSection } from "../../app/e2e/support/helpers/settings";
import { seedWorkspace, type SeededWorkspace } from "../../app/e2e/support/helpers/seed-client";

test.describe("Desktop Orchestration", () => {
  test("renders configured role profiles and routes in the desktop shell", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "orchestration");

    await expect(page.getByTestId("orchestration-settings")).toBeVisible();
    await expect(page.getByTestId("orchestration-role-supervisor")).toContainText("gpt-5.6-luna");
    await expect(page.getByTestId("orchestration-role-peer")).toContainText("deepseek-v4-flash");
    await expect(page.getByTestId("orchestration-route-select-impl")).toBeVisible();
    await expect(page.getByTestId("orchestration-peer-limit")).toHaveText("3");
  });

  test("prepares an inline clarification in the desktop workspace panel", async ({ page }) => {
    let workspace: SeededWorkspace | null = null;
    try {
      const serverId = getServerId();
      workspace = await seedWorkspace({ repoPrefix: "desktop-orchestration-brief-" });
      await gotoAppShell(page);
      await gotoWorkspace(page, workspace.workspaceId);
      const openButton = page.getByTestId("workspace-orchestration-open");
      await expect(openButton).toBeVisible({ timeout: 30_000 });
      await openButton.click();
      await expect(page.getByTestId("workspace-orchestration-panel")).toBeVisible();
      await page.getByTestId("orchestration-request-input").fill("x");
      await page.getByTestId("orchestration-send-request").click();
      await expect(page.getByTestId("orchestration-task-brief")).toContainText(
        "needs_clarification",
      );
      await expect(page.getByTestId("orchestration-task-brief")).toContainText(
        "concrete objective",
      );
    } finally {
      await workspace?.cleanup();
    }
  });
});
