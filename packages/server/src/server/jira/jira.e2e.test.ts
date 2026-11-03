import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionOutboundMessage } from "../messages.js";
import { JiraSession } from "../session/jira/jira-session.js";
import * as boardOps from "./board-ops.js";
import * as issueOps from "./issue-ops.js";
import { JiraService } from "./service.js";
import { FakeJiraServer } from "./test-support/fake-jira-server.js";

// The daemon's Jira layer (service + session RPC handler + credential manager + FileSecretStore)
// end to end against a fake Jira site speaking the documented Cloud v3 / Software / DC v2 / OAuth
// shapes. Covers spec 29.7 criteria 1, 2, 3, 4, 5, 6 and 9 as far as a fake site can.

interface Harness {
  fake: FakeJiraServer;
  home: string;
  logs: string[];
  service: JiraService;
  clock: { offset: number };
  emitted: SessionOutboundMessage[];
  session: JiraSession;
}

async function harness(deployment: "cloud" | "datacenter"): Promise<Harness> {
  const fake = new FakeJiraServer({ deployment });
  await fake.start();
  const home = mkdtempSync(path.join(tmpdir(), "jad-jira-e2e-"));
  const logs: string[] = [];
  const logger = pino(
    { level: "trace" },
    new Writable({
      write(chunk, _enc, done) {
        logs.push(String(chunk));
        done();
      },
    }),
  );
  const clock = { offset: 0 };
  const service = new JiraService({
    jagentdeskHome: home,
    endpoints: { authUrl: fake.baseUrl, apiUrl: fake.baseUrl },
    logger,
    now: () => Date.now() + clock.offset,
    pollIntervalMs: 150,
  });
  await service.initialize();
  const emitted: SessionOutboundMessage[] = [];
  const session = new JiraSession({ service, emit: (m) => emitted.push(m), logger });
  return { fake, home, logs, service, clock, emitted, session };
}

async function rpc<T>(h: Harness, message: Record<string, unknown>): Promise<T> {
  const requestId = `r-${Math.random().toString(36).slice(2)}`;
  await h.session.handle({ ...message, requestId } as Parameters<JiraSession["handle"]>[0]);
  const response = h.emitted.find(
    (m) => "payload" in m && (m.payload as { requestId?: string }).requestId === requestId,
  );
  if (!response || !("payload" in response))
    throw new Error(`no response for ${String(message.type)}`);
  return response.payload as T;
}

function hasEmitted(h: Harness, type: string): boolean {
  return h.emitted.some((m) => m.type === type);
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? allFiles(full) : [full];
  });
}

