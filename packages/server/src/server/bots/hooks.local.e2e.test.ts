import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import {
  createTestJAgentDeskDaemon,
  type TestJAgentDeskDaemon,
} from "../test-utils/jagentdesk-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { FakeForgeCli, LocalTelegramApi } from "./test-utils/hook-harness.js";
import { createBotsTestProvider } from "./test-utils/provider.js";

// Start packages/relay's `wrangler dev --local --port 8972` before this focused test.
// GitHub, GitLab and Telegram are local simulators: nothing here reaches a real service or account.
const WORKER = "127.0.0.1:8972";
const DAEMON_PORT = 6972;
const ANSWER = "Available for another question.";
const evidenceDir = fileURLToPath(new URL("../../../../../.dev/hooks-evidence", import.meta.url));
const proof: Record<string, unknown> = {};

/** GitHub as seen by the owner's `gh`: hooks it holds, and deliveries it made to their URLs. */
class GitHubSimulator {
  readonly hooks: { id: number; repo: string; url: string; secret: string; events: string[] }[] =
    [];
  readonly deliveries: {
    id: number;
    hookId: number;
    guid: string;
    event: string;
    body: string;
    delivered_at: string;
    status_code: number;
  }[] = [];
  readonly comments: { repo: string; number: number; body: string }[] = [];
  private nextDelivery = 1;
  readonly cli = new FakeForgeCli((method, path, body) => this.route(method, path, body));
  private route(method: string, path: string, body: unknown): unknown {
    const input = body as Record<string, never>;
    if (method === "GET" && path === "user") return { login: "owner-login" };
    let match = /^repos\/([^/]+\/[^/]+)\/hooks$/.exec(path);
    if (method === "POST" && match) {
      const config = (input as { config: { url: string; secret: string } }).config;
      const hook = {
        id: 100 + this.hooks.length,
        repo: match[1],
        url: config.url,
        secret: config.secret,
        events: (input as { events: string[] }).events,
      };
      this.hooks.push(hook);
      return { id: hook.id };
    }
    match = /^repos\/[^/]+\/[^/]+\/hooks\/(\d+)$/.exec(path);
    if (method === "PATCH" && match) {
      const hook = this.hooks.find((h) => h.id === Number(match![1]))!;
      hook.secret = (input as { config: { secret: string } }).config.secret;
      return { id: hook.id };
    }
    if (method === "DELETE" && match) {
      this.hooks.splice(
        this.hooks.findIndex((h) => h.id === Number(match![1])),
        1,
      );
      return undefined;
    }
    match = /^repos\/[^/]+\/[^/]+\/hooks\/(\d+)\/deliveries\?per_page=100$/.exec(path);
    if (method === "GET" && match)
      return this.deliveries
        .filter((d) => d.hookId === Number(match![1]))
        .map(({ body: _b, ...d }) => d);
    match = /^repos\/[^/]+\/[^/]+\/hooks\/(\d+)\/deliveries\/(\d+)\/attempts$/.exec(path);
    if (method === "POST" && match) {
      const original = this.deliveries.find((d) => d.id === Number(match![2]))!;
      void this.deliver(original.hookId, original.event, JSON.parse(original.body), original.guid);
      return {};
    }
    match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    if (method === "POST" && match) {
      this.comments.push({
        repo: match[1],
        number: Number(match[2]),
        body: (input as { body: string }).body,
      });
      return { id: 9000 + this.comments.length };
    }
    return { status: 404 };
  }
  /** One webhook delivery, signed with the hook's secret unless told otherwise. */
  async deliver(
    hookId: number,
    event: string,
    payload: unknown,
    guid = randomUUID(),
    secret?: string,
  ) {
    const hook = this.hooks.find((h) => h.id === hookId)!;
    const body = JSON.stringify(payload);
    const started = Date.now();
    const response = await fetch(hook.url, {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": guid,
        "x-github-hook-id": String(hookId),
        "x-hub-signature-256": `sha256=${createHmac("sha256", secret ?? hook.secret)
          .update(body)
          .digest("hex")}`,
      },
    });
    this.deliveries.push({
      id: this.nextDelivery++,
      hookId,
      guid,
      event,
      body,
      delivered_at: new Date().toISOString(),
      status_code: response.status,
    });
    return { status: response.status, ms: Date.now() - started };
  }
}

