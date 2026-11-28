import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { runGitCommand } from "../../utils/run-git-command.js";
import {
  createTestJAgentDeskDaemon,
  type TestJAgentDeskDaemon,
} from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createBotsTestProvider } from "./test-utils/provider.js";

// A bot's tree (Home Chat and the workers it started) is what keeps worker worktrees under the
// bot in the sidebar. After a restart, agents load on demand, so the tree must come from the
// stored agents too (user report 2026-11-28: the worker's project showed up with no workspace).
const dirs: string[] = [];
let daemon: TestJAgentDeskDaemon | undefined;
let client: DaemonClient | undefined;
afterEach(async () => {
  await client?.close();
  await daemon?.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start(homeRoot: string, provider: ReturnType<typeof createBotsTestProvider>) {
  daemon = await createTestJAgentDeskDaemon({
    agentClients: { ...createTestAgentClients(), claude: provider.client },
    botsTriggerSource: { poll: async () => [] },
    jagentdeskHomeRoot: homeRoot,
    cleanup: false,
  });
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.12.2" });
  await client.connect();
}

test("the bot's chat tree keeps Home Chat and its worker after a daemon restart", async () => {
  const repo = await mkdtemp(join(tmpdir(), "bot-tree-repo-"));
  const homeRoot = await mkdtemp(join(tmpdir(), "bot-tree-home-"));
  dirs.push(repo, homeRoot);
  await writeFile(join(repo, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(join(repo, "sum.js"), "export const sum = (a,b) => a - b;\n");
  await writeFile(
    join(repo, "sum.test.js"),
    "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { sum } from './sum.js'; test('adds', () => assert.equal(sum(2,3),5));\n",
  );
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "bots@test.invalid"],
    ["config", "user.name", "Bots test"],
    ["add", "."],
    ["commit", "-m", "Failing addition"],
  ])
    await runGitCommand(args, { cwd: repo });

  const provider = createBotsTestProvider();
  await start(homeRoot, provider);
  const bot = (
    await client!.botsRequest("bots.create.request", {
      bot: {
        slug: "builder",
        name: "Builder",
        identity: "Fix bugs",
        provider: "claude",
        model: "haiku",
        modeId: "default",
        unattended: true,
        defaultRepo: repo,
      },
    })
  ).bot;
  await expect
    .poll(
      async () =>
        (await client!.botsRequest("bots.chat.history.request", { botId: bot.id })).messages.length,
      { timeout: 10000 },
    )
    .toBeGreaterThan(0);
  await client!.botsRequest("bots.chat.send.request", { botId: bot.id, text: "fix sum" });
  await expect.poll(() => provider.workerGates.size, { timeout: 15000 }).toBe(1);
  for (const release of provider.workerGates.values()) release();
  const items = (
    await client!.botsRequest("bots.items.list.request", { botId: bot.id, includeClosed: true })
  ).items;
  const workerId = items[0]!.workerAgentIds[0]!;
  const before = await client!.botsRequest("bots.chats.tree.request", { botId: bot.id });
  expect(before.home?.workers.map((worker) => worker.agentId)).toEqual([workerId]);

  await client!.close();
  await daemon!.close();
  client = undefined;
  daemon = undefined;

  await start(homeRoot, createBotsTestProvider());
  // Nothing has opened the bot's agents yet: none is live.
  expect(daemon!.daemon.agentManager.getAgent(workerId)).toBeNull();
  const after = await client!.botsRequest("bots.chats.tree.request", { botId: bot.id });
  expect(after.home?.id).toBe(before.home!.id);
  expect(after.home?.workers.map((worker) => worker.agentId)).toEqual([workerId]);
  expect(after.home?.workers[0]?.title).toBe("Fix sum");
  // Opening the worker resumes it; its row keeps the task's name, which only the record holds.
  await client!.fetchAgentTimeline(workerId);
  expect(daemon!.daemon.agentManager.getAgent(workerId)).not.toBeNull();
  const resumed = await client!.botsRequest("bots.chats.tree.request", { botId: bot.id });
  expect(resumed.home?.workers.map((worker) => [worker.agentId, worker.title])).toEqual([
    [workerId, "Fix sum"],
  ]);
}, 60000);
