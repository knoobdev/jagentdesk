import { afterEach, describe, expect, it } from "vitest";
import { LocalTelegramApi, delivery, hookHarness } from "../test-utils/hook-harness.js";
import { BotsTelegram, splitTelegramText } from "./telegram.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});
const TOKEN = "123456:local-token-for-tests-only-abcdef";

async function setup() {
  const h = await hookHarness();
  cleanup.push(...h.cleanup);
  const api = new LocalTelegramApi(TOKEN);
  await api.start();
  cleanup.push(() => api.close());
  let now = Date.now();
  const telegram = new BotsTelegram(h.bots, {
    logger: h.logger,
    secrets: h.secrets,
    relay: h.relay,
    events: h.bus,
    apiBaseUrl: api.baseUrl,
    now: () => now,
  });
  cleanup.unshift(() => telegram.dispose());
  telegram.start();
  const frames: { type: string; hookId: string; kind?: string }[] = [];
  telegram.ready((frame) => {
    const value = frame as { type: string; hookId: string };
    frames.push(value);
    if (value.type === "hook_register")
      telegram.message({ type: "hook_registered", hookId: value.hookId });
    if (value.type === "hook_unregister")
      telegram.message({ type: "hook_unregistered", hookId: value.hookId });
  });
  const request = (type: string, extra: Record<string, unknown> = {}) =>
    telegram.handle({ type, requestId: "r", botId: h.bot.id, ...extra } as never) as Promise<
      Record<string, unknown>
    >;
  let updateId = 1;
  async function post(
    message: Record<string, unknown>,
    options: { secret?: string; updateId?: number } = {},
  ) {
    const status = (await request("bots.telegram.status.request")).status as { requestUrl: string };
    const id = options.updateId ?? updateId++;
    const response = await telegram.receive(
      delivery(
        "telegram",
        status.requestUrl.split("/").at(-1)!,
        JSON.stringify({ update_id: id, message }),
        {
          "x-telegram-bot-api-secret-token": options.secret ?? api.webhook.secret_token ?? "",
        },
      ),
    );
    await telegram.settled();
    await h.bots.settled();
    await telegram.settled();
    return response;
  }
  let messageId = 100;
  const dm = (text: string, from = { id: 42, first_name: "Dana", username: "dana" }) => ({
    message_id: messageId++,
    from,
    chat: { id: from.id, type: "private" },
    text,
  });
  const group = (text: string, extra: Record<string, unknown> = {}) => ({
    message_id: messageId++,
    from: { id: 42, first_name: "Dana", username: "dana" },
    chat: { id: -1001, type: "supergroup", title: "Team" },
    text,
    ...extra,
  });
  async function linkDana() {
    const { code } = (await request("bots.telegram.link_code.request")) as { code: string };
    await post(dm(code));
  }
  return {
    ...h,
    api,
    telegram,
    frames,
    request,
    post,
    dm,
    group,
    linkDana,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("Telegram connector (spec 37.12)", () => {
  it("A37.12.1: a wrong token shows Telegram's error and stores nothing; a good one connects and sets the webhook", async () => {
    const t = await setup();
    await expect(
      t.request("bots.telegram.connect.request", { token: "123456:wrong-token-wrong-token-wrong" }),
    ).rejects.toThrow("Unauthorized");
    expect(await t.secrets.get(`bots.telegram.credentials.${t.bot.id}`)).toBeNull();
    expect((await t.request("bots.telegram.status.request")).status).toMatchObject({
      connected: false,
    });
    const { status } = (await t.request("bots.telegram.connect.request", { token: TOKEN })) as {
      status: { connected: boolean; botUsername: string; requestUrl: string };
    };
    expect(status).toMatchObject({ connected: true, botUsername: "local_jad_bot" });
    expect(t.api.webhook.url).toBe(status.requestUrl);
    expect(t.api.webhook.secret_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(t.frames).toContainEqual(
      expect.objectContaining({ type: "hook_register", kind: "telegram" }),
    );
  });
  it("A37.12.2: right secret token → 200; wrong → 401; the same update_id twice → one turn", async () => {
    const t = await setup();
    await t.request("bots.telegram.connect.request", { token: TOKEN });
    await t.linkDana();
    expect((await t.post(t.dm("hello"), { secret: "wrong" })).status).toBe(401);
    expect((await t.post(t.dm("hello"), { updateId: 500 })).status).toBe(200);
    expect((await t.post(t.dm("hello"), { updateId: 500 })).status).toBe(200);
    expect(t.runtime.sent).toHaveLength(1);
  });
  it("A37.12.3: a linked user's DM gets the answer as a reply to that message", async () => {
    const t = await setup();
    await t.request("bots.telegram.connect.request", { token: TOKEN });
    await t.linkDana();
    expect(t.api.sent.map((m) => m.text)).toEqual(["Your Telegram account is linked."]);
    const message = t.dm("list open items");
    await t.post(message);
    expect(t.runtime.sent[0].text).toContain("list open items");
    expect(t.runtime.sent[0].text).toContain("[Telegram DM: Dana]");
    t.runtime.finish(t.bot, "turn-1", "Nothing open.");
    await t.bots.settled();
    await t.telegram.settled();
    expect(t.api.sent.at(-1)).toMatchObject({
      chat_id: "42",
      text: "Nothing open.",
      reply_parameters: { message_id: message.message_id },
    });
    const status = (await t.request("bots.telegram.status.request")).status as {
      allowedUsers: unknown[];
    };
    expect(status.allowedUsers).toEqual([{ id: "42", name: "Dana", username: "dana" }]);
    expect(t.telegram.summary(t.bot.id)).toEqual({ connected: true, label: "@local_jad_bot" });
  });
  it("A37.12.4: in a group, a message that does not address the bot is ignored; @bot from an allowed user is one turn and a reply there", async () => {
    const t = await setup();
    await t.request("bots.telegram.connect.request", { token: TOKEN });
    await t.linkDana();
    await t.post(t.group("lunch?"));
    expect(t.runtime.sent).toHaveLength(0);
    const text = "@local_jad_bot what broke?";
    const mention = t.group(text, {
      entities: [{ type: "mention", offset: 0, length: 14 }],
      message_thread_id: 5,
      is_topic_message: true,
    });
    await t.post(mention);
    expect(t.runtime.sent).toHaveLength(1);
    expect(t.runtime.sent[0].text).toContain("what broke?");
    t.runtime.finish(t.bot, "turn-1", "The deploy.");
    await t.bots.settled();
    await t.telegram.settled();
    expect(t.api.sent.at(-1)).toMatchObject({
      chat_id: "-1001",
      reply_parameters: { message_id: mention.message_id },
      message_thread_id: 5,
    });
    // A reply to the bot's message continues the same thread.
    const botMessage = t.api.sent.at(-1)!.message_id;
    await t.post(
      t.group("and why?", {
        reply_to_message: { message_id: botMessage, from: { id: 777, is_bot: true } },
        message_thread_id: 5,
        is_topic_message: true,
      }),
    );
    expect(t.runtime.sent).toHaveLength(2);
    expect(t.runtime.sent[1].text).toContain("Earlier in this Telegram chat");
    // /ask@bot also addresses it.
    await t.post(
      t.group("/ask@local_jad_bot status", {
        entities: [{ type: "bot_command", offset: 0, length: 18 }],
      }),
    );
    expect(t.events.map((e) => e.event)).toEqual(["mentioned", "mentioned", "mentioned"]);
  });
  it("A37.12.5: someone not allowed DMs twice in an hour → exactly one refusal, 0 turns", async () => {
    const t = await setup();
    await t.request("bots.telegram.connect.request", { token: TOKEN });
    const stranger = { id: 66, first_name: "Eve" };
    await t.post(t.dm("hi", stranger));
    t.advance(30 * 60_000);
    await t.post(t.dm("hello?", stranger));
    expect(t.runtime.sent).toHaveLength(0);
    expect(t.api.sent.map((m) => m.text)).toEqual([
      "I only take requests from people my owner allowed.",
    ]);
  });
  it("A37.12.6: a 5 000-character answer is sent as 2 messages, in order", async () => {
    const t = await setup();
    await t.request("bots.telegram.connect.request", { token: TOKEN });
    await t.linkDana();
    await t.post(t.dm("write a lot"));
    const answer = `${"a".repeat(4096)}${"b".repeat(904)}`;
    t.runtime.finish(t.bot, "turn-1", answer);
    await t.bots.settled();
    await t.telegram.settled();
    const parts = t.api.sent.slice(1);
    expect(parts.map((m) => m.text.length)).toEqual([4096, 904]);
    expect(parts.map((m) => m.text).join("")).toBe(answer);
    expect(
      splitTelegramText(`${"x".repeat(3000)}\n${"y".repeat(3000)}`).map((p) => p.length),
    ).toEqual([3000, 3000]);
  });
  it("A37.12.7: Disconnect empties the webhook, retires the hookId, and status/logs never show the token", async () => {
    const t = await setup();
    await t.request("bots.telegram.connect.request", { token: TOKEN });
    const before = (await t.request("bots.telegram.status.request")).status as {
      requestUrl: string;
    };
    const hookId = before.requestUrl.split("/").at(-1);
    await t.request("bots.telegram.disconnect.request");
    expect(t.api.webhook.url).toBe("");
    expect(t.frames).toContainEqual({ type: "hook_unregister", v: 1, hookId });
    expect(await t.secrets.get(`bots.telegram.credentials.${t.bot.id}`)).toBeNull();
    const status = JSON.stringify(await t.request("bots.telegram.status.request"));
    expect(status).not.toContain(TOKEN);
    expect(status).not.toContain("local-token");
    expect(t.logs.join("")).not.toContain("local-token");
  });
});
