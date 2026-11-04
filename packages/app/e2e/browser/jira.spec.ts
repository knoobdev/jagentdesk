import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { getServerId } from "../support/helpers/server-id";
import {
  FakeJiraServer,
  LARGE_BOARD,
  RICH_COMMENT,
} from "../../../server/src/server/jira/test-support/fake-jira-server";

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

    // The Jira section owns the left column: connections, projects → boards, Your work/Search/Filters.
    const column = page.getByTestId("sidebar-jira-nav-panel");
    await expect(column).toBeVisible();
    await expect(page.getByText("No projects yet")).toHaveCount(0);
    await expect(column.getByTestId(`jira-nav-connection-${connectionId}`)).toBeVisible();
    await expect(column.getByTestId("jira-nav-work")).toBeVisible();
    await column.getByTestId("jira-nav-board-1").click();
    await expect(page.getByTestId("jira-card-ABC-3")).toBeVisible({ timeout: 30_000 });
    await expect(column.getByTestId("jira-nav-board-1")).toHaveAttribute("data-active", "true");
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

    await column.getByTestId("jira-nav-work").click();
    await expect(page.getByTestId("jira-row-ABC-6").first()).toBeVisible({ timeout: 30_000 });
    await expect(column.getByTestId("jira-nav-work")).toHaveAttribute("data-active", "true");
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
    await expect(page.getByTestId("sidebar-jira-nav-panel")).toHaveCount(0);
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

function scrollToEndCountingCards(el: Element): number {
  el.scrollTop = el.scrollHeight;
  return el.querySelectorAll('[data-testid^="jira-card-BIG-"]').length;
}

