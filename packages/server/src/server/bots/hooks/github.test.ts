import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { FakeForgeCli, delivery, hookHarness } from "../test-utils/hook-harness.js";
import { BotsGitHub } from "./github.js";
import { GITHUB_HOOK_EVENTS } from "./github-events.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

async function setup(setupOptions: { createStatus?: number } = {}) {
  const h = await hookHarness();
  cleanup.push(...h.cleanup);
  const hooks: { id: number; config: { secret: string; url: string }; events: string[] }[] = [];
  let commentId = 500;
  let deliveries: unknown[] = [];
  const gh = new FakeForgeCli((method, path, body) => {
    if (method === "GET" && path === "user") return { login: "owner-login" };
    if (method === "POST" && /^repos\/[^/]+\/[^/]+\/hooks$/.test(path)) {
      if (setupOptions.createStatus) return { status: setupOptions.createStatus };
      const hook = {
        id: 101 + hooks.length,
        ...(body as { config: { secret: string; url: string }; events: string[] }),
      };
      hooks.push(hook);
      return { id: hook.id };
    }
    if (method === "PATCH" && /hooks\/\d+$/.test(path)) {
      const hook = hooks.find((entry) => path.endsWith(`/${entry.id}`))!;
      hook.config = (body as { config: { secret: string; url: string } }).config;
      return { id: hook.id };
    }
    if (method === "DELETE") return undefined;
    if (method === "POST" && /issues\/\d+\/comments$/.test(path)) return { id: commentId++ };
    if (method === "GET" && path.includes("/deliveries")) return deliveries;
    if (method === "POST" && path.endsWith("/attempts")) return {};
    return { status: 404 };
  });
  const github = new BotsGitHub(h.bots, {
    logger: h.logger,
    secrets: h.secrets,
    relay: h.relay,
    events: h.bus,
    gh: gh.run,
  });
  cleanup.unshift(() => github.dispose());
  github.start();
  const sent: unknown[] = [];
  // Acks like the Worker does (hooks.ts controlMessage).
  const connect = () =>
    github.ready((frame) => {
      sent.push(frame);
      const value = frame as { type: string; hookId: string };
      if (value.type === "hook_register" || value.type === "hook_unregister")
        github.message({
          type: value.type === "hook_register" ? "hook_registered" : "hook_unregistered",
          hookId: value.hookId,
        });
    });
  connect();
  const request = <T extends string>(type: T, extra: Record<string, unknown> = {}) =>
    github.handle({ type, requestId: "r", botId: h.bot.id, ...extra } as never) as Promise<
      Record<string, unknown>
    >;
  const currentHookId = async () =>
    ((await request("bots.github.status.request")).status as { requestUrl: string }).requestUrl
      .split("/")
      .at(-1)!;
  async function post(
    event: string,
    payload: unknown,
    options: { secret?: string; guid?: string; signature?: string } = {},
  ) {
    const body = JSON.stringify(payload);
    const secret = options.secret ?? hooks[0].config.secret;
    const response = await github.receive(
      delivery("github", await currentHookId(), body, {
        "x-github-event": event,
        "x-github-delivery": options.guid ?? `guid-${Math.random()}`,
        "x-hub-signature-256":
          options.signature ?? `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
      }),
    );
    await github.settled();
    await h.bots.settled();
    await github.settled();
    return response;
  }
  return {
    ...h,
    github,
    gh,
    hooks,
    sent,
    connect,
    request,
    post,
    setDeliveries: (value: unknown[]) => {
      deliveries = value;
    },
  };
}
const repository = { full_name: "octo/test-repo" };
const issueComment = (login: string, body: string) => ({
  action: "created",
  repository,
  sender: { login },
  issue: { number: 7, title: "Typo", html_url: "https://github.com/octo/test-repo/issues/7" },
  comment: { id: 77, body, user: { login } },
});

describe("GitHub webhook connector (spec 37.10)", () => {
  it("A37.10.1: Add creates one hook with the 11 events and the secret only on stdin; ping connects", async () => {
    const t = await setup();
    const result = await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    expect(t.hooks).toHaveLength(1);
    expect(t.hooks[0].events).toEqual([...GITHUB_HOOK_EVENTS]);
    expect(t.hooks[0].events).toHaveLength(11);
    expect(t.hooks[0].config).toMatchObject({ content_type: "json", insecure_ssl: "0" });
    expect(t.hooks[0].config.url).toMatch(
      /^http:\/\/127\.0\.0\.1:8963\/hooks\/github\/local\/[A-Za-z0-9_-]{43}$/,
    );
    for (const call of t.gh.calls)
      expect(call.args.join(" ")).not.toContain(t.hooks[0].config.secret);
    expect(result.manual).toBeUndefined();
    expect(t.sent).toContainEqual(
      expect.objectContaining({ type: "hook_register", kind: "github" }),
    );
    const status = result.status as {
      targets: { state: string }[];
      allowedUsers: { id: string }[];
    };
    expect(status.targets).toEqual([{ target: "octo/test-repo", state: "waiting" }]);
    expect(t.github.summary(t.bot.id)).toEqual({
      connected: false,
      needsFix: true,
      label: "octo/test-repo",
    });
    expect(status.allowedUsers).toEqual([{ id: "owner-login", name: "owner-login" }]);
    expect(
      (await t.post("ping", { zen: "Keep it simple.", hook_id: 101, repository })).status,
    ).toBe(200);
    const after = (await t.request("bots.github.status.request")).status as {
      targets: { state: string }[];
    };
    expect(after.targets[0].state).toBe("connected");
    expect(t.github.summary(t.bot.id)).toEqual({ connected: true, label: "octo/test-repo" });
  });
  it("shows the manual step with the secret once when gh cannot create hooks", async () => {
    const t = await setup({ createStatus: 404 });
    const result = await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    const manual = result.manual as {
      secret: string;
      payloadUrl: string;
      events: string[];
      settingsUrl: string;
    };
    expect(manual.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(manual.events).toHaveLength(11);
    expect(manual.settingsUrl).toBe("https://github.com/octo/test-repo/settings/hooks/new");
    expect(JSON.stringify(await t.request("bots.github.status.request"))).not.toContain(
      manual.secret,
    );
  });
  it("refuses Add while gh is signed out", async () => {
    const t = await setup();
    t.gh.signedIn = false;
    await expect(
      t.request("bots.github.add_repo.request", { target: "octo/test-repo" }),
    ).rejects.toThrow(/^Sign in to GitHub with gh on .+ first\.$/);
    expect(
      ((await t.request("bots.github.status.request")).status as { signedIn: boolean }).signedIn,
    ).toBe(false);
  });
  it("A37.10.2: signed issues → 200; bad signature → 401; same delivery twice runs once", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    const issues = {
      action: "opened",
      repository,
      sender: { login: "someone" },
      issue: { number: 3, title: "Bug" },
    };
    expect((await t.post("issues", issues, { guid: "g-1" })).status).toBe(200);
    expect((await t.post("issues", issues, { guid: "g-1" })).status).toBe(200);
    expect(t.events.filter((e) => e.event === "issue_opened")).toHaveLength(1);
    expect((await t.post("issues", issues, { secret: "wrong" })).status).toBe(401);
    expect((await t.post("issues", issues, { signature: "sha1=abc" })).status).toBe(401);
    expect(t.events.filter((e) => e.event === "issue_opened")).toHaveLength(1);
  });
  it("A37.10.3: a Who can ask login's /<folder> comment makes a GitHub thread; the final answer is a comment there", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    await t.request("bots.github.allowed.add.request", { login: "Carol" });
    expect(
      (await t.post("issue_comment", issueComment("carol", "/scout fix the typo"))).status,
    ).toBe(200);
    expect(t.runtime.sent).toHaveLength(1);
    expect(t.runtime.sent[0].text).toContain("fix the typo");
    expect(t.runtime.sent[0].text).toContain("[GitHub thread: Carol on octo/test-repo#7]");
    expect(t.runtime.sent[0].source?.senderId).toBe("github:Carol");
    t.bots.addItem(t.bot.id, "Fix the typo", "README typo fixed");
    t.runtime.finish(t.bot, "turn-1", "Fixed in #12.");
    await t.bots.settled();
    await t.github.settled();
    const comments = t.gh.api("POST", "repos/octo/test-repo/issues/7/comments");
    expect(comments).toHaveLength(1);
    expect(JSON.parse(comments[0].input!)).toEqual({
      body: "Fixed in #12.\n\nasked by Carol via Scout",
    });
    // The posted comment's own webhook event is the bot's words, not an event.
    const before = t.events.length;
    await t.post("issue_comment", {
      ...issueComment("owner-login", "Fixed in #12.\n\nasked by Carol via Scout"),
      comment: { id: 500, body: "x", user: { login: "owner-login" } },
    });
    expect(t.events.length).toBe(before);
  });
  it("posts 'Waiting for my owner in JAgentDesk.' when the thread's item needs the owner", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    await t.post("issue_comment", issueComment("owner-login", "/scout deploy it"));
    const item = t.bots.addItem(t.bot.id, "Deploy", "Deployed");
    t.bots.setItem(t.bot.id, item.id, {
      status: "needs_you",
      questions: [{ text: "Which env?", options: [] }],
    });
    await t.bots.settled();
    await t.github.settled();
    const comments = t.gh.api("POST", "repos/octo/test-repo/issues/7/comments");
    expect(comments.map((c) => JSON.parse(c.input!).body)).toEqual([
      "Waiting for my owner in JAgentDesk.",
    ]);
  });
  it("A37.10.4: a login outside Who can ask gets 0 turns and no reply; the comment event still fires", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    await t.post("issue_comment", issueComment("stranger", "/scout fix the typo"));
    expect(t.runtime.sent).toHaveLength(0);
    expect(t.gh.api("POST", "repos/octo/test-repo/issues")).toHaveLength(0);
    expect(t.events.map((e) => e.event)).toEqual(["comment", "mentioned"]);
    expect(t.events[0]).toMatchObject({
      source: "github",
      actor: "stranger",
      subject: "octo/test-repo#7",
    });
  });
  it("A37.10.4: the same stranger comment still runs an automation on github / comment, once", async () => {
    const t = await setup();
    t.bus.on((event) => t.bots.connectorEvent(event));
    t.bots.saveEventAutomation(t.bot.id, {
      name: "Triage comments",
      source: "github",
      event: "comment",
      prompt: "Triage the new comment.",
      enabled: true,
    });
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    const comment = issueComment("stranger", "/scout fix the typo");
    await t.post("issue_comment", comment, { guid: "c-1" });
    await t.post("issue_comment", comment, { guid: "c-1" });
    expect(t.runtime.sent).toHaveLength(1);
    expect(t.runtime.sent[0].text).toContain('your automation "Triage comments" ran');
    expect(t.runtime.sent[0].text).toContain("Triage the new comment.");
    expect(t.runtime.sent[0].text).toContain("subject: octo/test-repo#7");
    expect(t.runtime.sent[0].source).toBeUndefined();
    t.runtime.finish(t.bot, "auto-1", "Labelled it.");
    await t.bots.settled();
    await t.github.settled();
    expect(t.gh.api("POST", "repos/octo/test-repo/issues")).toHaveLength(0);
    const { automations } = t.bots.automations(t.bot.id);
    expect(automations.find((row) => row.event)).toMatchObject({
      name: "Triage comments",
      event: { source: "github", event: "comment" },
      enabled: true,
    });
  });
  it("A37.10.6: on relay reconnect asks GitHub to resend failed deliveries of the last 72 h once", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    const now = Date.now();
    const at = (ms: number) => new Date(now - ms).toISOString();
    t.setDeliveries([
      { id: 1, guid: "failed-1", delivered_at: at(60_000), status_code: 503 },
      { id: 2, guid: "failed-2", delivered_at: at(120_000), status_code: 503 },
      { id: 3, guid: "ok", delivered_at: at(1000), status_code: 200 },
      { id: 4, guid: "retried-ok", delivered_at: at(5000), status_code: 503 },
      { id: 5, guid: "retried-ok", delivered_at: at(4000), status_code: 200 },
      { id: 6, guid: "too-old", delivered_at: at(73 * 3_600_000), status_code: 503 },
      { id: 7, guid: "refused", delivered_at: at(2000), status_code: 401 },
    ]);
    t.github.closed();
    t.connect();
    await t.github.settled();
    const attempts = t.gh.api("POST", "repos/octo/test-repo/hooks/101/deliveries/");
    expect(attempts.map((a) => a.args[a.args.indexOf("-X") + 2])).toEqual([
      "repos/octo/test-repo/hooks/101/deliveries/1/attempts",
      "repos/octo/test-repo/hooks/101/deliveries/2/attempts",
    ]);
    t.github.closed();
    t.connect();
    await t.github.settled();
    expect(t.gh.api("POST", "repos/octo/test-repo/hooks/101/deliveries/")).toHaveLength(2);
  });
  it("A37.10.7: Rotate secret → old secret 401, new 200; status and logs hold no secret", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    const old = t.hooks[0].config.secret;
    await t.request("bots.github.rotate_secret.request", { target: "octo/test-repo" });
    const next = t.hooks[0].config.secret;
    expect(next).not.toBe(old);
    const payload = { action: "opened", repository, sender: { login: "x" }, issue: { number: 1 } };
    expect((await t.post("issues", payload, { secret: old })).status).toBe(401);
    expect((await t.post("issues", payload, { secret: next })).status).toBe(200);
    const status = JSON.stringify(await t.request("bots.github.status.request"));
    for (const secret of [old, next]) {
      expect(status).not.toContain(secret);
      expect(t.logs.join("")).not.toContain(secret);
    }
  });
  it("Remove deletes the hook and retires the hookId when no target is left", async () => {
    const t = await setup();
    await t.request("bots.github.add_repo.request", { target: "octo/test-repo" });
    const hookId = (
      (await t.request("bots.github.status.request")).status as { requestUrl: string }
    ).requestUrl
      .split("/")
      .at(-1);
    await t.request("bots.github.remove.request", { target: "octo/test-repo" });
    expect(t.gh.api("DELETE", "repos/octo/test-repo/hooks/101")).toHaveLength(1);
    expect(t.sent).toContainEqual({ type: "hook_unregister", v: 1, hookId });
    const status = (await t.request("bots.github.status.request")).status as {
      requestUrl?: string;
      targets: unknown[];
    };
    expect(status.targets).toEqual([]);
    expect(status.requestUrl).toBeUndefined();
    expect(await t.secrets.get(`bots.github.secrets.${t.bot.id}`)).toBeNull();
  });
});
