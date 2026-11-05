import { execFileSync } from "node:child_process";
import { expect, test } from "../support/fixtures";
import { openChangesPanel } from "../support/helpers/branch-switcher";
import { gotoWorkspace } from "../support/helpers/launcher";
import {
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { createTempGitRepo } from "../support/helpers/workspace";

test("Changes changes a managed worktree base and keeps the choice after reload", async ({
  page,
}) => {
  const client = await connectNewWorkspaceDaemonClient();
  const repo = await createTempGitRepo("changes-base-");
  let projectId: string | undefined;
  try {
    projectId = (await openProjectViaDaemon(client, repo.path)).projectKey;
    execFileSync("git", ["branch", "release"], { cwd: repo.path });
    const workspace = await createWorktreeViaDaemon(client, {
      cwd: repo.path,
      slug: "changes-base",
    });
    await page.setViewportSize({ width: 1400, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await openChangesPanel(page);
    const picker = page
      .getByTestId("workspace-base-branch-trigger")
      .filter({ visible: true })
      .first();
    await picker.click();
    await page.getByRole("button", { name: "release", exact: true }).click();
    await expect(picker).toContainText("release");
    await page.reload();
    await openChangesPanel(page);
    await expect(picker).toContainText("release");
  } finally {
    if (projectId) await client.removeProject(projectId);
    await client.close();
    await repo.cleanup();
  }
});