// v0.9.49 owner report: a 1 200-issue Kanban board stopped at 500 with a red banner and did not
// scroll; comment smart links rendered as `<https: …>`; inline images and attachments did not load.
test.describe("Jira large board and rich text", () => {
  test.setTimeout(180_000);
  let fake: FakeJiraServer;
  let client: JiraSeedClient;
  let connectionId: string;

  test.beforeEach(async ({ page }) => {
    fake = new FakeJiraServer({ deployment: "cloud", largeBoard: true });
    await fake.start();
    client = await connectDaemonClient<JiraSeedClient>({ clientIdPrefix: "jira-large" });
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
    // Links open outside the app; answer them locally instead of resolving the .test hosts.
    await page
      .context()
      .route(/^https:\/\/[a-z.]+\.app\.test\//, (route) =>
        route.fulfill({ status: 200, contentType: "text/plain", body: "opened" }),
      );
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

  async function scrollState(page: Page, testId: string) {
    return page.getByTestId(testId).evaluate((el) => ({
      top: el.scrollTop,
      left: el.scrollLeft,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
  }

  async function expectBoardScrolls(page: Page, label: string) {
    // Horizontal: the board is wider than the view and moves with a horizontal wheel.
    const before = await scrollState(page, "jira-board");
    expect(before.scrollWidth).toBeGreaterThan(before.clientWidth);
    await page.getByTestId("jira-column-header-0").hover();
    await page.mouse.wheel(600, 0);
    await expect
      .poll(async () => (await scrollState(page, "jira-board")).left, { timeout: 5_000 })
      .toBeGreaterThan(0);
    await shot(page, `${label}-scrolled-right`);
    await page.getByTestId("jira-board").evaluate((el) => el.scrollTo({ left: 0 }));
    await expect.poll(async () => (await scrollState(page, "jira-board")).left).toBe(0);

    // Vertical: each column scrolls on its own.
    const list = await scrollState(page, "jira-column-list-0");
    expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
    await page.getByTestId("jira-column-list-0").hover();
    await page.mouse.wheel(0, 1500);
    await expect
      .poll(async () => (await scrollState(page, "jira-column-list-0")).top, { timeout: 5_000 })
      .toBeGreaterThan(0);
    expect((await scrollState(page, "jira-column-list-1")).top).toBe(0);
    await shot(page, `${label}-column-scrolled`);
  }

  test("desktop: all 1 200 issues load and the board scrolls both ways", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(jiraUrl({ view: "board", board: String(LARGE_BOARD.id) }));
    await expect(page.getByTestId("jira-card-BIG-1")).toBeVisible({ timeout: 60_000 });
    const expected = ["TO DO 150", "IN PROGRESS 100", "IN REVIEW 150", "DONE 800"];
    for (const [index, text] of expected.entries()) {
      await expect(page.getByTestId(`jira-column-header-${index}`)).toContainText(text);
    }
    const total = Object.values(LARGE_BOARD.columns).reduce((a, b) => a + b, 0);
    expect(total).toBe(LARGE_BOARD.visible);
    await expect(page.getByTestId("jira-error")).toHaveCount(0);
    await expect(page.getByTestId("jira-board-truncated")).toHaveCount(0);
    await shot(page, "large-board-desktop");

    // Windowed columns: the Done column does not mount 800 cards at once.
    const mounted = await page
      .getByTestId("jira-column-3")
      .locator('[data-testid^="jira-card-BIG-"]')
      .count();
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(200);

    await expectBoardScrolls(page, "large-board-desktop");

    // The last Done card is reachable by scrolling its column to the end.
    await page.getByTestId("jira-board").evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    const done = page.getByTestId("jira-column-list-3");
    const scrollDoneToEnd = async () => {
      // Windowed: only the cards near the scroll position are mounted.
      expect(await done.evaluate(scrollToEndCountingCards)).toBeLessThan(200);
      return page.getByTestId("jira-card-BIG-1200").count();
    };
    await expect.poll(scrollDoneToEnd, { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("jira-card-BIG-1200")).toBeVisible();
    await shot(page, "large-board-desktop-done-end");
  });

  test("phone: the large board scrolls by column and within a column", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(jiraUrl({ view: "board", board: String(LARGE_BOARD.id) }));
    await expect(page.getByTestId("jira-card-BIG-1")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("jira-column-header-3")).toContainText("DONE 800");
    await shot(page, "large-board-phone");
    await expectBoardScrolls(page, "large-board-phone");
  });

  test("desktop: comment smart link is a clickable https link; media load through the daemon", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(jiraUrl({ view: "board", board: "1", issue: "ABC-4" }));
    await expect(page.getByTestId("jira-issue-view")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("jira-activity-comments").first().click();
    const comment = page.getByTestId(`jira-comment-${RICH_COMMENT.id}`);
    await expect(comment).toBeVisible({ timeout: 15_000 });
    await expect(comment).not.toContainText("<https");
    await expect(comment).not.toContainText("[attachment:");

    const link = comment.getByRole("link", { name: RICH_COMMENT.smartLink });
    await expect(link).toBeVisible();
    await expect(comment.getByRole("link", { name: RICH_COMMENT.bareUrl })).toBeVisible();

    // Inline image: bytes from jira.issue.attachments.download as a data URI, decoded.
    const inline = comment.getByTestId(`jira-rich-image-${RICH_COMMENT.image.id}`);
    await expect(inline).toBeVisible();
    const img = inline.locator("img");
    await expect(img).toHaveAttribute("src", /^data:image\/png;base64,/, { timeout: 15_000 });
    const naturalWidth = () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth);
    await expect.poll(naturalWidth).toBe(RICH_COMMENT.image.width);
    await expect(comment.getByTestId(`jira-rich-attachment-${RICH_COMMENT.file.id}`)).toBeVisible();
    await comment.scrollIntoViewIfNeeded();
    await shot(page, "rich-comment");

    // The link opens outside the app (window.open on web; the system browser in Electron).
    const popup = page.waitForEvent("popup");
    await link.click();
    expect((await popup).url()).toBe(RICH_COMMENT.smartLink);

    // Tapping the image opens the full view.
    await inline.click();
    const viewer = page.getByTestId("jira-attachment-viewer");
    await expect(viewer.locator('img[src^="data:image/png"]').first()).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, "rich-comment-image-viewer");
    await page.keyboard.press("Escape");

    // A non-image file opens the viewer with a download.
    await comment.getByTestId(`jira-rich-attachment-${RICH_COMMENT.file.id}`).click();
    await expect(page.getByText("text/plain").first()).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    // The Attachments section previews load too.
    const tile = page.getByTestId(`jira-attachment-${RICH_COMMENT.image.id}`).first();
    await tile.scrollIntoViewIfNeeded();
    await expect(tile.locator("img")).toHaveAttribute("src", /^data:image\/png;base64,/, {
      timeout: 15_000,
    });
    await shot(page, "issue-attachments");

    // Criterion 9: what the app received carries no Jira resource URL.
    const comments = await client.jiraRequest("jira.issue.comments.list.request", {
      connectionId,
      issueKey: "ABC-4",
    });
    expect(JSON.stringify(comments)).not.toMatch(/\/rest\/|\/secure\/|\/media\//);
  });
});
