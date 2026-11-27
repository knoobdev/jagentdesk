import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import pino from "pino";
import { afterEach, expect, it } from "vitest";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotExternalMessage } from "./runtime.js";
import { FakeBotRuntime } from "./test-utils/fake-runtime.js";
import { BotStorage } from "./storage.js";
import { BotsService } from "./service.js";
import { BotsSlack } from "./slack.js";
import { MemorySecretStore } from "../database/secret-store.js";
import { LocalSlackApi } from "./test-utils/slack-api.js";
/** The Slack path's runtime: sends start a turn until the test finishes it. */
class Runtime extends FakeBotRuntime {
  readonly external: { text: string; source?: BotExternalMessage }[] = [];
  running = false;
  override busy(): boolean {
    return this.running;
  }
  override async send(
    id: string,
    text: string,
    _messageId?: string,
    _sourceId?: string,
    source?: BotExternalMessage,
  ): Promise<void> {
    source?.beforeDispatch();
    this.running = true;
    this.external.push({ text, source });
    this.sent.push({ id, text });
  }
  override async cancel(): Promise<void> {
    this.running = false;
  }
  finish(bot: Bot, key: string, text: string): void {
    this.running = false;
    this.emit({ agentId: `supervisor:${bot.id}`, key, text, kind: "done" });
  }
}
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
async function setup() {
  const home = mkdtempSync(join(tmpdir(), "slack-service-"));
  const runtime = new Runtime();
  const logger = pino({ level: "silent" });
  const bots = new BotsService(new BotStorage(home), runtime, { logger });
  const api = new LocalSlackApi("local-token");
  await api.start();
  const secrets = new MemorySecretStore();
  let now = Date.now();
  const slack = new BotsSlack(bots, {
    logger,
    secrets,
    relay: () => ({ endpoint: "127.0.0.1:8963", serverId: "local", enabled: true, useTls: false }),
    apiBaseUrl: api.baseUrl,
    now: () => now,
  });
  bots.slack = slack;
  cleanup.push(async () => {
    await slack.dispose();
    await bots.dispose();
    await api.close();
    rmSync(home, { recursive: true, force: true });
  });
  const bot = await bots.create(
    {
      slug: "local",
      name: "Local",
      identity: "Test",
      provider: "codex",
      model: "local",
      modeId: "default",
    },
    { kickoff: null },
  );
  slack.start();
  bots.start();
  await slack.handle({
    type: "bots.slack.connect.request",
    requestId: "connect",
    botId: bot.id,
    botToken: "local-token",
    signingSecret: "local-secret",
  });
  const hookId = slack.status(bot.id).requestUrl!.split("/").at(-1)!;
  async function receive(eventId: string, event: Record<string, unknown>) {
    const body = JSON.stringify({
      type: "event_callback",
      team_id: "T_LOCAL",
      event_id: eventId,
      event,
    });
    const timestamp = String(Math.floor(now / 1000));
    const response = await slack.receive({
      type: "hook_delivery",
      v: 1,
      deliveryId: eventId,
      hookId,
      kind: "slack",
      bodyB64: Buffer.from(body).toString("base64"),
      receivedAt_ms: now,
      headers: {
        "x-slack-request-timestamp": timestamp,
        "x-slack-signature": `v0=${createHmac("sha256", "local-secret").update(`v0:${timestamp}:${body}`).digest("hex")}`,
      },
    });
    await slack.settled();
    await bots.settled();
    await slack.settled();
    return response;
  }
  const dm = (text: string, user = "U_OWNER") => ({
    type: "message",
    channel_type: "im",
    channel: "D_LOCAL",
    ts: "1000.1",
    user,
    text,
  });
  async function link() {
    const result = await slack.handle({
      type: "bots.slack.link_code.request",
      requestId: "code",
      botId: bot.id,
    });
    await receive("link", dm(String(result.code)));
  }
  return {
    bots,
    slack,
    runtime,
    api,
    bot,
    secrets,
    receive,
    dm,
    link,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("denies unlinked senders once per event, links a DM code, queues with provenance and replies in the same thread", async () => {
  const { bots, slack, runtime, api, bot, receive, dm, link } = await setup();
  expect((await receive("denied", dm("hello"))).status).toBe(200);
  await receive("denied", dm("hello"));
  expect(api.posts.map((p) => p.text)).toEqual([
    "I only take requests from people my owner allowed.",
  ]);
  expect(runtime.external).toEqual([]);
  await link();
  expect(slack.status(bot.id).allowedUsers).toEqual([{ id: "U_OWNER", name: "Name U_OWNER" }]);
  await receive("work", {
    type: "app_mention",
    channel: "C_LOCAL",
    thread_ts: "42.1",
    ts: "43.1",
    text: "hello",
    user: "U_OWNER",
  });
  expect(runtime.external).toHaveLength(1);
  expect(runtime.external[0].source).toMatchObject({
    senderId: "slack:U_OWNER",
    title: "Slack: Name U_OWNER in #C_LOCAL",
  });
  runtime.finish(bot, "turn1", "Answer");
  await bots.settled();
  await slack.settled();
  expect(api.posts.at(-1)).toMatchObject({ channel: "C_LOCAL", thread_ts: "42.1", text: "Answer" });
  const posted = api.posts.at(-1)!;
  await receive("react", {
    type: "reaction_added",
    user: "U_OWNER",
    item_user: "U_BOT",
    reaction: "thumbsup",
    item: { type: "message", channel: "C_LOCAL", ts: posted.ts },
  });
  await bots.tick();
  await bots.settled();
  expect(runtime.external).toHaveLength(2);
  expect(runtime.external[1].text).toContain("Slack reaction :thumbsup: by Name U_OWNER");
  runtime.finish(bot, "turn2", "Thanks");
  await bots.settled();
  await slack.settled();
  expect(api.posts.at(-1)).toMatchObject({ thread_ts: "42.1", text: "Thanks" });
  await receive("not-bot", {
    type: "reaction_added",
    user: "U_OWNER",
    item_user: "U_OTHER",
    reaction: "thumbsup",
    item: { type: "message", channel: "C_LOCAL", ts: "30.1" },
  });
  expect(runtime.external).toHaveLength(2);
});
it("expires codes, removes users, and deletes credentials on disconnect", async () => {
  const { slack, secrets, bot, runtime, receive, dm, advance, link } = await setup();
  const code = await slack.handle({
    type: "bots.slack.link_code.request",
    requestId: "code",
    botId: bot.id,
  });
  advance(600_001);
  await receive("expired", dm(String(code.code)));
  expect(slack.status(bot.id).allowedUsers).toEqual([]);
  expect(runtime.external).toEqual([]);
  await link();
  await slack.handle({
    type: "bots.slack.allowed.remove.request",
    requestId: "remove",
    botId: bot.id,
    userId: "U_OWNER",
  });
  expect(slack.status(bot.id).allowedUsers).toEqual([]);
  await slack.disconnect(bot.id);
  expect(await secrets.get(`bots.slack.credentials.${bot.id}`)).toBeNull();
  expect(slack.status(bot.id)).toMatchObject({
    connected: false,
    requestUrl: undefined,
    allowedUsers: [],
  });
});
it("keeps retries deduplicated for 24 hours, emits a needs-you note and gates ingress while disabled", async () => {
  const { bots, slack, runtime, api, bot, receive, dm, advance, link } = await setup();
  await link();
  await receive("work", dm("first"));
  await receive("work", dm("first"));
  const item = bots.addItem(bot.id, "Question", "Answer required");
  bots.setItem(bot.id, item.id, {
    status: "needs_you",
    questions: [{ text: "Proceed?", options: ["Yes", "No"] }],
  });
  await slack.settled();
  expect(api.posts.at(-1)?.text).toBe("Waiting for my owner in JAgentDesk.");
  runtime.finish(bot, "turn1", "Done");
  await bots.settled();
  await slack.settled();
  expect(runtime.external).toHaveLength(1);
  advance(86_400_001);
  await receive("work", dm("later"));
  await bots.tick();
  await bots.settled();
  // The bot message id remains idempotent even after the Slack receipt expires.
  expect(runtime.external).toHaveLength(1);
  slack.stop();
  expect((await receive("disabled", dm("ignored"))).status).toBe(503);
});
