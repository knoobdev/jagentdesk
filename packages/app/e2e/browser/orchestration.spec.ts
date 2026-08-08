import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { gotoWorkspace } from "../support/helpers/launcher";
import { openSettingsHostSection } from "../support/helpers/settings";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

test.describe("Orchestration", () => {
  test("host settings expose real role profiles and semantic routes", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "orchestration");

    await expect(page.getByTestId("orchestration-settings")).toBeVisible();
    await expect(page.getByTestId("orchestration-role-supervisor")).toContainText("gpt-5.6-luna");
    await expect(page.getByTestId("orchestration-role-peer")).toContainText("deepseek-v4-flash");
    await expect(page.getByTestId("orchestration-route-impl")).toContainText("opencode");
    await expect(page.getByTestId("orchestration-route-select-impl")).toBeVisible();

    await page.getByTestId("orchestration-profile-add").first().click();
    await expect(page.getByTestId("orchestration-profile-modal")).toBeVisible();
    await page.getByTestId("orchestration-profile-provider").fill("codex");
    await page.getByTestId("orchestration-profile-model").fill("gpt-5.6-sol");
    await page.getByTestId("orchestration-profile-thinking").fill("medium");
    await page.getByTestId("orchestration-profile-save").click();
    await expect(page.getByTestId("orchestration-profile-modal")).not.toBeVisible();
    await expect(page.getByTestId("orchestration-role-supervisor")).toContainText("gpt-5.6-sol");
  });

  test("workspace chat prepares a brief and asks inline when the objective is missing", async ({
    page,
  }) => {
    let workspace: SeededWorkspace | null = null;
    try {
      workspace = await seedWorkspace({ repoPrefix: "orchestration-brief-" });
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
