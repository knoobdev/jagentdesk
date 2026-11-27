import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { BotsSharing } from "../sharing/service.js";
import { FakeForgeCli, delivery, hookHarness } from "../test-utils/hook-harness.js";
import { BotsHookConnectors } from "./connectors.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

/** bt1's BotsService with bt4's connectors and bt5's sharing wired the way bootstrap wires them. */
async function setup() {
  const h = await hookHarness();
  cleanup.push(...h.cleanup);
  const hooks: { id: number; config: { secret: string } }[] = [];
  const gh = new FakeForgeCli((method, path, body) => {
    if (method === "GET" && path === "user") return { login: "owner-login" };
    if (method === "POST" && /^repos\/[^/]+\/[^/]+\/hooks$/.test(path)) {
      const hook = { id: 101 + hooks.length, ...(body as { config: { secret: string } }) };
      hooks.push(hook);
      return { id: hook.id };
    }
    if (method === "DELETE") return undefined;
    return { status: 404 };
  });
  const connectors = new BotsHookConnectors(h.bots, undefined, {
    logger: h.logger,
    secrets: h.secrets,
    relay: h.relay,
    events: h.bus,
    gh: gh.run,
  });
  h.bots.hooks = connectors;
  h.bots.sharing = new BotsSharing(h.bots, {
    logger: h.logger,
    relay: h.relay,
    secrets: h.secrets,
  });
  cleanup.unshift(() => connectors.dispose());
  connectors.start();
  connectors.controlHandler().ready((frame) => {
    const value = frame as { type: string; hookId: string };
    if (value.type === "hook_register")
      connectors.controlHandler().message({ type: "hook_registered", hookId: value.hookId });
  });
  const request = (type: string, extra: Record<string, unknown> = {}) =>
    h.bots.handle({ type, requestId: "r", botId: h.bot.id, ...extra } as never);
  return { ...h, connectors, hooks, request };
}

describe("connectors on the bot record (bots contract)", () => {
  it("bots.list fills Bot.github/gitlab/telegram from the connectors and Bot.share from the link", async () => {
    const t = await setup();
    const before = (await t.request("bots.list.request")).bots as Record<string, unknown>[];
    expect(before[0]).toMatchObject({
      github: { connected: false },
      gitlab: { connected: false },
      telegram: { connected: false },
      share: { shared: false },
    });

    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    const body = JSON.stringify({
      zen: "hi",
      hook_id: 101,
      repository: { full_name: "octo/test-repo" },
    });
    const hookId = (
      (await t.request("bots.github.status.request")).status as { requestUrl: string }
    ).requestUrl
      .split("/")
      .at(-1)!;
    await t.connectors.github.receive(
      delivery("github", hookId, body, {
        "x-github-event": "ping",
        "x-github-delivery": "ping-1",
        "x-hub-signature-256": `sha256=${createHmac("sha256", t.hooks[0].config.secret).update(body).digest("hex")}`,
      }),
    );
    await t.connectors.settled();
    t.bots.storage.setState(`share:link:${t.bot.id}`, {
      shareId: "s".repeat(22),
      origin: "http://127.0.0.1:8963",
      publishedAt_ms: 1000,
      updatedAt_ms: 2000,
      botDigest: "d",
      selection: {},
    });

    const listed = (await t.request("bots.list.request")).bots as Record<string, unknown>[];
    expect(listed[0]).toMatchObject({
      github: { connected: true, label: "octo/test-repo" },
      share: { shared: true, updatedAt_ms: 2000 },
    });
    const paused = (await t.request("bots.pause.request", { paused: true })).bot;
    expect(paused).toMatchObject({ github: { connected: true }, share: { shared: true } });
  });

  it("Needs you shows a GitHub row while a hook target is not connected", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    const { rows } = await t.request("bots.needs_you.list.request");
    expect(rows).toContainEqual(
      expect.objectContaining({
        kind: "connector",
        connector: "github",
        title: "GitHub needs you to sign in again or fix it.",
      }),
    );
  });

  it("bots.allowed.list carries the GitHub Who can ask people", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    await t.request("bots.github.allowed.add.request", { login: "Carol" });
    const { people } = await t.request("bots.allowed.list.request");
    expect(people).toEqual([
      { source: "github", id: "owner-login", name: "owner-login" },
      { source: "github", id: "Carol", name: "Carol" },
    ]);
  });
});

describe("event automations (spec 37.2.6)", () => {
  it("a connector event reaches the bot's event automations through BotsHookConnectors", async () => {
    const t = await setup();
    const automation = t.bots.saveEventAutomation(t.bot.id, {
      name: "Hello",
      source: "telegram",
      event: "message",
      prompt: "Say hello.",
      enabled: true,
    });
    const event = {
      botId: t.bot.id,
      source: "telegram" as const,
      event: "message",
      key: "u-1",
      occurredAt: 1,
    };
    t.connectors.events.emit(event);
    t.connectors.events.emit(event);
    await t.bots.settled();
    expect(t.runtime.sent).toHaveLength(1);
    expect(t.runtime.sent[0].text).toContain("Say hello.");

    await t.request("bots.pause.request", { paused: true });
    t.connectors.events.emit({ ...event, key: "u-2" });
    await t.bots.settled();
    expect(t.bots.storage.pending(t.bot.id)).toHaveLength(0);

    await expect(
      t.request("bots.automations.run_now.request", { automationId: automation.id }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    await t.request("bots.schedules.delete.request", { scheduleId: automation.id });
    expect(t.bots.automations(t.bot.id).automations.some((row) => row.event)).toBe(false);
  });

  it("refuses an event the source does not have", async () => {
    const t = await setup();
    expect(() =>
      t.bots.saveEventAutomation(t.bot.id, {
        name: "Nope",
        source: "telegram",
        event: "ci_failed",
        prompt: "x",
        enabled: true,
      }),
    ).toThrow(/Unknown telegram event/);
  });
});