describe("Jira Cloud with an API token", () => {
  let h: Harness;
  let connectionId: string;
  beforeEach(async () => {
    h = await harness("cloud");
    const added = await rpc<{
      connection: { id: string; authState: string; account: { displayName: string } } | null;
      error: unknown;
    }>(h, {
      type: "jira.connections.add.request",
      deployment: "cloud",
      siteUrl: h.fake.baseUrl,
      method: "api_token",
      email: "admin@jira.test",
      token: h.fake.apiToken,
    });
    expect(added.error).toBeNull();
    connectionId = added.connection?.id ?? "";
    expect(added.connection?.account.displayName).toBe("Test Admin");
  });
  afterEach(async () => {
    h.session.dispose();
    h.service.dispose();
    await h.fake.stop();
    rmSync(h.home, { recursive: true, force: true });
  });

  it("criterion 1: lists the account's projects and boards; no token on disk in clear or in logs", async () => {
    const projects = await rpc<{ projects: Array<{ key: string }> }>(h, {
      type: "jira.projects.list.request",
      connectionId,
    });
    expect(projects.projects.map((p) => p.key)).toEqual(["ABC", "OPS"]);
    const boards = await rpc<{
      boards: Array<{ id: number; name: string; type: string; projectKey: string }>;
    }>(h, {
      type: "jira.boards.list.request",
      connectionId,
    });
    expect(boards.boards).toEqual([
      { id: 1, name: "ABC board", type: "scrum", projectKey: "ABC", projectName: "ABC project" },
      { id: 2, name: "OPS board", type: "kanban", projectKey: "OPS", projectName: "OPS project" },
    ]);
    const jiraDir = path.join(h.home, "jira");
    expect(statSync(jiraDir).mode & 0o777).toBe(0o700);
    for (const file of allFiles(h.home)) {
      expect(readFileSync(file, "utf8")).not.toContain(h.fake.apiToken);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(readFileSync(path.join(jiraDir, "connections.json"), "utf8")).toContain(connectionId);
    expect(h.logs.join("")).not.toContain(h.fake.apiToken);
    expect(JSON.stringify(h.emitted)).not.toContain(h.fake.apiToken);
  });

  it("rejects a wrong token without keeping the connection", async () => {
    const added = await rpc<{ connection: unknown; error: { code: string } | null }>(h, {
      type: "jira.connections.add.request",
      deployment: "cloud",
      siteUrl: h.fake.baseUrl,
      method: "api_token",
      email: "admin@jira.test",
      token: "wrong-token",
    });
    expect(added.connection).toBeNull();
    expect(added.error?.code).toBe("auth_failed");
    expect(h.service.listConnections()).toHaveLength(1);
  });

  it("shows the active sprint board with columns, WIP limit, lanes and Cloud quick filters", async () => {
    const config = await rpc<{
      configuration: {
        columns: Array<{ name: string; statusIds: string[]; max: number | null }>;
        quickFilters: Array<{ id: number }>;
        estimation: { fieldId: string };
      };
    }>(h, {
      type: "jira.boards.configuration.request",
      connectionId,
      boardId: 1,
    });
    expect(config.configuration.columns.map((c) => [c.name, c.statusIds, c.max])).toEqual([
      ["To Do", ["1"], null],
      ["In Progress", ["3"], 2],
      ["In Review", ["4"], null],
      ["Done", ["5"], null],
    ]);
    expect(config.configuration.quickFilters.map((f) => f.id)).toEqual([1, 2]);
    const board = await rpc<{
      issues: Array<{
        key: string;
        estimate: number | null;
        parent: { key: string } | null;
        flagged: boolean;
      }>;
      sprint: { name: string };
      lanes: Array<{ title: string; issueIds: string[] }>;
    }>(h, {
      type: "jira.board.issues.request",
      connectionId,
      boardId: 1,
    });
    expect(board.sprint.name).toBe("ABC Sprint 1");
    expect(board.issues.map((i) => i.key)).toEqual([
      "ABC-2",
      "ABC-3",
      "ABC-4",
      "ABC-5",
      "ABC-6",
      "ABC-7",
      "ABC-8",
      "ABC-11",
    ]);
    expect(board.issues.find((i) => i.key === "ABC-2")).toMatchObject({
      estimate: 3,
      parent: { key: "ABC-1" },
    });
    expect(board.issues.find((i) => i.key === "ABC-4")?.flagged).toBe(true);
    expect(board.lanes).toEqual([
      {
        id: "all",
        title: "All issues",
        issueIds: board.issues.map((i) => (i as unknown as { id: string }).id),
      },
    ]);

    const mine = await rpc<{ issues: Array<{ key: string }> }>(h, {
      type: "jira.board.issues.request",
      connectionId,
      boardId: 1,
      filter: { quickFilterIds: [1] },
    });
    expect(mine.issues.map((i) => i.key)).toEqual(["ABC-6", "ABC-7"]);

    await rpc(h, {
      type: "jira.swimlanes.set.request",
      connectionId,
      boardId: 1,
      swimlanes: {
        mode: "queries",
        queries: [{ id: "q1", name: "Frontend", jql: "labels = frontend" }],
      },
    });
    const queried = await rpc<{ lanes: Array<{ title: string; issueIds: string[] }> }>(h, {
      type: "jira.board.issues.request",
      connectionId,
      boardId: 1,
    });
    expect(queried.lanes.map((l) => [l.title, l.issueIds.length])).toEqual([
      ["Frontend", 2],
      ["Everything else", 6],
    ]);
    await rpc(h, {
      type: "jira.swimlanes.set.request",
      connectionId,
      boardId: 1,
      swimlanes: { mode: "assignee", queries: [] },
    });
    const byAssignee = await rpc<{ lanes: Array<{ title: string }> }>(h, {
      type: "jira.board.issues.request",
      connectionId,
      boardId: 1,
    });
    expect(byAssignee.lanes.map((l) => l.title)).toEqual([
      "Test Admin",
      "Test Developer",
      "Test Reviewer",
      "Unassigned",
    ]);
  });

  it("criterion 4: dragging To Do → In Progress transitions; Done asks for its required field", async () => {
    const t = await rpc<{
      transitions: Array<{
        id: string;
        to: { id: string };
        hasScreen: boolean;
        fields: Array<{
          fieldId: string;
          required: boolean;
          allowedValues: Array<{ name: string }>;
        }>;
      }>;
    }>(h, {
      type: "jira.issue.transitions.request",
      connectionId,
      issueKey: "ABC-3",
    });
    const toProgress = t.transitions.find((x) => x.to.id === "3");
    const moved = await rpc<{ issue: { status: { name: string } }; error: unknown }>(h, {
      type: "jira.issue.transition.request",
      connectionId,
      issueKey: "ABC-3",
      transitionId: toProgress?.id,
    });
    expect(moved.error).toBeNull();
    expect(moved.issue.status.name).toBe("In Progress");
    expect(h.fake.issues.get("ABC-3")?.statusId).toBe("3");

    const toDone = t.transitions.find((x) => x.to.id === "5");
    expect(toDone?.hasScreen).toBe(true);
    expect(toDone?.fields).toEqual([
      expect.objectContaining({
        fieldId: "resolution",
        required: true,
        kind: "option",
        allowedValues: [
          { id: "10000", name: "Done" },
          { id: "10001", name: "Won't Do" },
        ],
      }),
    ]);
    const missing = await rpc<{ error: { code: string; fieldErrors: Record<string, string> } }>(h, {
      type: "jira.issue.transition.request",
      connectionId,
      issueKey: "ABC-3",
      transitionId: toDone?.id,
    });
    expect(missing.error).toMatchObject({
      code: "invalid_input",
      fieldErrors: { resolution: "Resolution is required." },
    });
    const done = await rpc<{ error: unknown }>(h, {
      type: "jira.issue.transition.request",
      connectionId,
      issueKey: "ABC-3",
      transitionId: toDone?.id,
      fields: { resolution: { kind: "option", id: "10000" } },
      commentMarkdown: "Done in **PR 9**",
    });
    expect(done.error).toBeNull();
    expect(h.fake.issues.get("ABC-3")).toMatchObject({ statusId: "5", resolutionId: "10000" });
  });

  it("criterion 5: an open board sees a web change within one poll and stops polling when closed", async () => {
    await rpc(h, { type: "jira.board.watch.request", watchId: "w1", connectionId, boardId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(h.emitted.some((m) => m.type === "jira.board.changed")).toBe(false);
    h.fake.webTransition("ABC-6", "3");
    await waitFor(() => hasEmitted(h, "jira.board.changed"));
    const changed = h.emitted.find((m) => m.type === "jira.board.changed");
    expect(changed).toEqual({
      type: "jira.board.changed",
      watchId: "w1",
      connectionId,
      boardId: 1,
      issueKeys: ["ABC-6"],
    });
    const poll = h.fake
      .requestsSince(0, "/board/1/issue")
      .find((r) => r.query.get("fields") === "updated");
    expect(poll?.query.get("jql")).toMatch(/^updated >= "\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}"$/);

    await rpc(h, { type: "jira.board.unwatch.request", watchId: "w1" });
    const closedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(h.fake.requestsSince(closedAt)).toEqual([]);
    expect(h.service.watches.size).toBe(0);
  });

  it("an open issue reports changes, and a disconnecting client stops its watches", async () => {
    await rpc(h, {
      type: "jira.issue.watch.request",
      watchId: "i1",
      connectionId,
      issueKey: "ABC-2",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.fake.webTransition("ABC-2", "4");
    await waitFor(() => hasEmitted(h, "jira.issue.changed"));
    h.session.dispose();
    const closedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(h.fake.requestsSince(closedAt)).toEqual([]);
  });

  it("criterion 9: issue detail carries no Jira resource URL; images come back as bytes", async () => {
    const detail = await rpc<{
      issue: Record<string, unknown> & {
        attachments: Array<{ id: string; hasThumbnail: boolean }>;
        description: { markdown: string; editable: boolean };
        links: Array<{ relation: string; issue: { key: string } }>;
        remoteLinks: unknown[];
        fields: Array<{ fieldId: string; editable: boolean; kind: string }>;
      };
    }>(h, {
      type: "jira.issue.get.request",
      connectionId,
      issueKey: "ABC-2",
    });
    const json = JSON.stringify(detail.issue);
    for (const leak of ["/rest/", "/secure/", "/media/", "avatar", "iconUrl", "self"])
      expect(json).not.toContain(leak);
    expect(detail.issue.webUrl).toBe(`${h.fake.baseUrl}/browse/ABC-2`);
    expect(detail.issue.description).toEqual({
      markdown:
        "The expiry field accepts past dates.\n\nAcceptance criteria: reject past months; show the error under the field.",
      editable: true,
      unsupported: [],
    });
    expect(detail.issue.links).toEqual([
      expect.objectContaining({
        relation: "blocks",
        issue: expect.objectContaining({ key: "ABC-3" }),
      }),
    ]);
    expect(detail.issue.fields.map((f) => [f.fieldId, f.kind, f.editable])).toEqual([
      ["assignee", "user", true],
      ["reporter", "readonly", false],
      ["labels", "labels", true],
      ["priority", "option", true],
      ["customfield_10020", "option", true],
      ["customfield_10016", "number", true],
      ["duedate", "date", true],
    ]);
    const image = await rpc<{
      fileName: string;
      mimeType: string;
      dataBase64: string;
      error: unknown;
    }>(h, {
      type: "jira.issue.attachments.download.request",
      connectionId,
      attachmentId: detail.issue.attachments[0]?.id,
      variant: "content",
    });
    expect(image).toMatchObject({ error: null, fileName: "expiry-bug.png", mimeType: "image/png" });
    expect(Buffer.from(image.dataBase64, "base64").subarray(1, 4).toString()).toBe("PNG");
  });

  it("edits fields, comments in Markdown (stored as ADF), logs work, uploads, links and ranks", async () => {
    const updated = await rpc<{
      issue: { summary: string; labels: string[]; priority: { name: string } };
      error: unknown;
    }>(h, {
      type: "jira.issue.update.request",
      connectionId,
      issueKey: "ABC-6",
      summary: "Address autocomplete (v2)",
      descriptionMarkdown: "Use the **places** API.",
      fields: {
        labels: { kind: "labels", labels: ["ux"] },
        priority: { kind: "option", id: "2" },
        customfield_10020: { kind: "option", id: "2" },
      },
    });
    expect(updated.error).toBeNull();
    expect(updated.issue).toMatchObject({
      summary: "Address autocomplete (v2)",
      labels: ["ux"],
      priority: { name: "High" },
    });
    expect(h.fake.issues.get("ABC-6")).toMatchObject({
      sprintId: 2,
      description: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Use the " },
              { type: "text", text: "places", marks: [{ type: "strong" }] },
              { type: "text", text: " API." },
            ],
          },
        ],
      },
    });

    const comment = await rpc<{ comment: { body: { markdown: string }; editable: boolean } }>(h, {
      type: "jira.issue.comments.add.request",
      connectionId,
      issueKey: "ABC-6",
      bodyMarkdown: "Ping [@Test Developer](jira-mention:acc-dev-2) — see `api.ts`",
    });
    expect(comment.comment).toMatchObject({
      body: { markdown: "Ping [@Test Developer](jira-mention:acc-dev-2) — see `api.ts`" },
      editable: true,
    });
    const stored = h.fake.issues.get("ABC-6")?.comments.at(-1)?.body as {
      content: Array<{ content: unknown[] }>;
    };
    expect(stored.content[0]?.content[1]).toEqual({
      type: "mention",
      attrs: { id: "acc-dev-2", text: "@Test Developer" },
    });

    const worklog = await rpc<{
      worklog: { timeSpent: string; timeSpentSeconds: number };
      error: unknown;
    }>(h, {
      type: "jira.issue.worklog.add.request",
      connectionId,
      issueKey: "ABC-6",
      timeSpent: "1h 30m",
      started_ms: Date.UTC(2026, 10, 4, 3, 0),
      commentMarkdown: "pairing",
    });
    expect(worklog).toMatchObject({
      error: null,
      worklog: { timeSpent: "1h 30m", timeSpentSeconds: 5400 },
    });

    const upload = await rpc<{ attachments: Array<{ filename: string; size: number }> }>(h, {
      type: "jira.issue.attachments.upload.request",
      connectionId,
      issueKey: "ABC-6",
      fileName: "notes.txt",
      mimeType: "text/plain",
      dataBase64: Buffer.from("hello jira").toString("base64"),
    });
    expect(upload.attachments).toEqual([
      expect.objectContaining({ filename: "notes.txt", size: 10 }),
    ]);

    await rpc(h, {
      type: "jira.issue.links.add.request",
      connectionId,
      issueKey: "ABC-6",
      link: { kind: "issue", linkTypeName: "Blocks", direction: "outward", targetKey: "ABC-7" },
    });
    await rpc(h, {
      type: "jira.issue.links.add.request",
      connectionId,
      issueKey: "ABC-6",
      link: { kind: "web", url: "https://git.test/pr/9", title: "PR 9" },
    });
    const after = await rpc<{
      issue: {
        links: Array<{ relation: string; issue: { key: string } }>;
        remoteLinks: Array<{ url: string }>;
      };
    }>(h, { type: "jira.issue.get.request", connectionId, issueKey: "ABC-6" });
    expect(after.issue.links.map((l) => [l.relation, l.issue.key])).toEqual([["blocks", "ABC-7"]]);
    expect(after.issue.remoteLinks.map((l) => l.url)).toEqual(["https://git.test/pr/9"]);
    const otherSide = await rpc<{
      issue: { links: Array<{ relation: string; issue: { key: string } }> };
    }>(h, { type: "jira.issue.get.request", connectionId, issueKey: "ABC-7" });
    expect(otherSide.issue.links.map((l) => [l.relation, l.issue.key])).toEqual([
      ["is blocked by", "ABC-6"],
    ]);

    const ranked = await rpc<{ error: unknown }>(h, {
      type: "jira.issue.rank.request",
      connectionId,
      issueKeys: ["ABC-8"],
      rankBeforeKey: "ABC-2",
    });
    expect(ranked.error).toBeNull();
    const board = await rpc<{ issues: Array<{ key: string }> }>(h, {
      type: "jira.board.issues.request",
      connectionId,
      boardId: 1,
    });
    expect(board.issues[0]?.key).toBe("ABC-8");
  });

  it("backlog, sprint start/complete and moving issues", async () => {
    const backlog = await rpc<{
      sprints: Array<{ sprint: { name: string; state: string }; issues: Array<{ key: string }> }>;
      backlog: Array<{ key: string }>;
      epics: Array<{ key: string }>;
      versions: Array<{ name: string }>;
    }>(h, {
      type: "jira.backlog.get.request",
      connectionId,
      boardId: 1,
    });
    expect(backlog.sprints.map((s) => [s.sprint.name, s.sprint.state, s.issues.length])).toEqual([
      ["ABC Sprint 1", "active", 8],
      ["ABC Sprint 2", "future", 0],
    ]);
    expect(backlog.backlog.map((i) => i.key)).toEqual(["ABC-9", "ABC-10"]);
    expect(backlog.epics.map((e) => e.key)).toEqual(["ABC-1"]);
    expect(backlog.versions.map((v) => v.name)).toEqual(["1.4.0"]);

    await rpc(h, {
      type: "jira.sprints.move_issues.request",
      connectionId,
      issueKeys: ["ABC-9"],
      target: { kind: "sprint", sprintId: 2 },
    });
    expect(h.fake.issues.get("ABC-9")?.sprintId).toBe(2);
    const startTooEarly = await rpc<{ error: { message: string } }>(h, {
      type: "jira.sprints.start.request",
      connectionId,
      sprintId: 2,
      startDate_ms: Date.now(),
      endDate_ms: Date.now() + 86_400_000,
    });
    expect(startTooEarly.error.message).toBe("Another sprint is already active on this board.");
    const completed = await rpc<{
      sprint: { state: string };
      movedIssueKeys: string[];
      error: unknown;
    }>(h, {
      type: "jira.sprints.complete.request",
      connectionId,
      boardId: 1,
      sprintId: 1,
      incompleteDestination: { kind: "sprint", sprintId: 2 },
    });
    expect(completed).toMatchObject({ error: null, sprint: { state: "closed" } });
    expect(completed.movedIssueKeys.sort()).toEqual([
      "ABC-11",
      "ABC-2",
      "ABC-3",
      "ABC-4",
      "ABC-6",
      "ABC-7",
      "ABC-8",
    ]);
    expect(h.fake.issues.get("ABC-4")?.sprintId).toBe(2);
    const started = await rpc<{ sprint: { state: string; goal: string }; error: unknown }>(h, {
      type: "jira.sprints.start.request",
      connectionId,
      sprintId: 2,
      goal: "Payments",
      startDate_ms: Date.now(),
      endDate_ms: Date.now() + 14 * 86_400_000,
    });
    expect(started).toMatchObject({ error: null, sprint: { state: "active", goal: "Payments" } });
  });

  it("search, filters, users, JQL suggestions and create", async () => {
    const found = await rpc<{
      issues: Array<{ key: string }>;
      nextPageToken: string | null;
      total: number | null;
    }>(h, {
      type: "jira.search.request",
      connectionId,
      jql: "project = ABC AND assignee = currentUser()",
    });
    expect(found.issues.map((i) => i.key).sort()).toEqual(["ABC-6", "ABC-7"]);
    expect(found.total).toBeNull();
    const paged = await rpc<{ issues: unknown[]; nextPageToken: string | null }>(h, {
      type: "jira.search.request",
      connectionId,
      jql: "project = ABC",
      maxResults: 5,
    });
    expect(paged.issues).toHaveLength(5);
    const page2 = await rpc<{ issues: unknown[]; nextPageToken: string | null }>(h, {
      type: "jira.search.request",
      connectionId,
      jql: "project = ABC",
      maxResults: 5,
      nextPageToken: paged.nextPageToken,
    });
    expect(page2.issues).toHaveLength(5);
    const bad = await rpc<{ error: { code: string; message: string } }>(h, {
      type: "jira.search.request",
      connectionId,
      jql: "nosuchfield = 1",
    });
    expect(bad.error).toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("nosuchfield"),
    });

    const filters = await rpc<{
      filters: Array<{ name: string; favourite: boolean; mine: boolean }>;
    }>(h, { type: "jira.filters.list.request", connectionId });
    expect(filters.filters.map((f) => f.name)).toEqual([
      "Filter for ABC board",
      "Filter for OPS board",
      "My open issues",
    ]);
    const saved = await rpc<{ filter: { name: string; mine: boolean } }>(h, {
      type: "jira.filters.save.request",
      connectionId,
      name: "Reviews",
      jql: 'status = "In Review"',
    });
    expect(saved.filter).toMatchObject({ name: "Reviews", mine: true });
    const users = await rpc<{ users: Array<{ ref: string; displayName: string }> }>(h, {
      type: "jira.users.find.request",
      connectionId,
      query: "dev",
      issueKey: "ABC-2",
    });
    expect(users.users).toEqual([{ ref: "acc-dev-2", displayName: "Test Developer" }]);
    const suggestions = await rpc<{ suggestions: Array<{ value: string; label: string }> }>(h, {
      type: "jira.jql.suggest.request",
      connectionId,
      fieldName: "status",
      value: "in",
    });
    expect(suggestions.suggestions).toEqual([
      { value: '"In Progress"', label: "In Progress" },
      { value: '"In Review"', label: "In Review" },
    ]);

    const meta = await rpc<{
      issueTypes: Array<{ name: string }>;
      fields: Array<{ fieldId: string }>;
    }>(h, {
      type: "jira.issue.create_meta.request",
      connectionId,
      projectKey: "ABC",
      issueTypeId: "10002",
    });
    expect(meta.issueTypes.map((t) => t.name)).toContain("Bug");
    expect(meta.fields.map((f) => f.fieldId)).toEqual(["priority", "labels", "customfield_10016"]);
    const created = await rpc<{
      issue: { key: string; summary: string; sprintId: number | null };
      error: unknown;
    }>(h, {
      type: "jira.issue.create.request",
      connectionId,
      projectKey: "ABC",
      issueTypeId: "10002",
      summary: "Refund rounding",
      descriptionMarkdown: "Steps:\n\n1. pay\n2. refund",
      sprintId: 1,
      fields: { customfield_10016: { kind: "number", number: 2 } },
    });
    expect(created).toMatchObject({
      error: null,
      issue: { key: "ABC-12", summary: "Refund rounding", sprintId: 1 },
    });
    expect(h.fake.issues.get("ABC-12")?.storyPoints).toBe(2);
  });
});

