import { afterEach, describe, expect, it } from "vitest";
import { FakeForgeCli, delivery, hookHarness } from "../test-utils/hook-harness.js";
import { BotsGitLab } from "./gitlab.js";
import { GitLabPayloadSchema, gitlabEventFacts } from "./gitlab-events.js";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) await close();
});

// Payload shapes follow GitLab's "Webhook events" docs, trimmed to the fields read.
const project = { id: 15, path_with_namespace: "grp/app", web_url: "https://gitlab.com/grp/app" };
const user = { username: "carol", name: "Carol D" };
const facts = (event: string, body: Record<string, unknown>) =>
  gitlabEventFacts(event, GitLabPayloadSchema.parse({ project, user, ...body }), "scout");

describe("GitLab kinds (spec 37.11.2)", () => {
  it.each([
    [
      "Merge Request Hook",
      { object_attributes: { iid: 3, action: "open" } },
      ["mr_opened"],
      "grp/app!3",
    ],
    [
      "Merge Request Hook",
      { object_attributes: { iid: 3, action: "update", oldrev: "abc" } },
      ["mr_pushed"],
      "grp/app!3",
    ],
    [
      "Merge Request Hook",
      { object_attributes: { iid: 3, action: "update" } },
      ["mr_updated"],
      "grp/app!3",
    ],
    [
      "Merge Request Hook",
      { object_attributes: { iid: 3, action: "merge" } },
      ["mr_merged"],
      "grp/app!3",
    ],
    [
      "Merge Request Hook",
      { object_attributes: { iid: 3, action: "close" } },
      ["mr_closed"],
      "grp/app!3",
    ],
    [
      "Note Hook",
      {
        object_attributes: { id: 9, note: "ok", noteable_type: "MergeRequest" },
        merge_request: { iid: 3 },
      },
      ["comment"],
      "grp/app!3",
    ],
    [
      "Note Hook",
      {
        object_attributes: {
          id: 9,
          note: "/scout explain this pipeline failure",
          noteable_type: "Issue",
        },
        issue: { iid: 4 },
      },
      ["comment", "mentioned"],
      "grp/app#4",
    ],
    [
      "Issue Hook",
      { object_attributes: { iid: 4, action: "open" } },
      ["issue_opened"],
      "grp/app#4",
    ],
    [
      "Issue Hook",
      { object_attributes: { iid: 4, action: "close" } },
      ["issue_closed"],
      "grp/app#4",
    ],
    [
      "Pipeline Hook",
      { object_attributes: { id: 70, status: "failed" } },
      ["ci_failed", "ci_finished"],
      undefined,
    ],
    [
      "Pipeline Hook",
      { object_attributes: { id: 70, status: "success" } },
      ["ci_passed", "ci_finished"],
      undefined,
    ],
    [
      "Pipeline Hook",
      { object_attributes: { id: 70, status: "canceled" } },
      ["ci_finished"],
      undefined,
    ],
    ["Pipeline Hook", { object_attributes: { id: 70, status: "running" } }, [], undefined],
    [
      "Note Hook",
      { object_attributes: { id: 9, note: "x", noteable_type: "Commit" } },
      [],
      undefined,
    ],
  ] as const)("%s %j", (event, body, kinds, subject) => {
    const result = facts(event, body);
    expect(result.kinds).toEqual(kinds);
    expect(result.subject).toBe(subject);
  });
});

