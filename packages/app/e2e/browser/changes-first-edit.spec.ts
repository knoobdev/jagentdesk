import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { openChangesPanel as openChangesTreePanel } from "../support/helpers/branch-switcher";

function changesTree(page: Page) {
  return page.getByTestId("changes-header").filter({ visible: true }).locator("..").locator("..");
}

async function expectEmptyChanges(page: Page) {
  await expect(changesTree(page).getByText(/No uncommitted changes|No changes vs /)).toBeVisible();
}

async function editReadme(repoPath: string, text: string) {
  await appendFile(path.join(repoPath, "README.md"), text);
}

async function expectReadmeChanges(page: Page, additions: number) {
  await expect(changesTree(page).getByText("README.md", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(changesTree(page)).toContainText(`+${additions}`);
}

async function openEmptyDiff(page: Page) {
  await page.getByTestId("changes-open-tab").click();
  await expect(
    page
      .getByTestId("working-diff-panel")
      .filter({ visible: true })
      .getByTestId("working-diff-empty"),
  ).toBeVisible();
}

async function expectReadmeDiff(page: Page, additions: number) {
  const panel = page.getByTestId("working-diff-panel").filter({ visible: true });
  await expect(panel.getByTestId("diff-file-0")).toContainText("README.md", { timeout: 30_000 });
  await expect(panel.getByTestId("diff-file-0-stat")).toHaveText(`+${additions}-0`, {
    timeout: 30_000,
  });
}

async function openDiffWithoutChangesTree(page: Page) {
  // This checkout opens a full Diff tab from the Changes header. Close its tree afterwards
  // so only the full tab owns a working-tree subscription during the first edit.
  await openChangesTreePanel(page);
  await openEmptyDiff(page);
  await page.getByTestId("workspace-explorer-toggle").first().click();
  await expect(changesTree(page)).not.toBeVisible();
}

async function refreshDiff(page: Page) {
  await page
    .getByTestId("working-diff-panel")
    .filter({ visible: true })
    .getByTestId("working-diff-options-menu")
    .click();
  await page.getByTestId("working-diff-refresh").click();
}

async function reloadWorkspace(page: Page) {
  await page.reload();
}

test("Changes follows the first edit to a clean workspace without reloading", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace();
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openChangesTreePanel(page);
  await expectEmptyChanges(page);

  await editReadme(workspace.repoPath, "first edit\n");
  await expectReadmeChanges(page, 1);

  await editReadme(workspace.repoPath, "second edit\n");
  await expectReadmeChanges(page, 2);
});

test("the full diff follows the first edit to a clean workspace without reloading", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace();
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openChangesTreePanel(page);
  await expectEmptyChanges(page);
  await openEmptyDiff(page);

  await editReadme(workspace.repoPath, "first edit\n");
  await expectReadmeDiff(page, 1);

  await editReadme(workspace.repoPath, "second edit\n");
  await expectReadmeDiff(page, 2);
});

test("a directly opened Diff tab follows the first edit without an active Changes tree", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace();
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openDiffWithoutChangesTree(page);

  await editReadme(workspace.repoPath, "first edit\n");
  await expectReadmeDiff(page, 1);

  await editReadme(workspace.repoPath, "second edit\n");
  await expectReadmeDiff(page, 2);

  await refreshDiff(page);
  await expectReadmeDiff(page, 2);
  await reloadWorkspace(page);
  await expectReadmeDiff(page, 2);
  await editReadme(workspace.repoPath, "third edit\n");
  await expectReadmeDiff(page, 3);
});
