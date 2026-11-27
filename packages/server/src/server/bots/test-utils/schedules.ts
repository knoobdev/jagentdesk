// The real core schedule service for bots service tests. A bot schedule runs through the bots
// service's launcher, so the agent-run dependencies plain schedules need are never reached.
import pino from "pino";
import { ScheduleService, type ScheduleServiceOptions } from "../../schedule/service.js";
import type { BotsService } from "../service.js";

function unused(name: string): never {
  throw new Error(`${name} is not used by bot schedules`);
}

export function attachBotSchedules(input: {
  service: BotsService;
  home: string;
  now?: () => Date;
}): ScheduleService {
  const schedules = new ScheduleService({
    jagentdeskHome: input.home,
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
    ...(input.now ? { now: input.now } : {}),
  });
  input.service.schedules = schedules;
  schedules.setBotLauncher(input.service.scheduleLauncher());
  return schedules;
}