async function setup(setupOptions: { createStatus?: number } = {}) {
  const h = await hookHarness();
  cleanup.push(...h.cleanup);
  const hooks: { id: number; body: Record<string, unknown> }[] = [];
  let noteId = 800;
  const glab = new FakeForgeCli((method, path, body) => {
    if (method === "GET" && path === "user") return { username: "owner" };
    if (method === "GET" && path === "projects/grp%2Fapp")
      return { id: 15, path_with_namespace: "grp/app" };
    if (method === "GET" && path.startsWith("projects/")) return { status: 404 };
    if (method === "GET" && path === "groups/grp") return { id: 2, full_path: "grp" };
    if (method === "POST" && /^(projects|groups)\/\d+\/hooks$/.test(path)) {
      if (setupOptions.createStatus) return { status: setupOptions.createStatus };
      hooks.push({ id: 31 + hooks.length, body: body as Record<string, unknown> });
      return { id: hooks.at(-1)!.id };
    }
    if (method === "PUT" && /hooks\/\d+$/.test(path)) {
      hooks.find((hook) => path.endsWith(`/${hook.id}`))!.body = body as Record<string, unknown>;
      return {};
    }
    if (method === "DELETE") return undefined;
    if (method === "POST" && path.endsWith("/notes")) return { id: noteId++ };
    return { status: 404 };
  });
  const gitlab = new BotsGitLab(h.bots, {
    logger: h.logger,
    secrets: h.secrets,
    relay: h.relay,
    events: h.bus,
    glab: glab.run,
  });
  cleanup.unshift(() => gitlab.dispose());
  gitlab.start();
  gitlab.ready((frame) => {
    const value = frame as { type: string; hookId: string };
    if (value.type === "hook_register")
      gitlab.message({ type: "hook_registered", hookId: value.hookId });
    if (value.type === "hook_unregister")
      gitlab.message({ type: "hook_unregistered", hookId: value.hookId });
  });
  const request = (type: string, extra: Record<string, unknown> = {}) =>
    gitlab.handle({ type, requestId: "r", botId: h.bot.id, ...extra } as never) as Promise<
      Record<string, unknown>
    >;
  const hookId = async () =>
    ((await request("bots.gitlab.status.request")).status as { requestUrl: string }).requestUrl
      .split("/")
      .at(-1)!;
  async function post(
    event: string,
    payload: unknown,
    options: { token?: string; uuid?: string } = {},
  ) {
    const response = await gitlab.receive(
      delivery("gitlab", await hookId(), JSON.stringify(payload), {
        "x-gitlab-event": event,
        "x-gitlab-token": options.token ?? String(hooks[0].body.token),
        "x-gitlab-event-uuid": options.uuid ?? `uuid-${Math.random()}`,
        "x-gitlab-instance": "https://gitlab.com",
      }),
    );
    await gitlab.settled();
    await h.bots.settled();
    await gitlab.settled();
    return response;
  }
  return { ...h, gitlab, glab, hooks, request, post };
}
const mrNote = (username: string, note: string) => ({
  object_kind: "note",
  project,
  user: { username, name: username },
  object_attributes: {
    id: 9,
    note,
    noteable_type: "MergeRequest",
    url: "https://gitlab.com/grp/app/-/merge_requests/3#note_9",
  },
  merge_request: { iid: 3, title: "Fix CI" },
});