let homeRoot: string;
let daemon: TestJAgentDeskDaemon | undefined;
let client: DaemonClient | undefined;
let logPath: string;
let botId: string;
const github = new GitHubSimulator();
const gitlabNotes: { path: string; body: string }[] = [];
const gitlabHooks: { id: number; url: string; token: string }[] = [];
const glab = new FakeForgeCli((method, path, body) => {
  const input = body as Record<string, string>;
  if (method === "GET" && path === "user") return { username: "owner" };
  if (method === "GET" && path === "projects/grp%2Fapp")
    return { id: 15, path_with_namespace: "grp/app" };
  if (method === "POST" && path === "projects/15/hooks") {
    gitlabHooks.push({ id: 31, url: input.url, token: input.token });
    return { id: 31 };
  }
  if (method === "POST" && path.endsWith("/notes")) {
    gitlabNotes.push({ path, body: input.body });
    return { id: 700 + gitlabNotes.length };
  }
  if (method === "DELETE") return undefined;
  return { status: 404 };
});
const TELEGRAM_TOKEN = `424242:${randomBytes(18).toString("base64url")}`;
const telegram = new LocalTelegramApi(TELEGRAM_TOKEN);

function sentTexts(): string[] {
  return telegram.sent.map((m) => m.text);
}
function countSent(key: "text" | "chat_id", value: string): number {
  return telegram.sent.filter((m) => m[key] === value).length;
}
async function startDaemon(): Promise<void> {
  const logger = pino(
    { level: "info" },
    pino.destination({ dest: logPath, sync: true, append: true }),
  );
  const provider = createBotsTestProvider();
  daemon = await createTestJAgentDeskDaemon({
    listenPort: DAEMON_PORT,
    jagentdeskHomeRoot: homeRoot,
    cleanup: false,
    relay: { endpoint: WORKER, useTls: false },
    agentClients: { ...createTestAgentClients(), claude: provider.client },
    botsTriggerSource: { poll: async () => [] },
    telegramApiBaseUrl: telegram.baseUrl,
    botsGh: github.cli.run,
    botsGlab: glab.run,
    logger,
  });
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.9.59" });
  await client.connect();
}
async function stopDaemon(): Promise<void> {
  await client?.close();
  await daemon?.close();
  client = undefined;
  daemon = undefined;
}
// The e2e drives raw RPC names; results are read as the wire JSON.
// oxlint-disable-next-line typescript/no-explicit-any -- SAFETY: test-only wire access
function rpc(type: string, params: Record<string, unknown>): Promise<any> {
  return (client!.botsRequest as (t: string, p: Record<string, unknown>) => Promise<unknown>)(
    type,
    params,
  );
}
async function waitRelay(type: string): Promise<void> {
  await expect
    .poll(async () => (await rpc(type, { botId })).status.relayConnected, { timeout: 20_000 })
    .toBe(true);
}
async function history(): Promise<{ role: string; text: string; source: string }[]> {
  return (await rpc("bots.chat.history.request", { botId, limit: 200 })).messages;
}

beforeAll(async () => {
  await mkdir(evidenceDir, { recursive: true });
  logPath = join(evidenceDir, "daemon.log");
  await writeFile(logPath, "");
  homeRoot = await mkdtemp(join(tmpdir(), "bt4-hooks-home-"));
  await telegram.start();
  await startDaemon();
  const bot = await rpc("bots.create.request", {
    bot: {
      slug: "scout",
      name: "Scout",
      identity: "Answer briefly.",
      provider: "claude",
      model: "haiku",
      modeId: "default",
    },
  });
  botId = bot.bot.id;
}, 60_000);
afterAll(async () => {
  await stopDaemon();
  await telegram.close();
  await writeFile(join(evidenceDir, "proof.json"), JSON.stringify(proof, null, 2));
  await rm(homeRoot, { recursive: true, force: true });
});

