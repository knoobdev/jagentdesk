import { AgentStorage, parseStoredAgentRecord } from "../agent/agent-storage.js";
import { createRestartRecovery } from "../agent/restart-recovery/index.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { ReviewFinding } from "@jagentdesk/protocol/review/types";
import { BotStorage, DEFAULT_BOT_IDENTITY } from "./storage.js";
import { BotsService } from "./service.js";
import type { BotRuntime, BotRuntimeEvent, BotReviewRole } from "./runtime.js";

class Runtime implements BotRuntime {
  sent: { id: string; text: string }[] = [];
  findings: ReviewFinding[] = [];
  reviews: BotReviewRole[] = [];
  callbacks = new Set<(e: BotRuntimeEvent) => void>();
  async configure(): Promise<void> {}
  async ensureSupervisor(bot: Bot): Promise<string> {
    return `supervisor:${bot.id}`;
  }
  busy(): boolean {
    return false;
  }
  async send(id: string, text: string): Promise<void> {
    this.sent.push({ id, text });
  }
  async startWorker(
    _bot: Bot,
    item: BotItem,
    repo: string,
    _assignment: string,
    linked: (id: string, worktree: string, base: string) => void,
  ): Promise<string> {
    linked(`worker:${item.id}`, `${repo}-worktree`, "base");
    return `worker:${item.id}`;
  }
  async review(_bot: Bot, _item: BotItem, role: BotReviewRole) {
    this.reviews.push(role);
    return {
      agentId: `reviewer:${role}`,
      coverage: "all changed files",
      findings: role === "pentester" ? this.findings : [],
    };
  }
  async diff(): Promise<string> {
    return "diff --git sum.js\n+return a+b";
  }
  async cancel(): Promise<void> {}
  onEvent(cb: (e: BotRuntimeEvent) => void) {
    this.callbacks.add(cb);
    return () => this.callbacks.delete(cb);
  }
  dispose(): void {}
}
const homes: string[] = [];
const services: BotsService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function setup(now = Date.UTC(2026, 0, 1)) {
  const home = mkdtempSync(join(tmpdir(), "bots-service-"));
  homes.push(home);
  const runtime = new Runtime();
  let clock = now;
  const service = new BotsService(new BotStorage(home), runtime, {
    logger: pino({ level: "silent" }),
    now: () => clock,
  });
  services.push(service);
  return {
    service,
    runtime,
    setTime: (v: number) => {
      clock = v;
    },
  };
}
async function createBot(service: BotsService) {
  return service.create({
    slug: "builder",
    name: "Builder",
    identity: "Fix bugs",
    provider: "claude",
    model: "default",
    modeId: "default",
    defaultRepo: "/repo",
  });
}
it("creates a bot with an empty identity and seeds SOUL.md with the default (A37.5.1)", async () => {
  const { service } = setup();
  const created = await service.handle({
    type: "bots.create.request",
    requestId: "create",
    bot: {
      slug: "heocon",
      name: "heocon",
      identity: "",
      provider: "claude",
      model: "default",
      modeId: "default",
    },
  });
  const bot = (created as { bot: Bot }).bot;
  expect(bot.identity).toBe(DEFAULT_BOT_IDENTITY);
  const listed = await service.handle({ type: "bots.list.request", requestId: "list" });
  expect((listed as { bots: Bot[] }).bots.map((b) => b.slug)).toEqual(["heocon"]);
  const soul = readFileSync(join(service.storage.botHome(bot), "SOUL.md"), "utf8");
  expect(soul).toBe(`# heocon\n\n${DEFAULT_BOT_IDENTITY}\n`);
  const cleared = await service.update(bot.id, { identity: "  " });
  expect(cleared.identity).toBe(DEFAULT_BOT_IDENTITY);
  const withoutField = await service.create({
    slug: "no-field",
    name: "No field",
    provider: "claude",
    model: "default",
    modeId: "default",
  });
  expect(withoutField.identity).toBe(DEFAULT_BOT_IDENTITY);
});
it("runs three reviews, sends two fix rounds, then escalates with the findings", async () => {
  const { service, runtime } = setup();
  const b = await createBot(service);
  const item = service.addItem(b.id, "Fix sum", "Tests pass");
  await service.startWorker(b.id, item.id, undefined, "Fix sum");
  runtime.findings = [
    {
      path: "sum.js",
      startLine: 1,
      endLine: 1,
      category: "security",
      severity: "high",
      content: "eval user input",
      suggestion: "Remove eval",
    },
  ];
  await service.reviewItem(b.id, item.id, "Changed sum");
  expect(service.storage.item(b.id, item.id).reviewRounds).toBe(1);
  await service.reviewItem(b.id, item.id, "Changed sum");
  expect(service.storage.item(b.id, item.id).reviewRounds).toBe(2);
  await service.reviewItem(b.id, item.id, "Changed sum");
  const result = service.storage.item(b.id, item.id);
  expect(result.status).toBe("needs_you");
  expect(result.reviews).toHaveLength(9);
  expect(runtime.sent).toHaveLength(2);
  expect(result.comments.at(-1)?.text).toContain("eval user input");
});
it("security finding blocks until the fix is clean; then records summary and diff", async () => {
  const { service, runtime } = setup();
  const b = await createBot(service);
  const i = service.addItem(b.id, "Fix", "No eval");
  await service.startWorker(b.id, i.id, undefined, "Fix");
  runtime.findings = [
    {
      path: "sum.js",
      startLine: 1,
      endLine: 1,
      category: "security",
      severity: "high",
      content: "eval",
      suggestion: null,
    },
  ];
  await service.reviewItem(b.id, i.id, "Unsafe");
  runtime.findings = [];
  await service.reviewItem(b.id, i.id, "Removed eval");
  expect(service.storage.item(b.id, i.id)).toMatchObject({
    status: "done",
    summary: "Removed eval",
    reviewRounds: 1,
    diff: "diff --git sum.js\n+return a+b",
  });
  expect(runtime.reviews).toEqual(["ba", "tester", "pentester", "ba", "tester", "pentester"]);
});
it("cron respects pause and deduplicates repeated ticks, while waits wake once", async () => {
  const start = Date.UTC(2026, 0, 1);
  const { service, runtime, setTime } = setup(start);
  const b = await createBot(service);
  service.saveSchedule(b.id, { name: "Minute", cron: "* * * * *", prompt: "Check", enabled: true });
  service.start();
  await service.settled();
  setTime(start + 60000);
  service.pause(b.id, true);
  await service.tick();
  expect(runtime.sent).toEqual([]);
  service.pause(b.id, false);
  await service.tick();
  await service.settled();
  await service.tick();
  await service.settled();
  expect(runtime.sent.filter((s) => s.text.includes("Check"))).toHaveLength(1);
  const i = service.addItem(b.id, "CI", "Green");
  service.setItem(b.id, i.id, {
    status: "waiting",
    waitFor: { condition: "CI", until_ms: start + 61000 },
  });
  setTime(start + 62000);
  await service.tick();
  await service.settled();
  await service.tick();
  await service.settled();
  expect(service.storage.items(b.id)[0].status).toBe("working");
  expect(service.storage.history(b.id).filter((m) => m.source === "wait")).toHaveLength(1);
});
it("answers each question once and wakes only when all questions are answered", async () => {
  const { service } = setup();
  const b = await createBot(service);
  const i = service.addItem(b.id, "Pick", "Selected");
  service.setItem(b.id, i.id, {
    status: "needs_you",
    questions: [
      { text: "Which?", options: ["A", "B"] },
      { text: "When?", options: ["Now", "Later"] },
    ],
  });
  expect((await service.answer(b.id, i.id, [{ questionIndex: 0, text: "A" }])).status).toBe(
    "needs_you",
  );
  expect(service.storage.pending(b.id)).toEqual([]);
  await expect(service.answer(b.id, i.id, [{ questionIndex: 0, text: "B" }])).rejects.toThrow(
    "already answered",
  );
  expect((await service.answer(b.id, i.id, [{ questionIndex: 1, text: "Now" }])).status).toBe(
    "working",
  );
  expect(service.storage.pending(b.id)).toHaveLength(1);
});