describe("GitLab webhook connector (spec 37.11)", () => {
  it("Add creates one project hook with the 4 triggers, token on stdin, glab owner in Who can ask", async () => {
    const t = await setup();
    const result = await t.request("bots.gitlab.add_project.request", {
      host: "gitlab.com",
      path: "grp/app",
    });
    expect(t.hooks).toHaveLength(1);
    expect(t.hooks[0].body).toMatchObject({
      merge_requests_events: true,
      note_events: true,
      issues_events: true,
      pipeline_events: true,
      push_events: false,
      enable_ssl_verification: true,
    });
    expect(String(t.hooks[0].body.url)).toMatch(/\/hooks\/gitlab\/local\/[A-Za-z0-9_-]{43}$/);
    const token = String(t.hooks[0].body.token);
    for (const call of t.glab.calls) expect(call.args.join(" ")).not.toContain(token);
    expect(t.glab.api("POST", "projects/15/hooks")).toHaveLength(1);
    expect(result.status).toMatchObject({
      ownerUsername: "owner",
      targets: [{ host: "gitlab.com", path: "grp/app", scope: "project", state: "waiting" }],
      allowedUsers: [{ id: "owner", name: "owner" }],
    });
  });
  it("a group path makes a group hook; no permission shows the manual step once", async () => {
    const t = await setup({ createStatus: 403 });
    const result = await t.request("bots.gitlab.add_project.request", {
      host: "gitlab.com",
      path: "grp",
    });
    expect(t.glab.api("POST", "groups/2/hooks")).toHaveLength(1);
    const manual = result.manual as { secret: string; events: string[]; settingsUrl: string };
    expect(manual.events).toEqual([
      "Merge request events",
      "Comments",
      "Issues events",
      "Pipeline events",
    ]);
    expect(manual.settingsUrl).toBe("https://gitlab.com/groups/grp/-/hooks");
    expect(JSON.stringify(await t.request("bots.gitlab.status.request"))).not.toContain(
      manual.secret,
    );
  });
  it("A37.11.2: wrong token → 401; the same x-gitlab-event-uuid twice → one run", async () => {
    const t = await setup();
    await t.request("bots.gitlab.add_project.request", { host: "gitlab.com", path: "grp/app" });
    const opened = { project, user, object_attributes: { iid: 3, action: "open" } };
    expect((await t.post("Merge Request Hook", opened, { token: "wrong" })).status).toBe(401);
    expect((await t.post("Merge Request Hook", opened, { uuid: "u-1" })).status).toBe(200);
    expect((await t.post("Merge Request Hook", opened, { uuid: "u-1" })).status).toBe(200);
    expect(t.events.filter((e) => e.event === "mr_opened")).toHaveLength(1);
  });
  it("A37.11.3: /<folder> note from Who can ask → GitLab thread; the final answer is a note on that MR", async () => {
    const t = await setup();
    await t.request("bots.gitlab.add_project.request", { host: "gitlab.com", path: "grp/app" });
    await t.request("bots.gitlab.allowed.add.request", { username: "carol" });
    await t.post("Note Hook", mrNote("carol", "/scout explain this pipeline failure"));
    expect(t.runtime.sent).toHaveLength(1);
    expect(t.runtime.sent[0].text).toContain("explain this pipeline failure");
    expect(t.runtime.sent[0].text).toContain("[GitLab thread: carol on grp/app!3]");
    t.runtime.finish(t.bot, "turn-1", "The lint job failed on main.");
    await t.bots.settled();
    await t.gitlab.settled();
    const notes = t.glab.api("POST", "projects/grp%2Fapp/merge_requests/3/notes");
    expect(notes).toHaveLength(1);
    expect(notes[0].args).toContain("gitlab.com");
    expect(JSON.parse(notes[0].input!).body).toBe(
      "The lint job failed on main.\n\nasked by carol via Scout",
    );
    // Outsider: no turn, no note.
    await t.post("Note Hook", mrNote("stranger", "/scout explain"));
    expect(t.runtime.sent).toHaveLength(1);
    expect(t.glab.api("POST", "projects/grp%2Fapp/merge_requests/3/notes")).toHaveLength(1);
  });
  it("A37.11.4: a failed pipeline fires gitlab / ci_failed exactly once, whatever GitLab resends", async () => {
    const t = await setup();
    await t.request("bots.gitlab.add_project.request", { host: "gitlab.com", path: "grp/app" });
    const failed = {
      object_kind: "pipeline",
      project,
      user,
      object_attributes: { id: 70, status: "failed", ref: "main" },
    };
    await t.post("Pipeline Hook", { ...failed, object_attributes: { id: 70, status: "running" } });
    await t.post("Pipeline Hook", failed, { uuid: "p-1" });
    await t.post("Pipeline Hook", failed, { uuid: "p-2" });
    expect(t.events.filter((e) => e.event === "ci_failed")).toEqual([
      expect.objectContaining({ source: "gitlab", event: "ci_failed", place: "grp/app" }),
    ]);
  });
  it("A37.11.4: an automation on gitlab / ci_failed runs exactly once for a failed pipeline", async () => {
    const t = await setup();
    t.bus.on((event) => t.bots.connectorEvent(event));
    t.bots.saveEventAutomation(t.bot.id, {
      name: "Fix CI",
      source: "gitlab",
      event: "ci_failed",
      prompt: "Find why the pipeline failed.",
      enabled: true,
    });
    await t.request("bots.gitlab.add_project.request", { host: "gitlab.com", path: "grp/app" });
    const failed = {
      object_kind: "pipeline",
      project,
      user,
      object_attributes: { id: 70, status: "failed", ref: "main" },
    };
    await t.post("Pipeline Hook", { ...failed, object_attributes: { id: 70, status: "running" } });
    await t.post("Pipeline Hook", failed, { uuid: "p-1" });
    await t.post("Pipeline Hook", failed, { uuid: "p-2" });
    expect(t.runtime.sent).toHaveLength(1);
    expect(t.runtime.sent[0].text).toContain("Find why the pipeline failed.");
    expect(t.runtime.sent[0].text).toContain("event: gitlab / ci_failed");
  });
  it("A37.11.5: rotate → old token 401, new 200; status and logs hold no token", async () => {
    const t = await setup();
    await t.request("bots.gitlab.add_project.request", { host: "gitlab.com", path: "grp/app" });
    const old = String(t.hooks[0].body.token);
    await t.request("bots.gitlab.rotate_secret.request", { host: "gitlab.com", path: "grp/app" });
    const next = String(t.hooks[0].body.token);
    expect(next).not.toBe(old);
    const opened = { project, user, object_attributes: { iid: 3, action: "open" } };
    expect((await t.post("Merge Request Hook", opened, { token: old })).status).toBe(401);
    expect((await t.post("Merge Request Hook", opened, { token: next })).status).toBe(200);
    const status = JSON.stringify(await t.request("bots.gitlab.status.request"));
    for (const token of [old, next]) {
      expect(status).not.toContain(token);
      expect(t.logs.join("")).not.toContain(token);
    }
  });
});