describe.sequential("bot hooks through wrangler dev (spec 37.9–37.12)", () => {
  test("A37.12.1–A37.12.7 Telegram", async () => {
    await waitRelay("bots.telegram.status.request");
    await expect(
      rpc("bots.telegram.connect.request", { botId, token: "424242:not-the-right-token-at-all" }),
    ).rejects.toThrow("Unauthorized");
    expect((await rpc("bots.telegram.status.request", { botId })).status.connected).toBe(false);
    const { status } = await rpc("bots.telegram.connect.request", { botId, token: TELEGRAM_TOKEN });
    expect(status).toMatchObject({ connected: true, botUsername: "local_jad_bot" });
    expect(status.requestUrl).toMatch(new RegExp(`^http://${WORKER}/hooks/telegram/`));
    expect(telegram.webhook.url).toBe(status.requestUrl);
    let update = 1;
    let messageId = 10;
    const send = async (
      message: Record<string, unknown>,
      options: { secret?: string; updateId?: number } = {},
    ) => {
      const started = Date.now();
      const response = await fetch(telegram.webhook.url || status.requestUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": options.secret ?? telegram.webhook.secret_token!,
        },
        body: JSON.stringify({
          update_id: options.updateId ?? update++,
          message: { message_id: messageId++, ...message },
        }),
      });
      return { status: response.status, ms: Date.now() - started };
    };
    const dana = { id: 42, first_name: "Dana", username: "dana" };
    const dm = (text: string, from = dana) => ({
      from,
      chat: { id: from.id, type: "private" },
      text,
    });
    // Spec 37.12.2: before anyone is linked, a DM gets the refusal with the owner hint.
    expect((await send(dm("/start"))).status).toBe(200);
    await expect
      .poll(sentTexts)
      .toContain(
        "I only take requests from people my owner allowed.\nIf you own this bot, open its Telegram settings in JAgentDesk and tap Link my Telegram account.",
      );
    // Spec 37.12.1: Open in Telegram sends `/start <code>`; the open dialog hears bots.changed.
    const changed: string[] = [];
    const unsubscribe = client!.onBotsPush("bots.changed", ({ payload }) => {
      changed.push(payload.botId);
    });
    const { code } = await rpc("bots.telegram.link_code.request", { botId });
    expect((await send(dm(`/start ${code}`))).status).toBe(200);
    await expect.poll(sentTexts).toContain("Linked. You can ask me anything here.");
    await expect.poll(() => changed).toContain(botId);
    unsubscribe();
    expect((await rpc("bots.telegram.status.request", { botId })).status.linked).toEqual({
      code,
      user: { id: "42", name: "Dana", username: "dana" },
    });
    // A37.12.2
    const ok = await send(dm("list open items"), { updateId: 500 });
    expect(ok.status).toBe(200);
    expect(ok.ms).toBeLessThanOrEqual(2500);
    expect((await send(dm("list open items"), { updateId: 500 })).status).toBe(200);
    expect((await send(dm("x"), { secret: "wrong" })).status).toBe(401);
    // A37.12.3
    await expect.poll(() => countSent("text", ANSWER), { timeout: 20_000 }).toBe(1);
    const reply = telegram.sent.find((m) => m.text === ANSWER)!;
    expect(reply).toMatchObject({ chat_id: "42", reply_parameters: { message_id: 12 } });
    expect((await history()).filter((m) => m.source === "Telegram DM: Dana")).toHaveLength(1);
    // A37.12.4
    const group = { from: dana, chat: { id: -100, type: "supergroup", title: "Team" } };
    await send({ ...group, text: "lunch?" });
    await send({
      ...group,
      text: "@local_jad_bot what broke?",
      entities: [{ type: "mention", offset: 0, length: 14 }],
    });
    await expect.poll(() => countSent("chat_id", "-100"), { timeout: 20_000 }).toBe(1);
    expect(
      (await history()).filter((m) => m.source.startsWith("Telegram: Dana in Team")),
    ).toHaveLength(1);
    // A37.12.5
    const eve = { id: 66, first_name: "Eve" };
    await send(dm("hi", eve));
    await send(dm("again", eve));
    await expect.poll(() => countSent("chat_id", "66")).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(telegram.sent.filter((m) => m.chat_id === "66").map((m) => m.text)).toEqual([
      "I only take requests from people my owner allowed.",
    ]);
    // A37.12.7
    const oldUrl = status.requestUrl;
    await rpc("bots.telegram.disconnect.request", { botId });
    expect(telegram.webhook.url).toBe("");
    await expect
      .poll(async () => (await fetch(oldUrl, { method: "POST", body: "{}" })).status)
      .toBe(404);
    expect(JSON.stringify(await rpc("bots.telegram.status.request", { botId }))).not.toContain(
      TELEGRAM_TOKEN.split(":")[1],
    );
    proof.telegram = {
      ackMs: ok.ms,
      sent: telegram.sent.map((m) => ({
        chat: m.chat_id,
        replyTo: m.reply_parameters?.message_id,
        text: m.text,
      })),
    };
  }, 90_000);

  test("A37.11.2–A37.11.5 GitLab", async () => {
    await waitRelay("bots.gitlab.status.request");
    await rpc("bots.gitlab.add_project.request", { botId, host: "gitlab.com", path: "grp/app" });
    await rpc("bots.gitlab.allowed.add.request", { botId, username: "carol" });
    const [hook] = gitlabHooks;
    const post = async (
      event: string,
      payload: unknown,
      options: { token?: string; uuid?: string } = {},
    ) => {
      const started = Date.now();
      const response = await fetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitlab-event": event,
          "x-gitlab-token": options.token ?? hook.token,
          "x-gitlab-event-uuid": options.uuid ?? randomUUID(),
          "x-gitlab-instance": "https://gitlab.com",
        },
        body: JSON.stringify(payload),
      });
      return { status: response.status, ms: Date.now() - started };
    };
    const project = { id: 15, path_with_namespace: "grp/app" };
    const note = {
      object_kind: "note",
      project,
      user: { username: "carol", name: "Carol" },
      object_attributes: {
        id: 5,
        note: "/scout explain this pipeline failure",
        noteable_type: "MergeRequest",
      },
      merge_request: { iid: 3 },
    };
    expect((await post("Note Hook", note, { token: "wrong" })).status).toBe(401);
    const ok = await post("Note Hook", note, { uuid: "uuid-1" });
    expect(ok.status).toBe(200);
    expect(ok.ms).toBeLessThanOrEqual(2500);
    expect((await post("Note Hook", note, { uuid: "uuid-1" })).status).toBe(200);
    await expect.poll(() => gitlabNotes.length, { timeout: 20_000 }).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(gitlabNotes).toEqual([
      {
        path: "projects/grp%2Fapp/merge_requests/3/notes",
        body: `${ANSWER}\n\nasked by Carol via Scout`,
      },
    ]);
    const log = await readFile(logPath, "utf8");
    expect(log).not.toContain(hook.token);
    expect(JSON.stringify(await rpc("bots.gitlab.status.request", { botId }))).not.toContain(
      hook.token,
    );
    proof.gitlab = { ackMs: ok.ms, notes: gitlabNotes };
  }, 60_000);

  test("A37.10.2–A37.10.7 GitHub, then A37.10.6 redelivery across a daemon restart", async () => {
    await waitRelay("bots.github.status.request");
    await rpc("bots.github.add_repo.request", { botId, target: "octo/e2e-repo" });
    const [hook] = github.hooks;
    expect(hook.events).toHaveLength(11);
    const started = Date.now();
    expect(
      (
        await github.deliver(hook.id, "ping", {
          zen: "Design for failure.",
          hook_id: hook.id,
          repository: { full_name: "octo/e2e-repo" },
        })
      ).status,
    ).toBe(200);
    await expect
      .poll(
        async () => (await rpc("bots.github.status.request", { botId })).status.targets[0].state,
        { timeout: 10_000 },
      )
      .toBe("connected");
    const connectedMs = Date.now() - started;
    const repository = { full_name: "octo/e2e-repo" };
    const issues = {
      action: "opened",
      repository,
      sender: { login: "someone" },
      issue: { number: 7, title: "Typo" },
    };
    const ok = await github.deliver(hook.id, "issues", issues, "guid-issues");
    expect(ok.status).toBe(200);
    expect(ok.ms).toBeLessThanOrEqual(2500);
    expect((await github.deliver(hook.id, "issues", issues, "guid-issues")).status).toBe(200);
    expect(
      (await github.deliver(hook.id, "issues", issues, randomUUID(), "wrong-secret")).status,
    ).toBe(401);
    // A37.10.3
    const comment = (login: string, id: number) => ({
      action: "created",
      repository,
      sender: { login },
      issue: { number: 7, title: "Typo", html_url: "https://github.com/octo/e2e-repo/issues/7" },
      comment: { id, body: "/scout fix the typo", user: { login } },
    });
    await github.deliver(hook.id, "issue_comment", comment("owner-login", 1), "guid-mention");
    await github.deliver(hook.id, "issue_comment", comment("owner-login", 1), "guid-mention");
    await expect.poll(() => github.comments.length, { timeout: 20_000 }).toBe(1);
    expect(github.comments[0]).toEqual({ repo: "octo/e2e-repo", number: 7, body: ANSWER });
    // A37.10.4
    const before = (await history()).length;
    await github.deliver(hook.id, "issue_comment", comment("stranger", 2));
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect((await history()).length).toBe(before);
    expect(github.comments).toHaveLength(1);
    // A37.10.7
    const oldSecret = hook.secret;
    await rpc("bots.github.rotate_secret.request", { botId, target: "octo/e2e-repo" });
    expect(hook.secret).not.toBe(oldSecret);
    expect((await github.deliver(hook.id, "issues", issues, randomUUID(), oldSecret)).status).toBe(
      401,
    );
    expect((await github.deliver(hook.id, "issues", issues)).status).toBe(200);
    const status = JSON.stringify(await rpc("bots.github.status.request", { botId }));
    const log = await readFile(logPath, "utf8");
    for (const secret of [oldSecret, hook.secret]) {
      expect(status).not.toContain(secret);
      expect(log).not.toContain(secret);
    }
    // A37.10.6: daemon down → GitHub's deliveries fail with 503; back up → resent once each.
    await stopDaemon();
    const down = [
      await github.deliver(hook.id, "issue_comment", comment("owner-login", 3), "guid-offline-1"),
      await github.deliver(hook.id, "issue_comment", comment("owner-login", 4), "guid-offline-2"),
    ];
    expect(down.map((d) => d.status)).toEqual([503, 503]);
    const restartedAt = Date.now();
    await startDaemon();
    await expect.poll(() => github.comments.length, { timeout: 120_000, interval: 1000 }).toBe(3);
    const redeliveredMs = Date.now() - restartedAt;
    const offline = github.deliveries.filter((d) => d.guid.startsWith("guid-offline"));
    expect(offline.map((d) => `${d.guid}:${d.status_code}`).toSorted()).toEqual([
      "guid-offline-1:200",
      "guid-offline-1:503",
      "guid-offline-2:200",
      "guid-offline-2:503",
    ]);
    // A37.8.8-style: Remove → the old URL is 404.
    await rpc("bots.github.remove.request", { botId, target: "octo/e2e-repo" });
    await expect
      .poll(async () => (await fetch(hook.url, { method: "POST", body: "{}" })).status)
      .toBe(404);
    proof.github = {
      connectedMs,
      ackMs: ok.ms,
      redeliveredMs,
      comments: github.comments,
      deliveries: github.deliveries.map(({ body: _b, ...d }) => d),
    };
  }, 240_000);

  test("Worker answers 503 while the daemon is down (spec 37.8.2 / 37.9)", async () => {
    await rpc("bots.gitlab.status.request", { botId });
    await stopDaemon();
    const response = await fetch(gitlabHooks[0].url, {
      method: "POST",
      body: "{}",
      headers: { "x-gitlab-event": "Note Hook" },
    });
    expect(response.status).toBe(503);
    proof.offline503 = response.status;
  }, 30_000);
});
