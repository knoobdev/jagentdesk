// Bot automations as core schedules (spec 37.2.6): stored with `bot`, run through the bots
// launcher, held while the bot is paused.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, expect, test } from "vitest";
import type { ScheduleExecutionResult, StoredSchedule } from "@jagentdesk/protocol/schedule/types";
import {
  ScheduleService,
  ScheduleStateConflictError,
  type ScheduleBotLauncher,
  type ScheduleServiceOptions,
} from "./service.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function unused(name: string): never {
  throw new Error(`${name} must not run for a bot schedule`);
}

class Launcher implements ScheduleBotLauncher {
  paused = new Set<string>();
  runs: { scheduleId: string; runId: string; finish: (result: ScheduleExecutionResult) => void }[] =
    [];
  changes: string[] = [];
  target(botId: string) {
    return {
      type: "new-agent" as const,
      config: { provider: "claude", model: "default", cwd: `/bots/${botId}`, title: botId },
    };
  }
  blocked(botId: string): string | null {
    return this.paused.has(botId) ? `${botId} is paused` : null;
  }
  run(schedule: StoredSchedule, runId: string): Promise<ScheduleExecutionResult> {
    return new Promise((finish) => this.runs.push({ scheduleId: schedule.id, runId, finish }));
  }
  changed(botId: string): void {
    this.changes.push(botId);
  }
}

async function setup(start: number) {
  const home = await mkdtemp(join(tmpdir(), "bot-schedules-"));
  homes.push(home);
  let clock = start;
  const launcher = new Launcher();
  const service = new ScheduleService({
    jagentdeskHome: home,
    logger: pino({ level: "silent" }),
    agentManager: {
      setDaemonBackgroundWork: () => unused("agentManager"),
      removeDaemonBackgroundWork: () => unused("agentManager"),
    } as unknown as ScheduleServiceOptions["agentManager"],
    agentStorage: {} as ScheduleServiceOptions["agentStorage"],
    createAgent: async () => unused("createAgent"),
    createDirectoryWorkspace: async () => unused("createDirectoryWorkspace"),
    createJAgentDeskWorktreeWorkspace: async () => unused("createJAgentDeskWorktreeWorkspace"),
    archiveWorkspace: async () => unused("archiveWorkspace"),
    now: () => new Date(clock),
  });
  service.setBotLauncher(launcher);
  return { service, launcher, setTime: (value: number) => (clock = value) };
}

const CRON = { type: "cron" as const, expression: "* * * * *" };

test("a bot schedule keeps a given id once, carries its bot and stores off as paused", async () => {
  const start = Date.UTC(2026, 10, 27, 9);
  const { service, launcher } = await setup(start);
  const input = {
    id: "11111111-1111-4111-8111-111111111111",
    bot: { botId: "bot-a", runsIn: "home" },
    name: "Morning",
    prompt: "Plan the day",
    cadence: CRON,
    enabled: true,
    nextRunAt: new Date(start + 120_000).toISOString(),
  };
  const first = await service.createForBot(input);
  const again = await service.createForBot({ ...input, prompt: "Something else" });
  expect(again).toEqual(first);
  expect(first).toMatchObject({
    status: "active",
    nextRunAt: new Date(start + 120_000).toISOString(),
    bot: { botId: "bot-a", runsIn: "home" },
    target: { type: "new-agent", config: { cwd: "/bots/bot-a" } },
  });
  const off = await service.createForBot({ ...input, id: undefined, enabled: false });
  expect(off).toMatchObject({ status: "paused", nextRunAt: null });
  expect((await service.listForBot("bot-a")).map((s) => s.id).toSorted()).toEqual(
    [first.id, off.id].toSorted(),
  );
  expect(launcher.changes).toContain("bot-a");
  const updated = await service.updateForBot("bot-a", off.id, {
    enabled: true,
    runsIn: "chat",
    chatId: "chat-1",
  });
  expect(updated).toMatchObject({
    status: "active",
    bot: { botId: "bot-a", runsIn: "chat", chatId: "chat-1" },
  });
  await expect(service.inspectForBot("bot-b", first.id)).rejects.toThrow("Schedule not found");
  expect(await service.deleteForBot("bot-a")).toBe(2);
  expect(await service.list()).toEqual([]);
});

test("a paused bot's due slot waits, then runs once through the bot launcher", async () => {
  const start = Date.UTC(2026, 10, 27, 9);
  const { service, launcher, setTime } = await setup(start);
  const schedule = await service.createForBot({
    bot: { botId: "bot-a", runsIn: "home" },
    name: "Minute",
    prompt: "Check",
    cadence: CRON,
    enabled: true,
  });
  launcher.paused.add("bot-a");
  setTime(start + 61_000);
  await service.tick();
  expect(launcher.runs).toEqual([]);
  expect((await service.inspect(schedule.id)).runs).toEqual([]);
  await expect(service.runOnce(schedule.id)).rejects.toBeInstanceOf(ScheduleStateConflictError);

  launcher.paused.delete("bot-a");
  const ticked = service.tick();
  await expect.poll(() => launcher.runs.length).toBe(1);
  expect((await service.inspect(schedule.id)).runs[0]?.status).toBe("running");
  launcher.runs[0].finish({ agentId: null, output: "All green" });
  await ticked;
  const after = await service.inspect(schedule.id);
  expect(after.runs).toMatchObject([{ status: "succeeded", output: "All green" }]);
  expect(Date.parse(after.nextRunAt!)).toBeGreaterThan(start + 61_000);
  await service.tick();
  expect(launcher.runs).toHaveLength(1);

  // Run now returns once the run is recorded, not when the bot's turn ends.
  await service.startRunOnce(schedule.id);
  expect(launcher.runs).toHaveLength(2);
  expect((await service.inspect(schedule.id)).runs.at(-1)?.status).toBe("running");
  launcher.runs[1].finish({ agentId: null, output: null });
  await expect
    .poll(async () => (await service.inspect(schedule.id)).runs.at(-1)?.status)
    .toBe("succeeded");
});
