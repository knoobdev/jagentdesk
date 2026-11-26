import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "../support/fixtures";
import { seedWorkspace, type SeedDaemonClient } from "../support/helpers/seed-client";
import {
  closeWorkspaceAgentTab,
  expectWorkspaceTabHidden,
  expectWorkspaceTabVisible,
  fetchAgentArchivedAt,
} from "../support/helpers/archive-tab";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

// Closing the last tab leaves the workspace with one "New Agent" draft that shows a composer.
// v0.11.0 could stack several blank drafts there, most visibly in a bot's home workspace.

const DRAFT_TAB_SELECTOR = '[data-testid^="workspace-tab-draft_"]';

interface BotsSeedClient {
  botsRequest(
    type: "bots.create.request",
    payload: {
      bot: {
        slug: string;
        name: string;
        provider: string;
        model: string;
        modeId: string;
      };
    },
  ): Promise<{ bot: { id: string } }>;
  botsRequest(
    type: "bots.chat.send.request",
    payload: { botId: string; text: string },
  ): Promise<unknown>;
  botsRequest(
    type: "bots.list.request",
    payload: object,
  ): Promise<{
    bots: Array<{ id: string; agentId?: string }>;
  }>;
  botsRequest(type: "bots.delete.request", payload: { botId: string }): Promise<unknown>;
}

async function readBotSupervisorId(bots: BotsSeedClient, botId: string): Promise<string | null> {
  const listed = await bots.botsRequest("bots.list.request", {});
  return listed.bots.find((entry) => entry.id === botId)?.agentId ?? null;
}

/** The bot creates its Supervisor in its home workspace when it handles its first message. */
async function waitForBotSupervisor(bots: BotsSeedClient, botId: string): Promise<string> {
  await expect.poll(() => readBotSupervisorId(bots, botId), { timeout: 60_000 }).not.toBeNull();
  return (await readBotSupervisorId(bots, botId)) as string;
}

async function createIdleMockAgent(
  client: SeedDaemonClient,
  input: { cwd: string; workspaceId: string; title: string },
): Promise<{ id: string; workspaceId: string }> {
  const created = await client.createAgent({
    provider: "mock",
    model: "ten-second-stream",
    modeId: "load-test",
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    title: input.title,
  });
  await client.waitForAgentUpsert(created.id, (agent) => agent.status === "idle", 30_000);
  return { id: created.id, workspaceId: input.workspaceId };
}

function visibleDraftTabs(page: Page) {
  return page.locator(DRAFT_TAB_SELECTOR).filter({ visible: true });
}

async function openAgentTab(page: Page, agent: { id: string; workspaceId: string }) {
  await openAgentRoute(page, { workspaceId: agent.workspaceId, agentId: agent.id });
  await waitForWorkspaceTabsVisible(page);
  await expectWorkspaceTabVisible(page, agent.id);
}

/** Exactly one draft tab, it is the one shown, and it renders the composer. */
async function expectSingleDraftWithComposer(page: Page) {
  await expect(visibleDraftTabs(page)).toHaveCount(1, { timeout: 30_000 });
  await expect(
    page.getByRole("textbox", { name: "Message agent..." }).filter({ visible: true }).first(),
  ).toBeVisible({ timeout: 30_000 });
}

/** Re-check after the async archive and every later agent/terminal update has landed. */
async function expectDraftCountStable(page: Page, count: number) {
  for (let sample = 0; sample < 10; sample += 1) {
    await expect(visibleDraftTabs(page)).toHaveCount(count);
    await page.waitForTimeout(300);
  }
}

