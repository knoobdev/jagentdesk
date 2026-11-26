import { describe, expect, it, vi } from "vitest";
import type { ProviderSnapshotEntry } from "@jagentdesk/protocol/agent-types";
import { BotSchema } from "@jagentdesk/protocol/bots/types";
import { BotFormModel, IDENTITY_MAX, slugFromName } from "./form-model";
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
const current = { optionalIdentity: true };
function complete(model: BotFormModel) {
  model.setName("Fixer");
  model.set("identity", "Fix bugs");
  model.selectProvider(claude);
}
describe("bot form lifetime and permissions", () => {
  it("starts attended, validates a slug, and selects actual provider defaults", () => {
    const model = new BotFormModel(null);
    expect(model.input(current)).toBe(null);
    complete(model);
    expect(model.input(current)).toMatchObject({
      provider: "claude",
      model: "default",
      modeId: "default",
      unattended: false,
    });
    model.selectModel("fast", "Fast model label");
    expect(model.getState().modelLabel).toBe("Fast model label");
    model.setSlug("Not a slug");
    expect(model.input(current)).toBe(null);
    model.setSlug("valid-slug");
    model.set("interval", "0");
    expect(model.input(current)).toMatchObject({
      lookAround: { enabled: false, intervalMinutes: 60 },
    });
    model.set("lookAround", true);
    expect(model.validation().errors).toEqual({ interval: "bots.errors.interval" });
    expect(model.input(current)).toBe(null);
  });
  it("resets model and mode when changing provider while retaining user fields", () => {
    const model = new BotFormModel(null);
    complete(model);
    model.selectProvider(codex);
    expect(model.input(current)).toMatchObject({
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
  it("A37.5.1: creates with Identity and Default repository empty", () => {
    const model = new BotFormModel(null);
    model.setName("heocon");
    model.selectProvider(claude);
    expect(model.validation()).toEqual({ errors: {}, missing: null });
    const input = model.input(current);
    expect(input).toMatchObject({ name: "heocon", slug: "heocon", identity: "" });
    expect(input?.defaultRepo).toBeUndefined();
  });
  it("A37.5.1 on an older host: sends the name as the identity", () => {
    const model = new BotFormModel(null);
    model.setName("heocon");
    model.selectProvider(claude);
    expect(model.input({ optionalIdentity: false })).toMatchObject({ identity: "heocon" });
  });
  it("A37.5.2: a bad slug gets its own error and no look-around sentence while look-around is off", () => {
    const model = new BotFormModel(null);
    model.setName("Heo Con");
    expect(model.getState().slug).toBe("heo-con");
    model.setSlug("Heo Con");
    model.selectProvider(claude);
    expect(model.validation()).toEqual({ errors: { slug: "bots.errors.slug" }, missing: null });
    model.set("interval", "");
    expect(model.validation().errors.interval).toBeUndefined();
    expect(model.input(current)).toBe(null);
  });
  it("A37.5.3: 501 identity characters fail under Identity, 500 pass", () => {
    const model = new BotFormModel(null);
    complete(model);
    model.set("identity", "x".repeat(IDENTITY_MAX + 1));
    expect(model.validation().errors).toEqual({ identity: "bots.errors.identityTooLong" });
    expect(model.input(current)).toBe(null);
    model.set("identity", "x".repeat(IDENTITY_MAX));
    expect(model.validation().errors).toEqual({});
    expect(model.input(current)?.identity).toHaveLength(IDENTITY_MAX);
  });
  it("derives the slug from the name until the owner edits it", () => {
    expect(slugFromName("  Heo Con!  ")).toBe("heo-con");
    expect(slugFromName("Đội Trưởng Bot")).toBe("doi-truong-bot");
    expect(slugFromName("x".repeat(70))).toHaveLength(64);
    const model = new BotFormModel(null);
    model.setName("Review Bot");
    expect(model.getState().slug).toBe("review-bot");
    model.setSlug("rb");
    model.setName("Review Bot 2");
    expect(model.getState().slug).toBe("rb");
    model.setSlug("");
    expect(model.getState()).toMatchObject({ slug: "review-bot-2", slugEdited: false });
  });
  it("names the first missing required field and blocks Create", () => {
    const model = new BotFormModel(null);
    expect(model.validation().missing).toBe("bots.required.name");
    model.setName("Fixer");
    expect(model.validation().missing).toBe("bots.required.provider");
    model.selectProvider({ ...claude, models: [] });
    expect(model.validation().missing).toBe("bots.required.model");
    expect(model.input(current)).toBe(null);
  });
  it("keeps an edited bot's slug when its name changes", () => {
    const bot = BotSchema.parse({
      id: "b",
      name: "Existing",
      slug: "existing",
      identity: "Review",
      provider: "claude",
      model: "default",
      modeId: "default",
      paused: false,
      unattended: false,
      lookAround: { enabled: false, intervalMinutes: 5 },
      schedules: [],
      createdAt_ms: 1,
      updatedAt_ms: 1,
    });
    const edit = new BotFormModel(bot);
    edit.setName("Renamed");
    expect(edit.getState().slug).toBe("existing");
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