describe("Jira Cloud OAuth 2.0 (3LO) with a user-registered app", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness("cloud");
  });
  afterEach(async () => {
    h.session.dispose();
    h.service.dispose();
    await h.fake.stop();
    rmSync(h.home, { recursive: true, force: true });
  });

  async function signIn(): Promise<string> {
    const begun = await rpc<{
      state: string;
      authorizeUrl: string;
      redirectUri: string;
      error: unknown;
    }>(h, {
      type: "jira.oauth.begin.request",
      clientId: h.fake.oauthClient.clientId,
      clientSecret: h.fake.oauthClient.clientSecret,
    });
    expect(begun.error).toBeNull();
    expect(begun.redirectUri).toBe("http://127.0.0.1:8765/jira/callback");
    // The browser: consent redirects to the callback; with no listener the user pastes this URL.
    const consent = await fetch(begun.authorizeUrl, { redirect: "manual" });
    const landed = consent.headers.get("location") ?? "";
    expect(landed.startsWith("http://127.0.0.1:8765/jira/callback?code=")).toBe(true);
    const done = await rpc<{
      connection: { id: string; method: string; cloudId: string; authState: string } | null;
      error: unknown;
    }>(h, {
      type: "jira.oauth.complete.request",
      state: begun.state,
      callbackUrl: landed,
    });
    expect(done.error).toBeNull();
    expect(done.connection).toMatchObject({
      method: "oauth",
      cloudId: h.fake.cloudId,
      authState: "connected",
    });
    return done.connection?.id ?? "";
  }

  it("criterion 2: signs in by pasting the callback URL; the client secret never reaches the app", async () => {
    const connectionId = await signIn();
    const projects = await rpc<{ projects: Array<{ key: string }> }>(h, {
      type: "jira.projects.list.request",
      connectionId,
    });
    expect(projects.projects.map((p) => p.key)).toEqual(["ABC", "OPS"]);
    expect(
      h.fake.requests.some((r) =>
        r.path.startsWith(`/ex/jira/${h.fake.cloudId}/rest/api/3/project/search`),
      ),
    ).toBe(true);
    const wire = JSON.stringify(h.emitted);
    expect(wire).not.toContain(h.fake.oauthClient.clientSecret);
    expect(wire).not.toMatch(/"(at|rt)-[0-9a-f]{24}"/);
    for (const file of allFiles(h.home))
      expect(readFileSync(file, "utf8")).not.toContain(h.fake.oauthClient.clientSecret);
    expect(h.logs.join("")).not.toContain(h.fake.oauthClient.clientSecret);
    expect(
      h.emitted
        .filter((m) => m.type === "jira.oauth.progress")
        .map((m) => (m as { phase: string }).phase),
    ).toEqual(["exchanging", "done"]);
  });

  it("refuses a pasted URL from another attempt and reports a denied consent", async () => {
    const begun = await rpc<{ state: string }>(h, {
      type: "jira.oauth.begin.request",
      clientId: h.fake.oauthClient.clientId,
      clientSecret: h.fake.oauthClient.clientSecret,
    });
    const wrong = await rpc<{ error: { message: string } }>(h, {
      type: "jira.oauth.complete.request",
      state: begun.state,
      callbackUrl: "http://127.0.0.1:8765/jira/callback?code=x&state=other",
    });
    expect(wrong.error.message).toBe(
      "That URL belongs to a different sign-in attempt. Start again.",
    );
    const denied = await rpc<{ error: { code: string } }>(h, {
      type: "jira.oauth.complete.request",
      state: begun.state,
      callbackUrl: "http://127.0.0.1:8765/jira/callback?error=access_denied&state=" + begun.state,
    });
    expect(denied.error.code).toBe("auth_failed");
  });

  it("mobile delegation broadcasts the flow to desktops", async () => {
    const delegated = await rpc<{ state: string; authorizeUrl: string }>(h, {
      type: "jira.oauth.delegate.request",
      clientId: h.fake.oauthClient.clientId,
      clientSecret: h.fake.oauthClient.clientSecret,
    });
    const push = h.emitted.find((m) => m.type === "jira.oauth.delegation");
    expect(push).toMatchObject({
      type: "jira.oauth.delegation",
      state: delegated.state,
      authorizeUrl: delegated.authorizeUrl,
    });
    expect(JSON.stringify(push)).not.toContain(h.fake.oauthClient.clientSecret);
  });

  it("criterion 3: two parallel requests on an expired token cause exactly one refresh; three refreshes in a row stay connected", async () => {
    const connectionId = await signIn();
    const refreshes = () =>
      h.fake.tokenRequests.filter((r) => r.grantType === "refresh_token").length;
    for (let round = 1; round <= 3; round += 1) {
      h.clock.offset += 2 * 3600_000; // the daemon's clock passes the token's expiry
      h.fake.expireAccessTokens();
      const [a, b] = await Promise.all([
        rpc<{ error: unknown; projects: unknown[] }>(h, {
          type: "jira.projects.list.request",
          connectionId,
        }),
        rpc<{ error: unknown; boards: unknown[] }>(h, {
          type: "jira.boards.list.request",
          connectionId,
        }),
      ]);
      expect(a.error).toBeNull();
      expect(b.error).toBeNull();
      expect(refreshes()).toBe(round);
    }
    // Jira rejects the token before the daemon's clock says so: the 401 path also refreshes once.
    h.fake.expireAccessTokens();
    const [c, d] = await Promise.all([
      rpc<{ error: unknown }>(h, { type: "jira.projects.list.request", connectionId }),
      rpc<{ error: unknown }>(h, {
        type: "jira.search.request",
        connectionId,
        jql: "project = ABC",
      }),
    ]);
    expect([c.error, d.error]).toEqual([null, null]);
    expect(refreshes()).toBe(4);
    const list = await rpc<{ connections: Array<{ authState: string }> }>(h, {
      type: "jira.connections.list.request",
    });
    expect(list.connections[0]?.authState).toBe("connected");
  });

  it("a revoked refresh token marks the connection needs_reauth", async () => {
    const connectionId = await signIn();
    // Simulate another process having rotated the token: the stored one is now stale.
    await h.service.credentials.saveOAuth(connectionId, {
      clientSecret: h.fake.oauthClient.clientSecret,
      tokens: { accessToken: "stale", refreshToken: "rt-revoked", expiresAt_ms: 0 },
    });
    const failed = await rpc<{ error: { code: string } }>(h, {
      type: "jira.projects.list.request",
      connectionId,
    });
    expect(failed.error.code).toBe("needs_reauth");
    const list = await rpc<{ connections: Array<{ authState: string }> }>(h, {
      type: "jira.connections.list.request",
    });
    expect(list.connections[0]?.authState).toBe("needs_reauth");
  });
});

