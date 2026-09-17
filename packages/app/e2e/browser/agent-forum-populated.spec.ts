import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { createIdleAgent } from "../support/helpers/archive-tab";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";

// Real-app screenshots of Team mode (docs/plans/completed/agent-forum.md): the agent chat with the
// Team toggle, the forum topic list, and a POPULATED topic (discussion thread + kanban board). The
// board content is a representative topic written straight into the daemon's forum store, so the REAL
// app renders REAL served data (agent *behaviour* is covered by the live real-Claude e2e). Requires a
// fixed daemon home (E2E_JAGENTDESK_HOME) so the spec knows where to seed the topic.

const now = Date.now();
const DEMO_TOPIC = {
  id: "topic_demo0001",
  projectKey: "",
  title: "Build a todo web app like example.com",
  originPrompt: "Build a small todo web app: add/remove items, persist to localStorage, clean UI.",
  status: "in_progress",
  createdAt_ms: now - 600_000,
  updatedAt_ms: now,
  leadAgentId: "lead-agent",
  orchestrationRunId: null,
  participants: [
    { agentId: "user", label: "You", role: "user" },
    { agentId: "lead-agent", label: "Lead 5f3a9c2b", role: "lead" },
    { agentId: "peer-ui", label: "Peer a1b2c3d4", role: "peer" },
    { agentId: "peer-logic", label: "Peer e5f6a7b8", role: "peer" },
  ],
  messages: [
    {
      id: "m1",
      authorAgentId: "user",
      authorLabel: "You",
      role: "user",
      kind: "message",
      text: "Build a small todo web app: add/remove items, persist to localStorage, clean UI.",
      createdAt_ms: now - 600_000,
      taskRefs: [],
    },
    {
      id: "m2",
      authorAgentId: "lead-agent",
      authorLabel: "Lead 5f3a9c2b",
      role: "lead",
      kind: "proposal",
      text:
        "Plan: 1) scaffold index.html + style.css, 2) build the add/remove UI, 3) wire " +
        "localStorage persistence, 4) polish styles. I'll split this into tasks and pull in two " +
        "peers — one on UI, one on the storage logic.",
      createdAt_ms: now - 560_000,
      taskRefs: ["t1", "t2", "t3", "t4"],
    },
    {
      id: "m3",
      authorAgentId: "peer-ui",
      authorLabel: "Peer a1b2c3d4",
      role: "peer",
      kind: "status",
      text: "Claiming the UI task. index.html + the add/remove list are done; moving to review.",
      createdAt_ms: now - 300_000,
      taskRefs: ["t2"],
    },
    {
      id: "m4",
      authorAgentId: "peer-logic",
      authorLabel: "Peer e5f6a7b8",
      role: "peer",
      kind: "status",
      text: "On the localStorage persistence now — save on add/remove, hydrate on load.",
      createdAt_ms: now - 120_000,
      taskRefs: ["t3"],
    },
    {
      id: "m5",
      authorAgentId: "lead-agent",
      authorLabel: "Lead 5f3a9c2b",
      role: "lead",
      kind: "decision",
      text: "Scaffold looks good — marking it done. Once persistence lands we do the styling pass.",
      createdAt_ms: now - 60_000,
      taskRefs: ["t1"],
    },
  ],
  tasks: [
    {
      id: "t1",
      title: "Scaffold index.html + style.css",
      description: "Base page structure and stylesheet.",
      status: "done",
      assigneeAgentId: "lead-agent",
      estimate: "s",
      parentTaskId: null,
      createdBy: "lead-agent",
      createdAt_ms: now - 550_000,
      updatedAt_ms: now - 60_000,
      history: [],
    },
    {
      id: "t2",
      title: "Add / remove todo UI",
      description: "Input + button + list with delete controls.",
      status: "review",
      assigneeAgentId: "peer-ui",
      estimate: "m",
      parentTaskId: null,
      createdBy: "lead-agent",
      createdAt_ms: now - 545_000,
      updatedAt_ms: now - 300_000,
      history: [],
    },
    {
      id: "t2a",
      title: "Empty-state message",
      description: "Show a hint when there are no todos.",
      status: "todo",
      assigneeAgentId: "peer-ui",
      estimate: "xs",
      parentTaskId: "t2",
      createdBy: "peer-ui",
      createdAt_ms: now - 280_000,
      updatedAt_ms: now - 280_000,
      history: [],
    },
    {
      id: "t3",
      title: "localStorage persistence",
      description: "Save on change, hydrate on load.",
      status: "in_progress",
      assigneeAgentId: "peer-logic",
      estimate: "m",
      parentTaskId: null,
      createdBy: "lead-agent",
      createdAt_ms: now - 540_000,
      updatedAt_ms: now - 120_000,
      history: [],
    },
    {
      id: "t4",
      title: "Styling polish",
      description: "Spacing, colors, hover states.",
      status: "backlog",
      assigneeAgentId: null,
      estimate: "s",
      parentTaskId: null,
      createdBy: "lead-agent",
      createdAt_ms: now - 535_000,
      updatedAt_ms: now - 535_000,
      history: [],
    },
  ],
};