it("look-around obeys the interval and room handoffs ignore code, deduplicate and bound loops", async () => {
  const { service, setTime } = setup();
  const builder = await createBot(service);
  const reviewer = await service.create({
    slug: "reviewer",
    name: "Reviewer",
    identity: "Review changes",
    provider: "claude",
    model: "default",
    modeId: "default",
  });
  await service.update(builder.id, { lookAround: { enabled: true, intervalMinutes: 1 } });
  service.start();
  await service.settled();
  setTime(builder.createdAt_ms + 60000);
  await service.tick();
  await service.settled();
  await service.tick();
  await service.settled();
  expect(
    service.storage.history(builder.id).filter((m) => m.source === "look_around"),
  ).toHaveLength(1);
  service.stop();
  const room = service.saveRoom({ name: "Engineering", memberBotIds: [builder.id, reviewer.id] });
  service.sendRoom(room.id, "`@builder`\n> @reviewer", "quoted");
  expect(service.storage.pending(reviewer.id)).toEqual([]);
  service.sendRoom(room.id, "@builder fix this", "root");
  service.sendRoom(room.id, "@builder fix this", "root");
  service.sendRoom(room.id, "@reviewer please inspect", "reply", builder, "root");
  service.sendRoom(room.id, "@builder thanks", "back", reviewer, "root");
  expect(service.storage.pending(builder.id).filter((m) => m.source === "room")).toHaveLength(1);
  expect(service.storage.pending(reviewer.id)).toHaveLength(1);
});

