import { execFileSync } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { openChangesPanel } from "../support/helpers/branch-switcher";

test("All changes includes committed and uncommitted edits and retains a manual scope", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace();
  const cwd = workspace.repoPath;
  execFileSync("git", ["checkout", "-b", "feature/all-changes"], { cwd });
  await writeFile(path.join(cwd, "committed.txt"), "committed change\n");
  execFileSync("git", ["add", "committed.txt"], { cwd });
  execFileSync("git", ["commit", "-m", "Add committed change"], { cwd });
  await writeFile(path.join(cwd, "uncommitted.txt"), "uncommitted change\n");
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openChangesPanel(page);
  await expect(page.getByTestId("workspace-base-branch-trigger")).toHaveCount(0);
  const trigger = page.getByTestId("changes-diff-status-trigger").filter({ visible: true }).first();
  await expect(trigger).toContainText("All changes");
  await expect(page.getByText("committed.txt", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("uncommitted.txt", { exact: true }).first()).toBeVisible();
  await trigger.click();
  await page.getByTestId("changes-diff-mode-uncommitted").click();
  await expect(trigger).toContainText("Uncommitted");
  await expect(page.getByText("committed.txt", { exact: true })).toHaveCount(0);
  await unlink(path.join(cwd, "uncommitted.txt"));
  await expect(page.getByText("uncommitted.txt", { exact: true })).toHaveCount(0);
  await expect(trigger).toContainText("Uncommitted");
});
