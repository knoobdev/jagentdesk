import { describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";
import { BotSchema } from "@jagentdesk/protocol/bots/types";
import { BotFormModel } from "./form-model";
import { ScheduleFormModel } from "./schedule-model";
import { RoomFormModel } from "./room-model";
const claude: ProviderSnapshotEntry = {
  provider: "claude",
  status: "ready",
  enabled: true,
  models: [
    { provider: "claude", id: "fast", label: "Fast" },
    { provider: "claude", id: "default", label: "Default", isDefault: true },
  ],
  modes: [{ id: "default", label: "Default" }],
  defaultModeId: "default",
};
const codex: ProviderSnapshotEntry = {
  provider: "codex",
  status: "ready",
  enabled: true,
  models: [{ provider: "codex", id: "codex-model", label: "Codex" }],
  modes: [{ id: "auto", label: "Auto" }],
};
function complete(model: BotFormModel) {
  model.set("name", "Fixer");
  model.set("slug", "fixer");
  model.set("identity", "Fix bugs");
  model.selectProvider(claude);
}
describe("bot form lifetime and permissions", () => {
  it("starts attended, validates a slug, and selects actual provider defaults", () => {
    const model = new BotFormModel(null);
    expect(model.input()).toBe(null);
    complete(model);
    expect(model.input()).toMatchObject({
      provider: "claude",
      model: "default",
      modeId: "default",
      unattended: false,
    });
    model.selectModel("fast", "Fast model label");
    expect(model.getState().modelLabel).toBe("Fast model label");
    model.set("slug", "Not a slug");
    expect(model.input()).toBe(null);
    model.set("slug", "valid-slug");
    model.set("interval", "0");
    expect(model.input()).toBe(null);
  });
  it("resets model and mode when changing provider while retaining user fields", () => {
    const model = new BotFormModel(null);
    complete(model);
    model.selectProvider(codex);
    expect(model.input()).toMatchObject({
      name: "Fixer",
      model: "codex-model",
      modeId: "auto",
      provider: "codex",
    });
  });
  it("opens fresh create state after editing an unattended bot", () => {
    const bot = BotSchema.parse({
      id: "b",
      name: "Existing",
      slug: "existing",
      identity: "Review",
      provider: "claude",
      model: "default",
      modeId: "default",
      unattended: true,
      paused: false,
      lookAround: { enabled: true, intervalMinutes: 5 },
      schedules: [],
      createdAt_ms: 1,
      updatedAt_ms: 1,
    });
    const edit = new BotFormModel(bot);
    expect(edit.getState()).toMatchObject({ name: "Existing", unattended: true, lookAround: true });
    const create = new BotFormModel(null);
    expect(create.getState()).toMatchObject({ name: "", provider: null, unattended: false });
  });
  it("publishes edits and tears down subscribers", () => {
    const model = new BotFormModel(null);
    const changed = vi.fn();
    const unsubscribe = model.subscribe(changed);
    model.set("name", "One");
    unsubscribe();
    model.set("name", "Two");
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
it("seeds cron timezone, prompt and enabled state from the selected schedule", () => {
  const model = new ScheduleFormModel({
    id: "s",
    name: "Weekly",
    cron: "0 9 * * 1",
    timezone: "Asia/Ho_Chi_Minh",
    prompt: "Review open work",
    enabled: false,
    nextRunAt_ms: 1,
  });
  expect(model.input()).toMatchObject({
    cron: "0 9 * * 1",
    timezone: "Asia/Ho_Chi_Minh",
    enabled: false,
  });
  model.set("prompt", "");
  expect(model.input()).toBe(null);
});
it("preserves room membership while toggling one member", () => {
  const model = new RoomFormModel({
    id: "r",
    name: "Reviewers",
    memberBotIds: ["a", "b"],
    messages: [],
  });
  model.toggleMember("a");
  model.toggleMember("c");
  expect(model.getState().memberBotIds).toEqual(["b", "c"]);
});
