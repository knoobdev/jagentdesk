import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import { runGitCommand } from "../../utils/run-git-command.js";
import {
  createTestJAgentDeskDaemon,
  type TestJAgentDeskDaemon,
} from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createBotsTestProvider } from "./test-utils/provider.js";
let daemon: TestJAgentDeskDaemon | undefined;
let client: DaemonClient | undefined;
let repo: string | undefined;
afterEach(async () => {
  await client?.close();
  await daemon?.close();
  if (repo) await rm(repo, { recursive: true, force: true });
});
async function setup() {
  repo = await mkdtemp(join(tmpdir(), "bot-sum-"));
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
  daemon = await createTestJAgentDeskDaemon({
    agentClients: { ...createTestAgentClients(), claude: provider.client },
    botsTriggerSource: { poll: async () => [] },
  });
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.59" });
  await client.connect();
  return provider;
}
async function create(unattended = true): Promise<Bot> {
  return (
    await client!.botsRequest("bots.create.request", {
      bot: {
        slug: "builder",
        name: "Builder",
        identity: "Fix bugs",
        provider: "claude",
        model: "haiku",
        modeId: "default",
        unattended,
        defaultRepo: repo,
      },
    })
  ).bot;
}
async function items(botId: string): Promise<BotItem[]> {
  return (await client!.botsRequest("bots.items.list.request", { botId, includeClosed: true }))
    .items;
}

test("37.7 #2/#3: dispatches a worker in a new ORC worktree, answers concurrent chat, and fixes security findings before done", async () => {
  const provider = await setup();
  provider.setUnsafe(true);
  const bot = await create();
  await client!.botsRequest("bots.chat.send.request", { botId: bot.id, text: "fix sum" });
  await expect
    .poll(async () => (await items(bot.id))[0]?.status, { timeout: 15000 })
    .toBe("working");
  await expect.poll(() => provider.workerGates.size, { timeout: 15000 }).toBe(1);
  const working = (await items(bot.id))[0];
  expect(working.worktree).not.toBe(repo);
  expect(await readFile(join(repo!, "sum.js"), "utf8")).toContain("a - b");
  const worker = daemon!.daemon.agentManager.getAgent(working.workerAgentIds[0]);
  expect(worker?.labels["jagentdesk.orchestration.role"]).toBe("lead");
  expect(worker?.cwd).toBe(working.worktree);
  await client!.botsRequest("bots.chat.send.request", {
    botId: bot.id,
    text: "Are you available?",
  });
  await expect
    .poll(
      async () =>
        (await client!.botsRequest("bots.chat.history.request", { botId: bot.id })).messages.filter(
          (m) => m.role === "assistant",
        ).length,
      { timeout: 10000 },
    )
    .toBe(2);
  for (const release of provider.workerGates.values()) release();
  await expect.poll(async () => (await items(bot.id))[0]?.status, { timeout: 20000 }).toBe("done");
  const done = (await items(bot.id))[0];
  expect(done.reviewRounds).toBe(1);
  expect(done.reviews.map((r) => r.role)).toEqual([
    "ba",
    "tester",
    "pentester",
    "ba",
    "tester",
    "pentester",
  ]);
  expect(done.reviews[2].verdict).toBe("request_changes");
  expect(done.diff).toContain("a + b");
  expect(done.summary).toContain("node --test passes");
  expect(
    daemon!.daemon.agentManager.listAgents().reduce((n, a) => n + a.pendingPermissions.size, 0),
  ).toBe(0);
  expect(provider.created.filter((c) => c.config.title?.startsWith("Bot review"))).toHaveLength(6);
}, 60000);

test("37.7 #7: default bots raise host permission cards; unattended is explicit; plugin off rejects RPC", async () => {
  const provider = await setup();
  const bot = await create(false);
  await client!.botsRequest("bots.chat.send.request", { botId: bot.id, text: "fix sum" });
  await expect
    .poll(
      () =>
        daemon!.daemon.agentManager.listAgents().filter((a) => a.pendingPermissions.size > 0)
          .length,
      { timeout: 10000 },
    )
    .toBe(1);
  const supervisor = daemon!.daemon.agentManager
    .listAgents()
    .find((a) => a.labels["jagentdesk.bot.id"] === bot.id)!;
  const request = [...supervisor.pendingPermissions.values()][0];
  expect(request.name).toBe("bot_item_add");
  const originalCatalog = provider.created[0].launch!.jagentdeskTools!;
  expect(originalCatalog.getTool("bot_item_add")?.name).toBe("bot_item_add");
  expect(originalCatalog.getTool("update_agent")).toBeUndefined();
  expect(originalCatalog.getTool("respond_to_permission")).toBeUndefined();
  expect(await items(bot.id)).toEqual([]);
  await client!.setBuiltinPlugin("bots", false);
  await daemon!.daemon.agentManager.createAgent(
    { provider: "claude", cwd: supervisor.cwd, model: "haiku", modeId: "default" },
    undefined,
    { workspaceId: supervisor.workspaceId!, labels: supervisor.labels },
  );
  const disabledCatalog = provider.created.at(-1)!.launch!.jagentdeskTools!;
  expect(disabledCatalog.getTool("bot_item_add")).toBeUndefined();
  expect(originalCatalog.getTool("bot_item_add")?.name).toBe("bot_item_add");
  await expect(client!.botsRequest("bots.list.request", {})).rejects.toMatchObject({
    code: "plugin_disabled",
  });
  await client!.setBuiltinPlugin("bots", true);
  expect(disabledCatalog.getTool("bot_item_add")).toBeUndefined();
  expect((await client!.botsRequest("bots.list.request", {})).bots.map((b) => b.id)).toEqual([
    bot.id,
  ]);
}, 30000);

test("37.7 #5: a real minute cron queues nothing while paused and runs once on resume", async () => {
  const provider = await setup();
  const bot = await create();
  const { schedule } = await client!.botsRequest("bots.schedules.save.request", {
    botId: bot.id,
    schedule: {
      name: "Minute check",
      cron: "* * * * *",
      prompt: "Scheduled minute check",
      enabled: true,
    },
  });
  await client!.botsRequest("bots.pause.request", { botId: bot.id, paused: true });
  const wait = Math.max(0, schedule.nextRunAt_ms - Date.now() + 1200);
  await new Promise((resolve) => setTimeout(resolve, wait));
  expect(
    (await client!.botsRequest("bots.chat.history.request", { botId: bot.id })).messages,
  ).toEqual([]);
  await client!.botsRequest("bots.pause.request", { botId: bot.id, paused: false });
  await expect
    .poll(
      async () =>
        (await client!.botsRequest("bots.chat.history.request", { botId: bot.id })).messages.filter(
          (m) => m.source === "schedule",
        ).length,
      { timeout: 10000 },
    )
    .toBe(1);
  await expect.poll(() => provider.created.length, { timeout: 10000 }).toBe(1);
}, 85000);
