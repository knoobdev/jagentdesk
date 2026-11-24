import { createHmac, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { expect, test } from "vitest";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { createTestJAgentDeskDaemon } from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { LocalSlackApi } from "./test-utils/slack-api.js";

// Start packages/relay's wrangler dev --local --port 8963 before this focused test.
// The Codex supervisor uses local Codex authentication, without provider gates or skips.
test("A37.8.1–A37.8.8: local Worker → isolated real Codex bot → local Slack Web API", async () => {
  const evidenceDir = fileURLToPath(new URL("../../../../../.dev/slack-evidence", import.meta.url));
  await mkdir(evidenceDir, { recursive: true });
  const token = `xoxb-local-${randomBytes(12).toString("hex")}`;
  const secret = randomBytes(32).toString("hex");
  const messageText = "Reply with exactly SLACK_LOCAL_OK. Do not use tools.";
  const logPath = join(evidenceDir, "daemon.log");
  const destination = pino.destination({ dest: logPath, sync: true });
  const logger = pino({ level: "info" }, destination);
  const api = new LocalSlackApi(token);
  await api.start();
  const provider = new CodexAppServerAgentClient(logger);
  const catalog = await provider.fetchCatalog({
    scope: "workspace",
    cwd: evidenceDir,
    force: false,
  });
  const model = catalog.models.find((m) => m.isDefault) ?? catalog.models[0];
  expect(model).toBeDefined();
  const daemon = await createTestJAgentDeskDaemon({
    listenPort: 6963,
    relay: { endpoint: "127.0.0.1:8963", useTls: false },
    slackApiBaseUrl: api.baseUrl,
    agentClients: { codex: provider },
    logger,
    botsTriggerSource: { poll: async () => [] },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.9.59",
  });
  let stopped = false;
  const proof: Record<string, unknown> = { port: daemon.port, provider: "codex", model: model.id };
  try {
    await client.connect();
    const bot = (
      await client.botsRequest("bots.create.request", {
        bot: {
          slug: "slack-local",
          name: "Slack Local",
          identity: "Answer Slack messages briefly. Do not use tools for this acceptance test.",
          provider: "codex",
          model: model.id,
          modeId: "auto",
          unattended: false,
        },
      })
    ).bot;
    await expect
      .poll(
        async () =>
          (await client.botsRequest("bots.slack.status.request", { botId: bot.id })).status
            .relayConnected,
        { timeout: 20000 },
      )
      .toBe(true);
    const manifest = await client.botsRequest("bots.slack.manifest.request", { botId: bot.id });
    expect(JSON.parse(manifest.manifest).settings.event_subscriptions.request_url).toBe(
      manifest.requestUrl,
    );
    await expect(
      client.botsRequest("bots.slack.connect.request", {
        botId: bot.id,
        botToken: "invalid",
        signingSecret: secret,
      }),
    ).rejects.toThrow("invalid_auth");
    await client.botsRequest("bots.slack.connect.request", {
      botId: bot.id,
      botToken: token,
      signingSecret: secret,
    });
    const post = async (
      payload: unknown,
      options: { timestamp?: number; signature?: string; url?: string; retry?: boolean } = {},
    ) => {
      const body = typeof payload === "string" ? payload : JSON.stringify(payload);
      const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
      const signature =
        options.signature ??
        `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
      return fetch(options.url ?? manifest.requestUrl, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-slack-signature": signature,
          "x-slack-request-timestamp": String(timestamp),
          ...(options.retry ? { "x-slack-retry-num": "1" } : {}),
        },
      });
    };
    const envelope = (id: string, event: Record<string, unknown>) => ({
      type: "event_callback",
      team_id: "T_LOCAL",
      event_id: id,
      event,
    });
    const mention = (user: string, text: string, ts = "1000.000001") => ({
      type: "app_mention",
      user,
      text,
      channel: "C_LOCAL",
      ts,
      thread_ts: ts,
    });
    expect((await post({ type: "url_verification", challenge: "local-challenge" })).status).toBe(
      200,
    );
    expect(
      await (await post({ type: "url_verification", challenge: "local-challenge" })).json(),
    ).toEqual({ challenge: "local-challenge" });
    expect((await post({}, { signature: "v0=" + "0".repeat(64) })).status).toBe(401);
    expect((await post({}, { timestamp: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await post("a".repeat(1024 * 1024 + 1))).status).toBe(413);
    expect(
      (await post({}, { url: manifest.requestUrl.replace(/[^/]+$/, "Z".repeat(43)) })).status,
    ).toBe(404);
    const denied = envelope("denied", mention("U_DENIED", "not authorized"));
    expect((await post(denied)).status).toBe(200);
    expect((await post(denied, { retry: true })).status).toBe(200);
    await expect.poll(() => api.posts.length).toBe(1);
    expect(api.posts[0]).toMatchObject({
      channel: "C_LOCAL",
      thread_ts: "1000.000001",
      text: "I only take requests from people my owner allowed.",
    });
    expect(
      (await client.botsRequest("bots.chat.history.request", { botId: bot.id })).messages,
    ).toEqual([]);
    const code = await client.botsRequest("bots.slack.link_code.request", { botId: bot.id });
    expect(code.code).toMatch(/^\d{6}$/);
    expect(
      (
        await post(
          envelope("link", {
            type: "message",
            channel_type: "im",
            channel: "D_LOCAL",
            user: "U_OWNER",
            ts: "1001.000001",
            text: code.code,
          }),
        )
      ).status,
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (await client.botsRequest("bots.slack.status.request", { botId: bot.id })).status
            .allowedUsers,
      )
      .toEqual([{ id: "U_OWNER", name: "Name U_OWNER" }]);
    const work = envelope("real-work", mention("U_OWNER", messageText, "1002.000001"));
    const start = performance.now();
    expect((await post(work)).status).toBe(200);
    const ackMs = performance.now() - start;
    expect(ackMs).toBeLessThanOrEqual(2500);
    expect((await post(work, { retry: true })).status).toBe(200);
    await expect
      .poll(() => api.posts.find((p) => p.thread_ts === "1002.000001")?.text, { timeout: 120000 })
      .toBe("SLACK_LOCAL_OK");
    const history = (await client.botsRequest("bots.chat.history.request", { botId: bot.id }))
      .messages;
    expect(history.filter((m) => m.role === "system")).toHaveLength(1);
    expect(history.filter((m) => m.role === "assistant")).toHaveLength(1);
    const supervisorId = (await client.botsRequest("bots.list.request", {})).bots[0].agentId!;
    expect(
      daemon.daemon.agentManager.getAgent(supervisorId)?.labels["jagentdesk.orchestration.role"],
    ).toBe("supervisor");
    const reply = api.posts.find((p) => p.thread_ts === "1002.000001")!;
    expect(reply.channel).toBe("C_LOCAL");
    const statusJson = JSON.stringify(
      await client.botsRequest("bots.slack.status.request", { botId: bot.id }),
    );
    const log = await readFile(logPath, "utf8");
    for (const forbidden of [token, secret, messageText]) {
      expect(statusJson).not.toContain(forbidden);
      expect(log).not.toContain(forbidden);
    }
    await client.setBuiltinPlugin("bots", false);
    await expect(
      client.botsRequest("bots.slack.status.request", { botId: bot.id }),
    ).rejects.toMatchObject({ code: "plugin_disabled" });
    await expect.poll(async () => (await post({})).status).toBe(404);
    await client.setBuiltinPlugin("bots", true);
    await expect
      .poll(async () => (await post({ type: "url_verification", challenge: "again" })).status)
      .toBe(200);
    await client.botsRequest("bots.slack.allowed.remove.request", {
      botId: bot.id,
      userId: "U_OWNER",
    });
    expect(
      (await client.botsRequest("bots.slack.status.request", { botId: bot.id })).status
        .allowedUsers,
    ).toEqual([]);
    await client.botsRequest("bots.slack.disconnect.request", { botId: bot.id });
    expect((await post({})).status).toBe(404);
    const next = await client.botsRequest("bots.slack.manifest.request", { botId: bot.id });
    expect(next.requestUrl).not.toBe(manifest.requestUrl);
    await client.botsRequest("bots.slack.connect.request", {
      botId: bot.id,
      botToken: token,
      signingSecret: secret,
    });
    await client.close();
    await daemon.close();
    stopped = true;
    await expect.poll(async () => (await post({}, { url: next.requestUrl })).status).toBe(503);
    Object.assign(proof, {
      botId: bot.id,
      supervisorId,
      ackMs,
      assertions: "A37.8.1–A37.8.8 passed",
      posts: api.posts,
      isolatedHome: daemon.jagentdeskHome,
    });
    await writeFile(join(evidenceDir, "proof.json"), JSON.stringify(proof, null, 2));
  } finally {
    await client.close();
    if (!stopped) await daemon.close();
    await api.close();
    destination.end();
  }
}, 180000);
