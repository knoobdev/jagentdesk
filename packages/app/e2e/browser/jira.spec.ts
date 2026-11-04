import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import { FakeJiraServer } from "../../../server/src/server/jira/test-support/fake-jira-server";

// Jira (spec 29) against the real e2e daemon and a fake Jira Cloud site speaking the documented
// REST v3 / Software API shapes (test-support only). Desktop and phone viewports.
// Screenshots go to JAD_JIRA_SHOTS when set.

const SHOTS = process.env.JAD_JIRA_SHOTS ?? null;

interface JiraSeedClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  jiraRequest(
    type: string,
    params: Record<string, unknown>,
  ): Promise<{ error: { message: string } | null; connection?: { id: string } | null }>;
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test.describe("Jira", () => {
  test.setTimeout(120_000);
  let fake: FakeJiraServer;
  let client: JiraSeedClient;
  let connectionId: string;

  test.beforeEach(async () => {
    fake = new FakeJiraServer({ deployment: "cloud" });
    await fake.start();
    client = await connectDaemonClient<JiraSeedClient>({ clientIdPrefix: "jira-ui" });
    const added = await client.jiraRequest("jira.connections.add.request", {
      deployment: "cloud",
      siteUrl: fake.baseUrl,
      method: "api_token",
      email: "admin@jira.test",
      token: fake.apiToken,
      label: "fake-site",
    });
    if (!added.connection) throw new Error(added.error?.message ?? "connection failed");
    connectionId = added.connection.id;
  });

  test.afterEach(async () => {
    await client.jiraRequest("jira.connections.remove.request", { connectionId });
    await client.close();
    await fake.stop();
  });

  function jiraUrl(params: Record<string, string>): string {
    const query = new URLSearchParams({ c: connectionId, ...params }).toString();
    return `/h/${encodeURIComponent(getServerId())}/jira?${query}`;
  }

  test("desktop: projects, board, backlog, issue; Move to transitions; web change shows up", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(jiraUrl({ view: "projects" }));
    await expect(page.getByTestId("jira-project-ABC")).toBeVisible({ timeout: 30_000 });
    await shot(page, "desktop-projects");

    await page.getByTestId("jira-board-1").first().click();
    await expect(page.getByTestId("jira-card-ABC-3")).toBeVisible({ timeout: 30_000 });
    await shot(page, "desktop-board");

    // Criterion 4 through the menu path: To Do → In Progress.
    await page.getByTestId("jira-card-move-ABC-3").click();
    await page.getByTestId("jira-move-to-1").click();
    await expect.poll(() => fake.issues.get("ABC-3")?.statusId, { timeout: 15_000 }).toBe("3");
    await expect(page.getByTestId("jira-column-1").getByTestId("jira-card-ABC-3")).toBeVisible({
      timeout: 15_000,
    });

    // A transition with a required field asks for it.
    await page.getByTestId("jira-card-move-ABC-6").click();
    await page.getByTestId("jira-move-to-3").click();
    await expect(page.getByText("Resolution").first()).toBeVisible({ timeout: 15_000 });
    await shot(page, "desktop-transition-required-field");
    await page.keyboard.press("Escape");

    // Criterion 5: someone changes an issue on the web while the board is open.
    fake.webTransition("ABC-7", "4");
    await expect(page.getByTestId("jira-column-2").getByTestId("jira-card-ABC-7")).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId("jira-card-ABC-2").click();
    await expect(page.getByTestId("jira-issue-view")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("The expiry field accepts past dates.").first()).toBeVisible();
    await expect(page.getByTestId("jira-attachment-30001").first()).toBeVisible();
    await shot(page, "desktop-issue");
    await page.getByTestId("jira-activity-comments").first().click();
    await expect(page.getByText("Repro on the staging build.").first()).toBeVisible();
    await shot(page, "desktop-issue-activity");
    await page.getByTestId("jira-issue-close").first().click();

    await page.goto(jiraUrl({ view: "backlog", board: "1" }));
    await expect(page.getByTestId("jira-backlog-row-ABC-9")).toBeVisible({ timeout: 30_000 });
    await shot(page, "desktop-backlog");

    await page.goto(jiraUrl({ view: "work" }));
    await expect(page.getByTestId("jira-row-ABC-6").first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "desktop-your-work");
  });

  test("desktop: add connection sheet shows the OAuth guide", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(jiraUrl({ view: "connections" }));
    await expect(page.getByTestId(`jira-connection-${connectionId}`)).toBeVisible({
      timeout: 30_000,
    });
    await shot(page, "desktop-connections");
    await page.getByTestId("jira-add-connection-open").click();
    await page.getByTestId("jira-method-oauth").click();
    await expect(page.getByTestId("jira-oauth-guide")).toBeVisible();
    await shot(page, "desktop-add-connection-oauth");
  });

  test("phone: board scrolls by column, Move to changes the column, issue has Activity", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(jiraUrl({ view: "board", board: "1" }));
    await expect(page.getByTestId("jira-card-ABC-6")).toBeVisible({ timeout: 30_000 });
    await shot(page, "phone-board");
    await page.getByTestId("jira-card-move-ABC-6").click();
    await shot(page, "phone-move-to");
    await page.getByTestId("jira-move-to-1").click();
    await expect.poll(() => fake.issues.get("ABC-6")?.statusId, { timeout: 15_000 }).toBe("3");
    await page.getByTestId("jira-card-ABC-2").click();
    await expect(page.getByTestId("jira-issue-view")).toBeVisible({ timeout: 15_000 });
    await shot(page, "phone-issue");
    await page.getByTestId("jira-activity-worklog").first().click();
    await shot(page, "phone-issue-worklog");
    await page.getByTestId("jira-activity-history").first().click();
    await shot(page, "phone-issue-history");
    await page.goto(jiraUrl({ view: "backlog", board: "1" }));
    await expect(page.getByTestId("jira-backlog-row-ABC-9")).toBeVisible({ timeout: 30_000 });
    await shot(page, "phone-backlog");
  });
});