it("refuses completion if the worktree changes while its reviews run", async () => {
  const { service, runtime } = setup();
  const b = await createBot(service);
  const item = service.addItem(b.id, "Fix", "Tests pass");
  await service.startWorker(b.id, item.id, undefined, "Fix");
  let reads = 0;
  runtime.diff = async () => (++reads === 1 ? "old diff" : "new diff");
  await service.reviewItem(b.id, item.id, "Fixed");
  expect(service.storage.item(b.id, item.id).status).toBe("needs_you");
  expect(service.storage.item(b.id, item.id).comments.at(-1)?.text).toContain(
    "Worktree changed during review",
  );
});

it("records ORC escalation as Needs you and wakes the bot without auto-closing the item", async () => {
  const { service, runtime } = setup();
  const b = await createBot(service);
  const item = service.addItem(b.id, "Investigate", "Decision made");
  const { agentId } = await service.startWorker(b.id, item.id, undefined, "Investigate");
  for (const callback of runtime.callbacks)
    callback({
      agentId,
      kind: "escalation",
      key: "dissent-1",
      text: "The security evidence needs an owner decision.",
    });
  await service.settled();
  expect(service.storage.item(b.id, item.id).status).toBe("needs_you");
  expect(service.storage.pending(b.id).map((m) => m.source)).toEqual(["worker_escalation"]);
  await service.reviewItem(b.id, item.id, "Worker ended while awaiting owner");
  expect(runtime.reviews).toEqual([]);
});

it("publishes lazy Supervisor readiness so clients can attach permission cards after queued chat", async () => {
  const { service } = setup();
  const b = await createBot(service);
  const changed: string[] = [];
  service.onEvent((event) => {
    if (event.type === "bots.changed") changed.push(event.payload.botId);
  });
  service.start();
  service.wake(b.id, "Hello", "chat");
  await service.settled();
  expect(changed).toEqual([b.id]);
  expect(service.storage.bot(b.id).agentId).toBe(`supervisor:${b.id}`);
  service.wake(b.id, "Another question", "chat");
  await service.settled();
  expect(changed).toEqual([b.id]);
});

