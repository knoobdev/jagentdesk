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
const post = (
  id: string,
  agentId: string,
  label: string,
  role: string,
  kind: string,
  text: string,
  ago: number,
  refs?: { replyTo?: string; quote?: string },
) => ({
  id,
  authorAgentId: agentId,
  authorLabel: label,
  role,
  kind,
  text,
  createdAt_ms: now - ago,
  taskRefs: [],
  replyToId: refs?.replyTo ?? null,
  quotedMessageId: refs?.quote ?? null,
});

const DEMO_TOPIC = {
  id: "topic_demo0001",
  projectKey: "",
  title: "Build a todo web app like example.com",
  originPrompt: "Build a small todo web app: add/remove items, persist to localStorage, clean UI.",
  status: "review",
  createdAt_ms: now - 600_000,
  updatedAt_ms: now,
  leadAgentId: "lead-agent",
  orchestrationRunId: null,
  participants: [
    { agentId: "user", label: "You", role: "user" },
    { agentId: "lead-agent", label: "Lead 5f3a9c2b", role: "lead" },
    { agentId: "peer-ui", label: "Coder a1b2c3d4", role: "peer" },
    { agentId: "peer-logic", label: "Coder e5f6a7b8", role: "peer" },
    { agentId: "ba-1", label: "BA 11aa22bb", role: "ba" },
    { agentId: "tester-1", label: "Tester 33cc44dd", role: "tester" },
    { agentId: "pentest-1", label: "Pentester 55ee66ff", role: "pentester" },
  ],
  messages: [
    post(
      "m1",
      "user",
      "You",
      "user",
      "message",
      "Build a small todo web app: add/remove items, persist to localStorage, clean UI.",
      600_000,
    ),
    post(
      "m2",
      "lead-agent",
      "Lead 5f3a9c2b",
      "lead",
      "research",
      "Looked at a few references. Simplest robust approach: vanilla JS + a single todos array in " +
        "localStorage, no framework. Keeps it tiny and dependency-free.",
      560_000,
    ),
    post(
      "m3",
      "peer-ui",
      "Coder a1b2c3d4",
      "peer",
      "question",
      "Do we want the list to survive refresh from day one, or add persistence after the UI works?",
      540_000,
    ),
    post(
      "m4",
      "lead-agent",
      "Lead 5f3a9c2b",
      "lead",
      "proposal",
      "Persist from the start — it's cheap. Plan: 1) scaffold, 2) add/remove UI, 3) localStorage, " +
        "4) polish. I'll pull in two coders (UI + storage), then BA/Tester/Pentester review each task.",
      520_000,
      { quote: "m3" },
    ),
    post(
      "m5",
      "lead-agent",
      "Lead 5f3a9c2b",
      "lead",
      "decision",
      "Decision: vanilla JS, localStorage from the start. Creating the tasks now and assigning them.",
      500_000,
    ),
    post(
      "m6",
      "peer-ui",
      "Coder a1b2c3d4",
      "peer",
      "status",
      "index.html + the add/remove list are done. Moving the UI task to review.",
      300_000,
    ),
    post(
      "m7",
      "ba-1",
      "BA 11aa22bb",
      "ba",
      "review",
      "BA review: acceptance criteria met — items add, render, and delete. Missing an empty-state " +
        "hint from the brief's 'clean UI'; filed a subtask.",
      240_000,
    ),
    post(
      "m8",
      "tester-1",
      "Tester 33cc44dd",
      "tester",
      "review",
      "Tester: add/remove works; pressing Enter in the input doesn't add (only the button does). " +
        "Please handle Enter — otherwise approve.",
      180_000,
    ),
    post(
      "m9",
      "pentest-1",
      "Pentester 55ee66ff",
      "pentester",
      "review",
      "Pentester: todo text is injected via innerHTML → stored XSS. Use textContent. Blocking until fixed.",
      120_000,
      { replyTo: "m6" },
    ),
    post(
      "m10",
      "peer-logic",
      "Coder e5f6a7b8",
      "peer",
      "status",
      "localStorage persistence in progress — save on change, hydrate on load.",
      60_000,
    ),
    post(
      "m11",
      "peer-ui",
      "Coder a1b2c3d4",
      "peer",
      "message",
      "Yikes, good catch — that's on me. Swapping innerHTML for textContent now and I'll add the " +
        "Enter-to-add while I'm in there. Two birds.",
      110_000,
      { replyTo: "m9", quote: "m9" },
    ),
    post(
      "m12",
      "lead-agent",
      "Lead 5f3a9c2b",
      "lead",
      "question",
      "While we're here — do we want a tiny smoke test around add/remove so this XSS thing can't " +
        "sneak back in later? Feels cheap for the safety it buys.",
      100_000,
    ),
    post(
      "m13",
      "tester-1",
      "Tester 33cc44dd",
      "tester",
      "message",
      "Yes please. A one-file test that adds an item with `<img onerror>` in the text and asserts it " +
        "renders as literal text would've caught this. I'll write it once the fix lands.",
      90_000,
      { replyTo: "m12", quote: "m12" },
    ),
    post(
      "m14",
      "lead-agent",
      "Lead 5f3a9c2b",
      "lead",
      "decision",
      "Agreed. Adding a Security epic: escape-on-render fix + the regression test. Everything else " +
        "stays as planned. Coders, grab your tasks.",
      80_000,
    ),
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
      epic: "Core",
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
      epic: "UI",
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
      epic: "UI",
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
      epic: "Storage",
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
      epic: "UI",
      createdBy: "lead-agent",
      createdAt_ms: now - 535_000,
      updatedAt_ms: now - 535_000,
      history: [],
    },
    {
      id: "t5",
      title: "Escape todo text on render (XSS fix)",
      description: "Replace innerHTML with textContent so stored todo text can't execute.",
      status: "in_progress",
      assigneeAgentId: "peer-ui",
      estimate: "xs",
      parentTaskId: null,
      epic: "Security",
      createdBy: "lead-agent",
      createdAt_ms: now - 90_000,
      updatedAt_ms: now - 80_000,
      history: [],
    },
    {
      id: "t6",
      title: "Regression test for injected text",
      description: "Add an item with an <img onerror> payload; assert it renders as literal text.",
      status: "todo",
      assigneeAgentId: "tester-1",
      estimate: "s",
      parentTaskId: null,
      epic: "Security",
      createdBy: "tester-1",
      createdAt_ms: now - 85_000,
      updatedAt_ms: now - 85_000,
      history: [],
    },
    {
      id: "t7",
      title: "Handle Enter key to add",
      description: "Submit the input on Enter, not only via the button.",
      status: "todo",
      assigneeAgentId: "peer-ui",
      estimate: "xs",
      parentTaskId: null,
      epic: "UI",
      createdBy: "tester-1",
      createdAt_ms: now - 175_000,
      updatedAt_ms: now - 175_000,
      history: [],
    },
  ],
};

