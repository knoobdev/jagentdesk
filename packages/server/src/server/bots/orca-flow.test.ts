// The Orca-layout bot flow (spec 37.2-37.3) against a real BotStorage and home folders, with the
// in-process runtime standing in for providers.
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { Bot, BotMessage } from "@jagentdesk/protocol/bots/types";
import { BotStorage } from "./storage.js";
import { BotsService } from "./service.js";
import { BotsError } from "./home.js";
import { FakeBotRuntime } from "./test-utils/fake-runtime.js";
import { backgroundToolDecision, lookAroundCommandAllowed } from "./look-around.js";
import { BOT_TEMPLATE_SKILL_TEXT } from "./templates/skills.js";

const homes: string[] = [];
const services: BotsService[] = [];
afterEach(async () => {
  for (const s of services.splice(0)) await s.dispose();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup(options: { home?: string; now?: number } = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), "bots-orca-"));
  if (!options.home) homes.push(home);
  const runtime = new FakeBotRuntime();
  let clock = options.now ?? Date.UTC(2026, 10, 27, 10);
  const service = new BotsService(new BotStorage(home), runtime, {
    logger: pino({ level: "silent" }),
    now: () => clock,
  });
  services.push(service);
  return { home, service, runtime, setTime: (v: number) => (clock = v) };
}

async function newBot(
  service: BotsService,
  name = "Heo Con",
  extra: Partial<Parameters<BotsService["create"]>[0]> = {},
) {
  return service.create(
    { name, provider: "claude", model: "default", ...extra },
    { kickoff: null },
  );
}

async function rpc<T>(service: BotsService, msg: Record<string, unknown>): Promise<T> {
  return (await service.handle({ requestId: "r", ...msg } as never)) as T;
}

function notes(service: BotsService, botId: string): BotMessage[] {
  return service.storage.history(botId, 200).filter((m) => m.note);
}

