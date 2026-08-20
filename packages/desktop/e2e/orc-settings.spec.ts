import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { openSettingsHostSection } from "../../app/e2e/support/helpers/settings";

// Covers the ORC settings extensions: per-role + per-route instructions fields, and adding a CUSTOM
// role type (default roles remain supervisor/lead/peer).
test.describe("Desktop ORC settings", () => {
  test("exposes per-role and per-route instruction fields", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "orchestration");
    await expect(page.getByTestId("orchestration-settings")).toBeVisible();
    // Built-in roles present, each with an instructions field.
    await expect(page.getByTestId("orchestration-role-instructions-supervisor")).toBeVisible();
    await expect(page.getByTestId("orchestration-role-instructions-peer")).toBeVisible();
    // Each semantic route exposes an instructions field.
    await expect(page.getByTestId("orchestration-route-instructions-impl")).toBeVisible();
    // The add-custom-role affordance is present.
    await expect(page.getByTestId("orchestration-add-role")).toBeVisible();
  });

  test("adds a custom role that then appears in the roles list", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "orchestration");

    await page.getByTestId("orchestration-add-role").click();
    await expect(page.getByTestId("orchestration-add-role-modal")).toBeVisible();
    await page.getByTestId("orchestration-role-name").fill("reviewer");
    // Pick an installed provider that reports models in the harness.
    await page.getByTestId("orchestration-role-provider-select").click();
    await page.getByText("Codex", { exact: true }).click();
    await page.getByTestId("orchestration-role-model-select").click();
    await page.getByText("GPT-5.6-Luna", { exact: true }).click();
    await page.getByTestId("orchestration-role-save").click();

    // The new custom role row + its instructions field appear.
    await expect(page.getByTestId("orchestration-role-instructions-reviewer")).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("orchestration-remove-role-reviewer")).toBeVisible();
  });
});
