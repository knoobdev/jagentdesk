import { expect, test } from "../../app/e2e/support/fixtures";
import { gotoAppShell } from "../../app/e2e/support/helpers/app";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import { buildNewWorkspaceRoute } from "../../app/src/utils/host-routes";

// Verifies the "Start with ORC" create path added for the Orchestration (ORC)
// feature: the project context-menu "Start ORC in new workspace" item routes
// through the `orc=1` new-workspace flag which pre-enables the toggle. The
// sibling "Open Orchestration" workspace-menu path funnels through the
// `orchestration` workspace-open intent -> openOnMount; the panel itself is
// covered by orchestration.spec, and the intent's hydration handling by unit
// review (a full page reload in this harness cannot re-hydrate a seeded
// workspace, so it is not exercised as an E2E here).
test.describe("Desktop ORC exposure", () => {
  test("new-workspace route with orc=1 pre-enables the Start-with-ORC toggle", async ({ page }) => {
    const serverId = getServerId();
    await gotoAppShell(page);
    // The project menu "Start ORC in new workspace" navigates here.
    await page.goto(buildNewWorkspaceRoute({ serverId, startWithOrchestration: true }));
    const toggle = page.getByTestId("new-workspace-orchestration-toggle");
    await expect(toggle).toBeVisible({ timeout: 30_000 });
    await expect(toggle).toContainText("ORC enabled");
  });
});
