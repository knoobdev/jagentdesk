import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell, openSettings } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { openSettingsHostSection } from "../../app/e2e/support/helpers/settings";
import { buildNewWorkspaceRoute } from "../../app/src/utils/host-routes";

// Covers the ORC settings extensions: per-role + per-route instructions fields (pre-filled with the
// default instruction text), adding a CUSTOM role type, and the new-workspace "Open Orchestration" button.
test.describe("Desktop ORC settings", () => {
  test("instruction fields are pre-filled with the default instructions", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "orchestration");
    await expect(page.getByTestId("orchestration-settings")).toBeVisible();
    // The Supervisor instructions field shows the DEFAULT text, not an empty box.
    await expect(page.getByTestId("orchestration-role-instructions-supervisor")).toHaveValue(
      /Supervisor/,
    );
    await expect(page.getByTestId("orchestration-role-instructions-peer")).toHaveValue(/Peer/);
    // Each semantic route exposes a pre-filled instructions field.
    await expect(page.getByTestId("orchestration-route-instructions-impl")).toHaveValue(/\w+/);
    // The add-custom-role affordance is present.
    await expect(page.getByTestId("orchestration-add-role")).toBeVisible();
  });

  test("new-workspace screen offers an Open Orchestration button", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    await page.goto(buildNewWorkspaceRoute({ serverId }));
    await expect(page.getByTestId("new-workspace-open-orchestration")).toBeVisible();
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
