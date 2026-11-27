// A bot's automations are core JAgentDesk schedules carrying `bot` (spec 37.2.6, ADR-0060 "Lịch
// (automation)"): the bots service reads and writes them through the schedule service and runs them
// through its own launch path. This file maps them to the bots wire shapes.
import type { BotSchedule } from "@jagentdesk/protocol/bots/types";
import type { BotAutomation } from "@jagentdesk/protocol/bots/views";
import { everyMsToFiveFieldCron } from "@jagentdesk/protocol/schedule/cadence";
import type { StoredSchedule } from "@jagentdesk/protocol/schedule/types";
import type { ScheduleService } from "../schedule/service.js";
import { BotsError } from "./home.js";

/** The schedule service as the bots service uses it. */
export type BotScheduleService = Pick<
  ScheduleService,
  | "createForBot"
  | "listForBot"
  | "inspectForBot"
  | "updateForBot"
  | "deleteForBot"
  | "delete"
  | "retargetBot"
  | "startRunOnce"
>;

/** Where a run's prompt goes: the Home Chat, one of the bot's chats, or a new conversation. */
export const BOT_RUNS_IN = ["home", "chat", "new"] as const;
export type BotRunsIn = (typeof BOT_RUNS_IN)[number];

export function botRunsIn(value: string | undefined): BotRunsIn {
  return BOT_RUNS_IN.find((entry) => entry === value) ?? "home";
}

/** Rejects a place the daemon doesn't know and a chat run without its chat. */
export function parseBotRunsIn(
  runsIn: string | undefined,
  chatId: string | undefined,
): { runsIn: BotRunsIn; chatId?: string } | undefined {
  if (runsIn === undefined) return undefined;
  const known = BOT_RUNS_IN.find((entry) => entry === runsIn);
  if (!known)
    throw new BotsError("invalid_argument", `runsIn must be one of ${BOT_RUNS_IN.join(", ")}`);
  if (known === "chat" && !chatId)
    throw new BotsError("invalid_argument", "A chat run needs the chat's id (chatId)");
  return known === "chat" ? { runsIn: known, chatId } : { runsIn: known };
}

function cronOf(schedule: StoredSchedule): { cron: string; timezone?: string } {
  const { cadence } = schedule;
  if (cadence.type === "cron")
    return {
      cron: cadence.expression,
      ...(cadence.timezone ? { timezone: cadence.timezone } : {}),
    };
  return { cron: everyMsToFiveFieldCron(cadence.everyMs) ?? `every ${cadence.everyMs} ms` };
}

/** The round-1 `BotSchedule` shape `bots.schedules.*` and `bot_automation_*` return. */
export function toBotSchedule(schedule: StoredSchedule): BotSchedule {
  const runsIn = botRunsIn(schedule.bot?.runsIn);
  return {
    id: schedule.id,
    name: schedule.name ?? schedule.prompt.slice(0, 100),
    ...cronOf(schedule),
    prompt: schedule.prompt,
    enabled: schedule.status === "active",
    nextRunAt_ms: schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : 0,
    runsIn,
    ...(runsIn === "chat" && schedule.bot?.chatId ? { chatId: schedule.bot.chatId } : {}),
  };
}

function rowState(schedule: StoredSchedule): BotAutomation["state"] {
  if (schedule.status === "completed") return "stopped";
  const last = schedule.runs.at(-1);
  if (last?.status === "running") return "running";
  if (last?.status === "failed") return "failed";
  return "idle";
}

/** A row of the panel's Automations (spec 37.4.4): Next, Running, Failed, Stopped. */
export function scheduleAutomationRow(schedule: StoredSchedule): BotAutomation {
  const enabled = schedule.status === "active";
  const row: BotAutomation = {
    id: schedule.id,
    kind: "schedule",
    name: schedule.name ?? schedule.prompt.slice(0, 100),
    when: cronOf(schedule).cron,
    state: rowState(schedule),
    enabled,
  };
  if (enabled && schedule.nextRunAt) row.nextAt_ms = Date.parse(schedule.nextRunAt);
  return row;
}

/** `z.guid()` agent ids only: a run records an agent id the wire schema accepts. */
export function runAgentId(agentId: string | undefined): string | null {
  return agentId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)
    ? agentId
    : null;
}