describe("bot record and home (spec 37.2.3, 37.2.4)", () => {
  it("creates with Orca defaults, a home and a kickoff turn", async () => {
    const { service } = setup();
    const { bot } = await rpc<{ bot: Bot }>(service, {
      type: "bots.create.request",
      bot: { name: "Heo Con", provider: "claude", model: "default" },
    });
    expect(bot).toMatchObject({
      folder: "heo-con",
      slug: "heo-con",
      permissionMode: "same-as-chats",
      avatarColor: "#b3dbf4",
      paused: false,
      notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
      lookAround: { on: true, every: "every-4h", weekdaysOnly: true, focus: "" },
      tidyUp: { on: true, every: "night" },
      itemsStale: 5,
      reviewBeforeDone: false,
      firstRun: true,
    });
    expect(bot.avatar).toMatch(/^mascot:/);
    expect(bot.avatar).not.toBe("mascot:S2");
    const home = service.storage.botHome(bot);
    expect(readFileSync(join(home, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toContain(
      "a bot that runs in JAgentDesk",
    );
    expect(JSON.parse(readFileSync(join(home, "bot.json"), "utf8")).id).toBe(bot.id);
    expect(readFileSync(join(home, "SOUL.md"), "utf8")).toContain("Describe Heo Con here");
    expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toContain(
      "One line per fact, newest first.",
    );
    for (const dir of ["memory", "memory/journal", "skills"])
      expect(existsSync(join(home, dir))).toBe(true);
    expect(service.storage.pending(bot.id).map((m) => m.text)).toEqual([
      "JAgentDesk: you were just created. Start your first-run setup.",
    ]);
  });

  it("allocates <slug>, <slug>-2 and never hands a folder out again (A37.5.3c)", async () => {
    const { service } = setup();
    const first = await newBot(service);
    const second = await newBot(service);
    expect([first.folder, second.folder]).toEqual(["heo-con", "heo-con-2"]);
    await service.delete(first.id);
    expect((await newBot(service)).folder).toBe("heo-con-3");
  });

  it("refuses a home whose bot.json belongs to another bot", async () => {
    const { home, service } = setup();
    const taken = join(home, "bots", "taken");
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "bot.json"), JSON.stringify({ id: "someone-else" }));
    const bot = await newBot(service, "Fresh");
    const { writeBotHome } = await import("./home.js");
    await expect(writeBotHome(taken, bot)).rejects.toThrow(BotsError);
  });

  it("migrates a round-1 bot: bypass mode, default repo fact, no review (A37.7.28)", async () => {
    const home = mkdtempSync(join(tmpdir(), "bots-v1-"));
    homes.push(home);
    mkdirSync(join(home, "bots", "builder", "memory"), { recursive: true });
    writeFileSync(join(home, "bots", "builder", "MEMORY.md"), "# Memory\n");
    writeFileSync(join(home, "bots", "builder", "SOUL.md"), "# Builder\n\nFix bugs\n");
    const db = new Database(join(home, "bots", "bots.sqlite"));
    db.exec(`
      CREATE TABLE bots (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE items (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, data TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      PRAGMA user_version = 1;`);
    const round1 = {
      id: "b1",
      slug: "builder",
      name: "Builder",
      identity: "Fix bugs",
      provider: "claude",
      model: "default",
      modeId: "default",
      unattended: true,
      defaultRepo: "/work/repo",
      paused: false,
      lookAround: { enabled: false, intervalMinutes: 60 },
      schedules: [],
      createdAt_ms: 1,
      updatedAt_ms: 1,
    };
    db.prepare("INSERT INTO bots VALUES (?,?,?)").run("b1", "builder", JSON.stringify(round1));
    const item = {
      id: "i1",
      botId: "b1",
      title: "Old",
      doneMeans: "Done",
      status: "working",
      workerAgentIds: [],
      comments: [],
      reviewRounds: 0,
      reviews: [],
      createdAt_ms: 1,
      updatedAt_ms: 1,
    };
    db.prepare("INSERT INTO items VALUES (?,?,?)").run("i1", "b1", JSON.stringify(item));
    db.close();
    const { service } = setup({ home });
    service.start();
    await service.settled();
    const bot = service.storage.bot("b1");
    expect(bot).toMatchObject({
      folder: "builder",
      permissionMode: "bypassPermissions",
      reviewBeforeDone: false,
    });
    expect(service.storage.item("b1", "i1").number).toBe(1);
    expect(readFileSync(join(home, "bots", "builder", "MEMORY.md"), "utf8")).toContain(
      "Fact: default repository is /work/repo",
    );
    expect(readFileSync(join(home, "bots", "builder", "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });
});

describe("memory (spec 37.2.4, 37.4.9)", () => {
  it("adds with a History row and Undo takes it back (A37.7.20)", async () => {
    const { service } = setup();
    const bot = await newBot(service);
    const added = await rpc<{ memory: { facts: { text: string }[] } }>(service, {
      type: "bots.memory.add.request",
      botId: bot.id,
      text: "Prefers: short replies",
    });
    expect(added.memory.facts.map((f) => f.text)).toEqual(["Prefers: short replies"]);
    const { history } = await rpc<{ history: { id: string; by: { kind: string } }[] }>(service, {
      type: "bots.memory.history.request",
      botId: bot.id,
    });
    expect(history[0]?.by.kind).toBe("owner");
    const undone = await rpc<{ memory: { facts: unknown[] } }>(service, {
      type: "bots.memory.undo.request",
      botId: bot.id,
      rowId: history[0]!.id,
    });
    expect(undone.memory.facts).toEqual([]);
    expect(readFileSync(join(service.storage.botHome(bot), "MEMORY.md"), "utf8")).not.toContain(
      "short replies",
    );
    await expect(
      rpc(service, { type: "bots.memory.undo.request", botId: bot.id, rowId: history[0]!.id }),
    ).rejects.toMatchObject({ code: "superseded" });
  });

  it("puts back a line a chat dropped without forget, and forget removes it", async () => {
    const { service } = setup();
    const bot = await newBot(service);
    await service.memory.add(bot, "Rule: never merge on red CI");
    const path = join(service.storage.botHome(bot), "MEMORY.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(/.*never merge.*\n/, ""));
    await service.memory.reconcile(bot, "home-agent");
    expect(readFileSync(path, "utf8")).toContain("Rule: never merge on red CI");
    expect(service.memory.history(bot)[0]?.by.kind).toBe("kept");
    await service.memory.forgetFact(bot, "Rule: never merge on red CI", "home-agent");
    expect(readFileSync(path, "utf8")).not.toContain("never merge");
  });

  it("writes SOUL.md only on the hash it read (A37.7.21)", async () => {
    const { service } = setup();
    const bot = await newBot(service);
    const read = await rpc<{ content: string; hash: string }>(service, {
      type: "bots.home_file.read.request",
      botId: bot.id,
      file: "SOUL.md",
    });
    writeFileSync(join(service.storage.botHome(bot), "SOUL.md"), "# Changed outside\n");
    await expect(
      rpc(service, {
        type: "bots.home_file.write.request",
        botId: bot.id,
        file: "SOUL.md",
        content: "mine",
        baseHash: read.hash,
      }),
    ).rejects.toMatchObject({ code: "file_changed" });
    await rpc(service, {
      type: "bots.home_file.write.request",
      botId: bot.id,
      file: "SOUL.md",
      content: "mine",
    });
    expect(readFileSync(join(service.storage.botHome(bot), "SOUL.md"), "utf8")).toBe("mine");
  });
});

describe("items (spec 37.2.5, 37.3.2, 37.3.7)", () => {
  it("numbers items, notes them in Home Chat and journals the close (A37.7.8)", async () => {
    const { service, runtime } = setup();
    const bot = await newBot(service, "Builder", { defaultRepo: "/repo" });
    const item = service.addItem(bot.id, "Fix sum", "Tests pass");
    expect(item.number).toBe(1);
    await service.startWorker(bot.id, item.id, undefined, "Fix sum");
    expect(service.storage.item(bot.id, item.id).links?.[0]).toMatchObject({
      kind: "dispatch",
      state: "working",
    });
    runtime.emit({
      agentId: `worker:${item.id}`,
      kind: "done",
      key: "t1",
      text: "Done. https://github.com/o/r/pull/7",
    });
    await service.settled();
    // Default: no three-role review; the bot is woken to record the result.
    expect(runtime.reviews).toEqual([]);
    expect(service.storage.pending(bot.id).map((m) => m.source)).toContain("worker_done");
    const linked = service.storage.item(bot.id, item.id);
    expect(linked.links?.map((l) => l.kind)).toEqual(["dispatch", "pr"]);
    expect(linked.links?.[0]).toMatchObject({ state: "completed" });
    service.comment(bot.id, item.id, "Fixed; PR o/r#7");
    service.setStatus(bot.id, item.id, "done", "bot");
    await service.settled();
    const journal = readFileSync(
      join(service.storage.botHome(bot), "memory", "journal", "2026-11.md"),
      "utf8",
    );
    expect(journal.trim().split("\n")).toEqual(["- 2026-11-27 | item #1 | done, o/r#7 | Fix sum"]);
    expect(notes(service, bot.id).map((m) => m.text)).toEqual([
      "Added #1",
      "Moved #1 to In progress",
      "Commented on #1",
      "Marked #1 done",
    ]);
  });

  it("refuses done with review_pending while Review before done waits (A37.7.35)", async () => {
    const { service } = setup();
    const bot = await newBot(service, "Builder", { defaultRepo: "/repo", reviewBeforeDone: true });
    const item = service.addItem(bot.id, "Fix", "Tests pass");
    await service.startWorker(bot.id, item.id, undefined, "Fix");
    await expect(
      rpc(service, { type: "bots.items.done.request", botId: bot.id, itemId: item.id }),
    ).rejects.toMatchObject({ code: "review_pending" });
    expect(service.storage.item(bot.id, item.id).status).toBe("working");
    const forced = await rpc<{ item: { status: string } }>(service, {
      type: "bots.items.done.request",
      botId: bot.id,
      itemId: item.id,
      force: true,
    });
    expect(forced.item.status).toBe("done");
  });

  it("runs review rounds with Activity lines when Review before done is on (A37.7.33)", async () => {
    const { service, runtime } = setup();
    const bot = await newBot(service, "Builder", { defaultRepo: "/repo", reviewBeforeDone: true });
    const item = service.addItem(bot.id, "Fix", "Tests pass");
    await service.startWorker(bot.id, item.id, undefined, "Fix");
    service.start();
    await service.settled();
    runtime.emit({ agentId: `worker:${item.id}`, kind: "done", key: "t1", text: "Fixed" });
    await service.settled();
    const done = service.storage.item(bot.id, item.id);
    expect(done.status).toBe("done");
    expect(runtime.reviews).toEqual(["ba", "tester", "pentester"]);
    expect(done.comments.map((c) => c.text)).toContain("Review round 1 of 2 started");
  });

  it("cancels stale items with the reason and snoozes until a time (A37.7.14, A37.7.15)", async () => {
    const { service, setTime } = setup();
    const bot = await newBot(service);
    await service.update(bot.id, { itemsStale: 3 });
    const item = service.addItem(bot.id, "Old ask", "Answered");
    service.setStatus(bot.id, item.id, "needs_you", "bot");
    const now = Date.UTC(2026, 10, 30, 12);
    setTime(now);
    const { canceled } = await rpc<{ canceled: string[] }>(service, {
      type: "bots.items.cancel_many.request",
      botId: bot.id,
      itemUids: [item.id],
      reason: "No activity for 3 days.",
    });
    expect(canceled).toEqual([item.id]);
    const closed = service.storage.item(bot.id, item.id);
    expect(closed).toMatchObject({ status: "canceled", closeNote: "No activity for 3 days." });
    const other = service.addItem(bot.id, "Later", "Done");
    const snoozed = await rpc<{ item: { snoozedUntil_ms?: number } }>(service, {
      type: "bots.items.snooze.request",
      botId: bot.id,
      itemUid: other.id,
      until_ms: now + 86_400_000,
    });
    expect(snoozed.item.snoozedUntil_ms).toBe(now + 86_400_000);
    const unsnoozed = await rpc<{ item: { snoozedUntil_ms?: number } }>(service, {
      type: "bots.items.snooze.request",
      botId: bot.id,
      itemUid: other.id,
      until_ms: null,
    });
    expect(unsnoozed.item.snoozedUntil_ms).toBeUndefined();
    const { events } = await rpc<{ events: { kind: string }[] }>(service, {
      type: "bots.items.show.request",
      botId: bot.id,
      itemId: other.id,
    });
    expect(events.map((e) => e.kind)).toEqual(["made", "snoozed", "unsnoozed"]);
  });

  it("asks with quick replies; the owner's comment moves the item back to work (A37.7.12)", async () => {
    const { service } = setup();
    const bot = await newBot(service);
    const item = service.addItem(bot.id, "Pick", "Picked");
    service.ask(bot.id, item.id, {
      context: "Two ways",
      questions: [
        { prompt: "Which way?", options: [{ label: "A" }, { label: "B" }], recommended: 1 },
        { prompt: "When?", options: [{ label: "Now" }] },
      ],
    });
    expect(service.storage.item(bot.id, item.id).question?.decisions).toHaveLength(2);
    await service.answer(bot.id, item.id, [{ questionIndex: 0, text: "B" }]);
    const answered = await service.answer(bot.id, item.id, [{ questionIndex: 1, text: "Now" }]);
    expect(answered.status).toBe("working");
    expect(answered.comments.map((c) => c.text).join("\n")).toContain("Owner: B");
    expect(answered.comments.map((c) => c.text).join("\n")).toContain("Owner: Now");
  });
});

describe("Needs you, Chats, Automations (spec 37.4)", () => {
  it("orders approval → question → connector → item (A37.7.10)", async () => {
    const { service, runtime } = setup();
    const bot = await newBot(service);
    service.storage.saveBot({
      ...service.storage.bot(bot.id),
      agentId: "home",
      slack: { connected: true, needsFix: true },
    });
    const item = service.addItem(bot.id, "Decide", "Decided");
    service.setStatus(bot.id, item.id, "needs_you", "bot");
    runtime.snapshots = [
      {
        id: "home",
        title: "Heo Con",
        labels: {},
        busy: false,
        lifecycle: "idle",
        pendingPermissions: [{ id: "q1", name: "AskUserQuestion", kind: "question" }],
        createdAt_ms: 1,
        updatedAt_ms: 2,
        cwd: "/",
      },
      {
        id: "w1",
        title: "Fix login",
        labels: { "jagentdesk.parent-agent-id": "home" },
        busy: true,
        lifecycle: "running",
        pendingPermissions: [{ id: "p1", name: "Bash", kind: "tool" }],
        createdAt_ms: 1,
        updatedAt_ms: 2,
        cwd: "/",
        parentId: "home",
      },
    ];
    const { rows } = await rpc<{ rows: { kind: string; title: string; workerName?: string }[] }>(
      service,
      {
        type: "bots.needs_you.list.request",
        botId: bot.id,
      },
    );
    expect(rows.map((r) => r.kind)).toEqual(["approval", "question", "connector", "item"]);
    expect(rows[0]).toMatchObject({ title: "Permission · Bash", workerName: "Fix login" });
    expect(rows[2]?.title).toBe("Slack needs you to sign in again or fix it.");
    const tree = await rpc<{ home?: { title: string; workers: { title: string }[] } }>(service, {
      type: "bots.chats.tree.request",
      botId: bot.id,
    });
    expect(tree.home?.title).toBe("Home Chat");
    expect(tree.home?.workers.map((w) => w.title)).toEqual(["Fix login"]);
  });

  it("hides Look around and Tidy memory for providers other than Claude and Codex (A37.7.19)", async () => {
    const { service } = setup();
    const bot = await service.create(
      { name: "Open", provider: "opencode", model: "default" },
      { kickoff: null },
    );
    const { automations } = await rpc<{ automations: { kind: string }[] }>(service, {
      type: "bots.automations.list.request",
      botId: bot.id,
    });
    expect(automations.map((a) => a.kind)).toEqual([]);
    await expect(
      rpc(service, { type: "bots.look_around.run_now.request", botId: bot.id }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});

describe("Look around and Tidy memory (spec 37.2.6)", () => {
  it("is a visible run: running note, Chats row, suggestions, Dismiss (A37.7.36, A37.7.18)", async () => {
    const { service, runtime } = setup();
    const bot = await newBot(service);
    let finish: (text: string) => void = () => {};
    runtime.backgroundReply = () => new Promise((resolve) => (finish = resolve));
    const started = await rpc<{ started: boolean; runAgentId: string }>(service, {
      type: "bots.look_around.run_now.request",
      botId: bot.id,
    });
    expect(started.started).toBe(true);
    expect(runtime.background[0]).toMatchObject({
      kind: "look_around",
      policy: "look-around",
      timeoutMs: 600_000,
    });
    expect(notes(service, bot.id).map((m) => [m.text, m.note?.state])).toEqual([
      ["Looking around", "running"],
    ]);
    runtime.snapshots = [
      {
        id: started.runAgentId,
        title: "Look around",
        labels: { "jagentdesk.bot.id": bot.id, "jagentdesk.bot.role": "look_around" },
        busy: true,
        lifecycle: "running",
        pendingPermissions: [],
        createdAt_ms: 1,
        updatedAt_ms: 1,
        cwd: "/",
      },
    ];
    const tree = await rpc<{ chats: { title: string; kind: string; run?: { state: string } }[] }>(
      service,
      {
        type: "bots.chats.tree.request",
        botId: bot.id,
      },
    );
    expect(tree.chats[0]).toMatchObject({
      title: "Look around",
      kind: "automation",
      run: { state: "running" },
    });
    const { automations } = await rpc<{ automations: { kind: string; state: string }[] }>(service, {
      type: "bots.automations.list.request",
      botId: bot.id,
    });
    expect(automations.find((a) => a.kind === "look_around")?.state).toBe("running");
    await expect(
      rpc(service, { type: "bots.look_around.run_now.request", botId: bot.id }),
    ).rejects.toMatchObject({ code: "already_running" });
    finish(
      'Found two.\n```json\n[{"title":"Review PR 12","why":"Asked of you","ask":"Review o/r#12","link":"https://github.com/o/r/pull/12"},{"title":"Answer Dana","why":"Waiting","ask":"Reply to Dana"}]\n```\n[[quiet]]',
    );
    await service.settled();
    expect(notes(service, bot.id).map((m) => m.text)).toEqual(["Looked around · 2 suggestions"]);
    const listed = await rpc<{ suggestions: { id: string; title: string }[] }>(service, {
      type: "bots.suggestions.list.request",
      botId: bot.id,
    });
    expect(listed.suggestions.map((s) => s.title).sort()).toEqual(["Answer Dana", "Review PR 12"]);
    const dana = listed.suggestions.find((s) => s.title === "Answer Dana")!;
    await rpc(service, {
      type: "bots.suggestions.dismiss.request",
      botId: bot.id,
      suggestionId: dana.id,
    });
    runtime.backgroundReply = async () =>
      '```json\n[{"title":"Answer Dana","why":"Still","ask":"Reply"}]\n```';
    await rpc(service, { type: "bots.look_around.run_now.request", botId: bot.id });
    await service.settled();
    const again = await rpc<{ suggestions: { title: string }[] }>(service, {
      type: "bots.suggestions.list.request",
      botId: bot.id,
    });
    expect(again.suggestions.map((s) => s.title)).toEqual(["Review PR 12"]);
    service.pause(bot.id, true);
    await expect(
      rpc(service, { type: "bots.look_around.run_now.request", botId: bot.id }),
    ).rejects.toMatchObject({ code: "paused" });
  });

  it("tidies with ops, notes the change count, and Undo restores MEMORY.md (A37.7.37)", async () => {
    const { service, runtime } = setup();
    const bot = await newBot(service);
    await service.memory.add(bot, "Fact: PR 41 review round 2 pending");
    await service.memory.add(bot, "Fact: the API lives in api/");
    await service.memory.add(bot, "Lesson: run the linter before pushing");
    await service.memory.add(bot, "Fact: CI runs on GitHub Actions");
    const before = await service.memory.text(bot);
    runtime.backgroundReply = async (run) => {
      const ref = /^(L\d+#[0-9a-f]{4}) .*PR 41/m.exec(run.prompt)?.[1];
      return JSON.stringify([{ op: "retire", line: ref, reason: "done" }]);
    };
    await rpc(service, { type: "bots.tidy_up.run_now.request", botId: bot.id });
    await service.settled();
    expect(runtime.background[0]).toMatchObject({ kind: "tidy_up", policy: "reply-only" });
    expect(notes(service, bot.id).map((m) => m.text)).toEqual(["Tidied memory · 1 changes"]);
    expect(await service.memory.text(bot)).not.toContain("PR 41");
    expect(
      readFileSync(join(service.storage.botHome(bot), "memory", "archive.md"), "utf8"),
    ).toContain("PR 41");
    const { tidyUp } = await rpc<{ tidyUp: { last: { runId: string; changes: number } } }>(
      service,
      {
        type: "bots.tidy_up.status.request",
        botId: bot.id,
      },
    );
    expect(tidyUp.last.changes).toBe(1);
    await rpc(service, {
      type: "bots.tidy_up.undo.request",
      botId: bot.id,
      runId: tidyUp.last.runId,
    });
    expect(await service.memory.text(bot)).toBe(before);
  });

  it("holds a look to reads and a tidy-up to nothing (ADR-0046 gate)", () => {
    expect(lookAroundCommandAllowed("gh pr view 12 --json title")).toBe(true);
    expect(lookAroundCommandAllowed("/bin/zsh -lc 'git log --oneline -5'")).toBe(true);
    expect(lookAroundCommandAllowed("gh api -X POST repos/o/r/issues")).toBe(false);
    expect(lookAroundCommandAllowed("git log && rm -rf .")).toBe(false);
    expect(lookAroundCommandAllowed("git diff --output=/tmp/x")).toBe(false);
    expect(backgroundToolDecision("look-around", "Read", { file_path: "a" })).toEqual({
      behavior: "allow",
    });
    expect(backgroundToolDecision("look-around", "Write", { file_path: "a" }).behavior).toBe(
      "deny",
    );
    expect(backgroundToolDecision("look-around", "Bash", { command: "rm -rf /" }).behavior).toBe(
      "deny",
    );
    expect(backgroundToolDecision("reply-only", "Read", {}).behavior).toBe("deny");
  });

  it("runs a due look only after the first chat and after the 120 s wake hold", async () => {
    const start = new Date(2026, 10, 27, 7, 59).getTime();
    const { service, runtime, setTime } = setup({ now: start });
    const bot = await newBot(service);
    service.start();
    await service.settled();
    const step = async (until: number) => {
      for (let t = start; t <= until; t += 20_000) {
        setTime(t);
        await service.tick();
        await service.settled();
      }
    };
    // Past the 8 AM slot, awake long enough, but no first conversation yet.
    await step(start + 3 * 60_000);
    expect(runtime.background).toEqual([]);
    service.wake(bot.id, "hello", "chat");
    service.storage.setState(`first-chat:${bot.id}`, start - 60_000);
    await step(start + 4 * 60_000);
    expect(runtime.background.map((r) => r.kind)).toEqual(["look_around"]);
  });
});

describe("templates, hand over, groups, New Home Chat", () => {
  it("lists the 11 templates and creates pr-review with its skill, schedules off (A37.7.23)", async () => {
    const { service } = setup();
    const { templates } = await rpc<{
      templates: { id: string; category: string; categoryLabel: string }[];
    }>(service, {
      type: "bots.templates.list.request",
    });
    expect(templates).toHaveLength(11);
    expect(templates.filter((t) => t.categoryLabel === "Coding")).toHaveLength(5);
    expect(templates.map((t) => t.id).filter((id) => id.includes("release"))).toEqual([
      "release",
      "release-notes",
    ]);
    const { bot } = await rpc<{ bot: Bot }>(service, {
      type: "bots.create_from_template.request",
      templateId: "pr-review",
      name: "Reviewer",
      provider: "claude",
      model: "default",
    });
    const skill = readFileSync(
      join(service.storage.botHome(bot), "skills", "pr-review-checklist", "SKILL.md"),
      "utf8",
    );
    expect(skill).toBe(BOT_TEMPLATE_SKILL_TEXT["pr-review-checklist"]);
    expect(bot.templateId).toBe("pr-review");
    const dep = await rpc<{ bot: Bot }>(service, {
      type: "bots.create_from_template.request",
      templateId: "dependency-updates",
      name: "Deps",
      provider: "claude",
      model: "default",
    });
    expect(dep.bot.schedules.map((s) => s.enabled)).toEqual([false]);
  });

  it("hands a workspace over with Orca's one-line ask when there is no goal (A37.7.24)", async () => {
    const { service } = setup();
    const bot = await newBot(service);
    const result = await rpc<{ bot: Bot; workspace: { title: string } }>(service, {
      type: "bots.hand_over.request",
      workspaceId: "ws-1",
      botId: bot.id,
    });
    expect(result.bot.handedWorkspaces?.map((w) => w.workspaceId)).toEqual(["ws-1"]);
    const turn = service.storage.pending(bot.id).at(-1)!;
    expect(turn.text).toContain(
      '"I\'ve taken over fix-login (1 agent). What should I do with it?"',
    );
    const tree = await rpc<{ workspaces: { title: string }[] }>(service, {
      type: "bots.chats.tree.request",
      botId: bot.id,
    });
    expect(tree.workspaces.map((w) => w.title)).toEqual(["fix-login"]);
  });

  it("follows the group reply mode; an explicit mention wins (A37.7.30)", async () => {
    const { service } = setup();
    const one = await newBot(service, "One");
    const two = await newBot(service, "Two");
    const room = service.saveRoom({
      name: "Pair",
      memberBotIds: [one.id, two.id],
      replyMode: { kind: "mentions" },
    });
    service.sendRoom(room.id, "@one take this", "p1");
    expect(service.storage.pending(one.id).filter((m) => m.source === "room")).toHaveLength(1);
    expect(service.storage.pending(two.id).filter((m) => m.source === "room")).toHaveLength(0);
    service.sendRoom(room.id, "@two your turn", "r1", service.storage.bot(one.id), "p1");
    expect(service.storage.pending(two.id).filter((m) => m.source === "room")).toHaveLength(1);
    service.saveRoom({
      id: room.id,
      name: "Pair",
      memberBotIds: [one.id, two.id],
      replyMode: { kind: "all" },
    });
    service.sendRoom(room.id, "status, everyone?", "p2");
    expect(service.storage.pending(one.id).filter((m) => m.source === "room")).toHaveLength(2);
    expect(service.storage.pending(two.id).filter((m) => m.source === "room")).toHaveLength(2);
  });

  it("starts a new Home Chat and keeps the soul", async () => {
    const { service, runtime } = setup();
    const bot = await newBot(service);
    service.storage.saveBot({ ...service.storage.bot(bot.id), agentId: "home-1" });
    const { bot: reset } = await rpc<{ bot: Bot }>(service, {
      type: "bots.chat.reset.request",
      botId: bot.id,
    });
    expect(runtime.resets).toEqual(["home-1"]);
    expect(reset.agentId).toBeUndefined();
    expect(readFileSync(join(service.storage.botHome(bot), "SOUL.md"), "utf8")).toContain(
      "Heo Con",
    );
  });
});