// Write the demo topic into the SAME daemon home the agent's record landed in — deterministic even
// when the harness nests worker dirs. Agent records live at `${home}/agents/{project}/{agentId}.json`,
// so the home is three levels up; the forum store is `${home}/forums`.
function seedTopicIntoAgentHome(agentId: string): void {
  const root = process.env.E2E_JAGENTDESK_HOME;
  if (!root) throw new Error("set E2E_JAGENTDESK_HOME so the spec can seed the forum topic");
  const agentFile = execSync(`find "${root}" -name "${agentId}.json" -path "*/agents/*"`, {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .find(Boolean);
  if (!agentFile) throw new Error(`agent record for ${agentId} not found under ${root}`);
  const home = dirname(dirname(dirname(agentFile)));
  const forumsDir = join(home, "forums");
  mkdirSync(forumsDir, { recursive: true });
  writeFileSync(join(forumsDir, `${DEMO_TOPIC.id}.json`), JSON.stringify(DEMO_TOPIC), "utf8");
}

test("Team mode on the real app: agent toggle + forum list + populated board", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 950 });
  const project = await seedWorkspace({ repoPrefix: "forum-demo-" });
  const serverId = getServerId();
  try {
    const agent = await createIdleAgent(project.client, {
      cwd: project.repoPath,
      workspaceId: project.workspaceId,
      title: "Todo app",
    });
    // Seed the demo topic into the daemon's real forum store now that we know its home.
    seedTopicIntoAgentHome(agent.id);

    // 1) Agent chat screen — the composer shows the Team (Users) toggle.
    await page.goto(buildHostAgentDetailRoute(serverId, agent.id, project.workspaceId));
    const teamToggle = page.locator(`[data-testid="composer-team-toggle-${agent.id}"]`).first();
    await expect(teamToggle).toBeVisible({ timeout: 60_000 });
    await page.screenshot({ path: "/tmp/share-shots/20-agent-with-team-toggle.png" });

    // 2) Team / forum screen — the seeded topic appears in the list.
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.locator('[data-testid="sidebar-agent-forum"]:visible').first().click();
    const card = page.locator(`[data-testid="forum-topic-${DEMO_TOPIC.id}"]`).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: "/tmp/share-shots/21-forum-list.png" });

    // 3) Populated topic — discussion thread + kanban board.
    await card.click();
    await expect(page.getByText("Add / remove todo UI", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("localStorage persistence", { exact: false }).first(),
    ).toBeVisible();
    await page.screenshot({ path: "/tmp/share-shots/22-forum-topic-board.png" });
  } finally {
    await project.cleanup();
  }
});
