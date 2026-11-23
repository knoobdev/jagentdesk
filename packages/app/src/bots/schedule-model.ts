import {
  BotScheduleInputSchema,
  type BotSchedule,
  type BotScheduleInput,
} from "@jagentdesk/protocol/bots/types";
export class ScheduleFormModel {
  private listeners = new Set<() => void>();
  private state: BotScheduleInput;
  constructor(schedule: BotSchedule | null) {
    this.state = {
      name: schedule?.name ?? "",
      cron: schedule?.cron ?? "",
      timezone: schedule?.timezone ?? "UTC",
      prompt: schedule?.prompt ?? "",
      enabled: schedule?.enabled ?? true,
    };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  set<K extends keyof BotScheduleInput>(key: K, value: BotScheduleInput[K]) {
    this.state = { ...this.state, [key]: value };
    for (const listener of this.listeners) listener();
  }
  input() {
    const result = BotScheduleInputSchema.safeParse(this.state);
    return result.success ? result.data : null;
  }
}