test.describe("Closing workspace tabs", () => {
  test.describe.configure({ timeout: 240_000 });

  test("closing the last agent tab leaves one draft with a composer", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "close-last-tab-" });
    try {
      const agent = await createIdleMockAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `last-tab-${randomUUID().slice(0, 8)}`,
      });
      await openAgentTab(page, agent);
      await expect(visibleDraftTabs(page)).toHaveCount(0);

      await closeWorkspaceAgentTab(page, agent.id);
      await expect
        .poll(() => fetchAgentArchivedAt(workspace.client, agent.id), { timeout: 30_000 })
        .not.toBeNull();

      await expectSingleDraftWithComposer(page);
      await expectDraftCountStable(page, 1);
    } finally {
      await workspace.cleanup();
    }
  });

  test("closing a tab that is not the last one opens no draft", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "close-non-last-tab-" });
    try {
      const closed = await createIdleMockAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `closed-${randomUUID().slice(0, 8)}`,
      });
      const kept = await createIdleMockAgent(workspace.client, {
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: `kept-${randomUUID().slice(0, 8)}`,
      });
      await openAgentTab(page, kept);
      await openAgentTab(page, closed);

      await closeWorkspaceAgentTab(page, closed.id);
      await expect
        .poll(() => fetchAgentArchivedAt(workspace.client, closed.id), { timeout: 30_000 })
        .not.toBeNull();

      await expectWorkspaceTabVisible(page, kept.id);
      await expectDraftCountStable(page, 0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("closing the bot agent tab in a bot home workspace leaves one draft with a composer", async ({
    page,
    e2eWorkerClient,
  }) => {
    const bots = e2eWorkerClient as unknown as BotsSeedClient;
    const slug = `tabfix-${randomUUID().slice(0, 8)}`;
    const { bot } = await bots.botsRequest("bots.create.request", {
      bot: { slug, name: slug, provider: "mock", model: "ten-second-stream", modeId: "load-test" },
    });
    let homeWorkspaceId: string | null = null;
    try {
      await bots.botsRequest("bots.chat.send.request", { botId: bot.id, text: "hello" });
      const supervisorId = await waitForBotSupervisor(bots, bot.id);
      await e2eWorkerClient.waitForAgentUpsert(
        supervisorId,
        (agent) => agent.status === "idle",
        60_000,
      );
      const listed = await e2eWorkerClient.fetchAgents({ scope: "active" });
      const supervisor = listed.entries.find((entry) => entry.agent.id === supervisorId)?.agent;
      expect(supervisor?.workspaceId).toBeTruthy();
      homeWorkspaceId = supervisor?.workspaceId as string;

      await openAgentTab(page, { id: supervisorId, workspaceId: homeWorkspaceId });
      await expect(visibleDraftTabs(page)).toHaveCount(0);

      // The bot home is an ORC workspace: its WORKSPACE AGENTS column lists the Supervisor.
      // Opening the Supervisor from there must reuse the mounted workspace screen.
      const supervisorRow = page
        .getByTestId("orchestration-agent-row")
        .filter({ visible: true })
        .first();
      for (let click = 0; click < 3; click += 1) {
        await expect(supervisorRow).toBeVisible({ timeout: 30_000 });
        await supervisorRow.click();
        await expectWorkspaceTabVisible(page, supervisorId);
      }

      // Close with the keyboard: every mounted workspace screen handles the shortcut, which is how
      // v0.11.0 ended up with one draft per stacked screen.
      await page
        .getByTestId(`workspace-tab-agent_${supervisorId}`)
        .filter({ visible: true })
        .first()
        .click();
      await page.keyboard.press("Alt+Shift+W");
      await expectWorkspaceTabHidden(page, supervisorId);
      await expect
        .poll(() => fetchAgentArchivedAt(e2eWorkerClient, supervisorId), { timeout: 30_000 })
        .not.toBeNull();

      await expectSingleDraftWithComposer(page);
      await expectDraftCountStable(page, 1);
      await expect(
        page.getByTestId(`workspace-deck-entry-${getServerId()}:${homeWorkspaceId}`),
      ).toHaveCount(1);
    } finally {
      await bots.botsRequest("bots.delete.request", { botId: bot.id }).catch(() => undefined);
      // The bot's home is registered as a project the first time the bot runs.
      const home = (await e2eWorkerClient.fetchWorkspaces()).entries.find(
        (entry) => entry.id === homeWorkspaceId,
      );
      if (home) await e2eWorkerClient.removeProject(home.projectId).catch(() => undefined);
    }
  });
});