it("cold restart continues a running background supervisor once with generic recovery enabled", async () => {
  const { service: before, runtime: oldRuntime } = setup();
  const bot = await createBot(before);
  const idle = await before.create({
    slug: "idle",
    name: "Idle",
    identity: "Wait",
    provider: "claude",
    model: "default",
    modeId: "default",
  });
  before.start();
  before.wake(bot.id, "A chat turn with no item yet", "chat", "interrupted");
  await before.settled();
  expect(oldRuntime.sent).toHaveLength(1);
  const home = homes.at(-1)!;
  const storage = new AgentStorage(home, pino({ level: "silent" }));
  const supervisorId = before.storage.bot(bot.id).agentId!;
  for (const [id, lastStatus, labels] of [
    [supervisorId, "running", { "jagentdesk.bot.id": bot.id }],
    ["idle-supervisor", "idle", { "jagentdesk.bot.id": idle.id }],
    ["foreground", "running", {}],
  ] as const) {
    await storage.upsert(
      parseStoredAgentRecord({
        id,
        lastStatus,
        labels,
        background: id !== "foreground",
        provider: "claude",
        cwd: home,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // Also exclude a stale recovery intent on an idle bot.
        resumeOnStartup: id === "idle-supervisor",
      }),
    );
  }
  await before.dispose();
  services.splice(services.indexOf(before), 1);
  const runtime = new Runtime();
  const generic: string[] = [];
  const recovery = createRestartRecovery({
    storage,
    settings: () => ({ enabled: true, prompt: "generic recovery" }),
    eligible: async () => true,
    dispatch: async (id) => {
      generic.push(id);
      await runtime.send(id, "generic recovery");
    },
    report: (_id, error) => {
      throw error;
    },
  });
  await recovery.prepareStartup();
  expect((await storage.get(supervisorId))?.resumeOnStartup).toBe(false);
  expect((await storage.get("idle-supervisor"))?.resumeOnStartup).toBe(false);
  const restarted = new BotsService(new BotStorage(home), runtime, {
    logger: pino({ level: "silent" }),
  });
  services.push(restarted);
  restarted.start();
  recovery.resumePending();
  await recovery.waitForResume("foreground", new AbortController().signal);
  await restarted.settled();
  restarted.start();
  restarted.stop();
  restarted.start();
  await restarted.tick();
  await restarted.settled();
  expect(generic).toEqual(["foreground"]);
  expect(runtime.sent.filter(({ id }) => id === supervisorId)).toHaveLength(1);
  expect(runtime.sent.filter(({ id }) => id === "idle-supervisor")).toEqual([]);
  expect(runtime.sent.find(({ id }) => id === supervisorId)?.text).toContain("daemon resumed");
});

it("cold restart retries an undelivered active wake without also scheduling a continuation", async () => {
  const { service: before, runtime: oldRuntime } = setup();
  const bot = await createBot(before);
  oldRuntime.send = async () => {
    throw new Error("Provider startup interrupted");
  };
  before.start();
  before.wake(bot.id, "Original chat", "chat", "interrupted-send");
  await before.settled();
  expect(before.storage.pending(bot.id)).toHaveLength(1);
  const home = homes.at(-1)!;
  await before.dispose();
  services.splice(services.indexOf(before), 1);
  const runtime = new Runtime();
  const restarted = new BotsService(new BotStorage(home), runtime, {
    logger: pino({ level: "silent" }),
  });
  services.push(restarted);
  restarted.start();
  await restarted.settled();
  await restarted.tick();
  await restarted.settled();
  expect(runtime.sent).toEqual([{ id: `supervisor:${bot.id}`, text: "[chat]\nOriginal chat" }]);
  expect(restarted.storage.pending(bot.id)).toEqual([]);
});