describe("Jira Data Center with a personal access token", () => {
  let h: Harness;
  let connectionId: string;
  beforeEach(async () => {
    h = await harness("datacenter");
    const added = await rpc<{
      connection: { id: string; account: { ref: string } } | null;
      error: unknown;
    }>(h, {
      type: "jira.connections.add.request",
      deployment: "datacenter",
      siteUrl: h.fake.baseUrl,
      method: "pat",
      token: h.fake.pat,
    });
    expect(added.error).toBeNull();
    expect(added.connection?.account.ref).toBe("test.admin");
    connectionId = added.connection?.id ?? "";
  });
  afterEach(async () => {
    h.session.dispose();
    h.service.dispose();
    await h.fake.stop();
    rmSync(h.home, { recursive: true, force: true });
  });

  it("criterion 6: board, issue with wiki markup, comment and transition on REST v2", async () => {
    const config = await rpc<{ configuration: { quickFilters: unknown[]; columns: unknown[] } }>(
      h,
      { type: "jira.boards.configuration.request", connectionId, boardId: 2 },
    );
    expect(config.configuration.quickFilters).toEqual([]);
    expect(config.configuration.columns).toHaveLength(4);
    const kanban = await rpc<{ issues: Array<{ key: string }>; sprint: unknown }>(h, {
      type: "jira.board.issues.request",
      connectionId,
      boardId: 2,
    });
    expect(kanban.issues.map((i) => i.key)).toEqual(["OPS-1", "OPS-2", "OPS-3", "OPS-4"]);
    const scrum = await rpc<{
      issues: Array<{ key: string; parent: { key: string } | null; sprintId: number | null }>;
    }>(h, { type: "jira.board.issues.request", connectionId, boardId: 1 });
    expect(scrum.issues.find((i) => i.key === "ABC-2")).toMatchObject({
      parent: { key: "ABC-1" },
      sprintId: 1,
    });

    const detail = await rpc<{ issue: { description: { markdown: string } } }>(h, {
      type: "jira.issue.get.request",
      connectionId,
      issueKey: "ABC-2",
    });
    expect(detail.issue.description.markdown).toBe(
      "### Problem\n\nThe expiry field accepts **past** dates.\n\n### Acceptance criteria\n\n- reject past months\n- show the error under the field",
    );
    const comments = await rpc<{ comments: Array<{ body: { markdown: string } }> }>(h, {
      type: "jira.issue.comments.list.request",
      connectionId,
      issueKey: "ABC-2",
    });
    expect(comments.comments[0]?.body.markdown).toBe(
      "Repro on **staging** — see `expiry.ts` and ping [@test.dev](jira-mention:test.dev).",
    );

    await rpc(h, {
      type: "jira.issue.comments.add.request",
      connectionId,
      issueKey: "ABC-2",
      bodyMarkdown:
        "Fixed in [PR 7](https://git.test/pr/7), thanks [@test.dev](jira-mention:test.dev).",
    });
    expect(h.fake.issues.get("ABC-2")?.comments.at(-1)?.body).toBe(
      "Fixed in [PR 7|https://git.test/pr/7], thanks [~test.dev].",
    );

    const t = await rpc<{ transitions: Array<{ id: string; to: { id: string } }> }>(h, {
      type: "jira.issue.transitions.request",
      connectionId,
      issueKey: "OPS-1",
    });
    const moved = await rpc<{ error: unknown; issue: { status: { name: string } } }>(h, {
      type: "jira.issue.transition.request",
      connectionId,
      issueKey: "OPS-1",
      transitionId: t.transitions.find((x) => x.to.id === "3")?.id,
    });
    expect(moved).toMatchObject({ error: null, issue: { status: { name: "In Progress" } } });
    const assigned = await rpc<{ assignee: { ref: string } }>(h, {
      type: "jira.issue.assign.request",
      connectionId,
      issueKey: "OPS-1",
      assignee: { kind: "me" },
    });
    expect(assigned.assignee.ref).toBe("test.admin");

    const searched = await rpc<{ issues: unknown[]; total: number; nextPageToken: string | null }>(
      h,
      { type: "jira.search.request", connectionId, jql: "project = ABC", maxResults: 4 },
    );
    expect(searched).toMatchObject({ total: 11, nextPageToken: "4" });
    const history = await rpc<{ entries: Array<{ items: Array<{ field: string; to: string }> }> }>(
      h,
      { type: "jira.issue.changelog.list.request", connectionId, issueKey: "OPS-1" },
    );
    expect(history.entries.map((e) => e.items[0]?.field)).toEqual(["status", "assignee"]);
    const image = await issueOps.downloadAttachment(
      h.service.site(connectionId),
      "30001",
      "content",
    );
    expect(image.mimeType).toBe("image/png");
    const backlog = await boardOps.backlog(h.service.site(connectionId), 1);
    expect(backlog.backlog.map((i) => i.key)).toEqual(["ABC-9", "ABC-10"]);
  });
});