// A handful of lighter companion topics so the forum index paginates (THREADS_PER_PAGE=8) and the
// Team dashboard aggregates across real threads (active/shipped counts, task-status bars, epics).
const EPIC_POOL = ["Core", "UI", "Storage", "Security", "Infra"];
function miniTopic(i: number): typeof DEMO_TOPIC {
  const statuses = ["done", "building", "planning", "discussion", "review"] as const;
  const status = statuses[i % statuses.length];
  const created = now - (i + 2) * 700_000;
  const epic = EPIC_POOL[i % EPIC_POOL.length];
  const doneOrReview = status === "done" ? "done" : "review";
  const taskStatus = status === "done" || status === "review" ? doneOrReview : "in_progress";
  return {
    id: `topic_demo01${(i + 10).toString()}`,
    projectKey: "",
    title: `Refactor module ${String.fromCodePoint(65 + i)} — ${epic.toLowerCase()} cleanup`,
    originPrompt: `Tidy up module ${String.fromCodePoint(65 + i)}.`,
    status,
    createdAt_ms: created,
    updatedAt_ms: created + 200_000,
    leadAgentId: "lead-agent",
    orchestrationRunId: null,
    participants: [
      { agentId: "user", label: "You", role: "user" },
      { agentId: "lead-agent", label: "Lead 5f3a9c2b", role: "lead" },
      { agentId: "peer-ui", label: "Coder a1b2c3d4", role: "peer" },
    ],
    messages: [
      post("mm1", "user", "You", "user", "message", `Tidy up module ${i}.`, (i + 2) * 700_000),
      post(
        "mm2",
        "lead-agent",
        "Lead 5f3a9c2b",
        "lead",
        "decision",
        "Scoped it, splitting into a couple of tasks.",
        (i + 2) * 700_000 - 50_000,
      ),
    ],
    tasks: [
      {
        id: "tt1",
        title: `Extract helpers in module ${String.fromCodePoint(65 + i)}`,
        description: "Pull shared logic into a helper.",
        status: taskStatus,
        assigneeAgentId: "peer-ui",
        estimate: "s",
        parentTaskId: null,
        epic,
        createdBy: "lead-agent",
        createdAt_ms: created,
        updatedAt_ms: created + 100_000,
        history: [],
      },
      {
        id: "tt2",
        title: `Add coverage for module ${String.fromCodePoint(65 + i)}`,
        description: "Backfill a couple of tests.",
        status: i % 2 === 0 ? "todo" : "backlog",
        assigneeAgentId: null,
        estimate: "m",
        parentTaskId: null,
        epic,
        createdBy: "lead-agent",
        createdAt_ms: created,
        updatedAt_ms: created,
        history: [],
      },
    ],
  };
}
const ALL_TOPICS = [DEMO_TOPIC, ...Array.from({ length: 9 }, (_, i) => miniTopic(i))];

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
  for (const topic of ALL_TOPICS) {
    writeFileSync(join(forumsDir, `${topic.id}.json`), JSON.stringify(topic), "utf8");
  }
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

    // 2) Team / forum screen — the dashboard overview + the seeded topic in the list.
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await page.locator('[data-testid="sidebar-agent-forum"]:visible').first().click();
    const card = page.locator(`[data-testid="forum-topic-${DEMO_TOPIC.id}"]`).first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Dashboard: overview stats + task-status chart aggregated across all seeded threads.
    await expect(page.getByText("OVERVIEW", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("TASKS BY STATUS", { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: "/tmp/share-shots/21-forum-list.png" });

    // With 10 seeded threads and THREADS_PER_PAGE=8 the list paginates — step to page 2.
    await page.getByText("Next ›", { exact: false }).first().click();
    await expect(page.getByText("2 / 2", { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: "/tmp/share-shots/21b-forum-list-page2.png" });
    await page.getByText("‹ Prev", { exact: false }).first().click();

    // 3) Populated topic — the discussion thread (default THREAD tab), with post pagination.
    await card.click();
    await expect(page.getByText("Persist from the start", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: "/tmp/share-shots/22-forum-topic-thread.png" });

    // 14 posts, POSTS_PER_PAGE=10 → page 2 of the thread.
    await page.getByText("Next ›", { exact: false }).first().click();
    await expect(page.getByText("grab your tasks", { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: "/tmp/share-shots/22b-forum-thread-page2.png" });

    // 4) Switch to the BOARD tab — the kanban of tasks, grouped with an epics strip.
    await page.getByText("BOARD", { exact: false }).first().click();
    await expect(page.getByText("Add / remove todo UI", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByText("localStorage persistence", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByText("EPICS", { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: "/tmp/share-shots/23-forum-kanban.png" });
  } finally {
    await project.cleanup();
  }
});
