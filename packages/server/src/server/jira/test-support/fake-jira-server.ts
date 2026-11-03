import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { compileJql, JqlError, type JqlIssueView } from "./fake-jql.js";

// A fake Jira site for tests only. Request and response shapes follow the official Atlassian
// OpenAPI documents cited in docs/reference/jira-integration.md (§2.3, §3, §4.2):
//  - "cloud": REST v3 (ADF text, accountId), Jira Software `/rest/software/1.0` (token pages),
//    `/rest/agile/1.0`, `/search/jql` (token pages; old `/search` answers 410), and the OAuth 2.0
//    (3LO) authorization server + API gateway (`/ex/jira/<cloudId>`) with rotating refresh tokens
//    and no reuse window (strictest case).
//  - "datacenter": REST v2 (wiki markup, username), `/rest/agile/1.0` only (offset pages, agile
//    `epic`/`sprint`/`flagged` fields), no quick filters, PAT bearer auth.
// Every request is logged so tests can assert what the daemon sent (and that it stopped).

export type FakeDeployment = "cloud" | "datacenter";

export interface FakeUser {
  accountId: string;
  name: string;
  displayName: string;
  email: string;
}

interface FakeComment {
  id: string;
  author: string;
  body: unknown;
  created_ms: number;
  updated_ms: number;
}

interface FakeWorklog {
  id: string;
  author: string;
  timeSpent: string;
  timeSpentSeconds: number;
  started: string;
  comment: unknown;
}

interface FakeAttachment {
  id: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
  author: string;
  created_ms: number;
}

interface FakeHistory {
  id: string;
  author: string;
  created_ms: number;
  items: Array<{ field: string; fromString: string | null; toString: string | null }>;
}

export interface FakeIssue {
  id: number;
  key: string;
  project: string;
  summary: string;
  typeId: string;
  statusId: string;
  priorityId: string;
  assignee: string | null;
  reporter: string;
  labels: string[];
  parentKey: string | null;
  description: unknown;
  created_ms: number;
  updated_ms: number;
  sprintId: number | null;
  storyPoints: number | null;
  flagged: boolean;
  rank: number;
  resolutionId: string | null;
  comments: FakeComment[];
  worklogs: FakeWorklog[];
  attachments: FakeAttachment[];
  watchers: Set<string>;
  remoteLinks: Array<{ id: string; url: string; title: string }>;
  history: FakeHistory[];
}

interface FakeSprint {
  id: number;
  name: string;
  state: "future" | "active" | "closed";
  boardId: number;
  goal: string;
  startDate: string | null;
  endDate: string | null;
  completeDate: string | null;
}

interface FakeBoard {
  id: number;
  name: string;
  type: "scrum" | "kanban";
  project: string;
  filterId: string;
}

interface FakeLink {
  id: string;
  type: string;
  inward: string; // key
  outward: string; // key
}

export interface LoggedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  at: number;
}

const STATUSES = [
  { id: "1", name: "To Do", category: "new", categoryName: "To Do" },
  { id: "3", name: "In Progress", category: "indeterminate", categoryName: "In Progress" },
  { id: "4", name: "In Review", category: "indeterminate", categoryName: "In Progress" },
  { id: "5", name: "Done", category: "done", categoryName: "Done" },
];
const TRANSITION_IDS: Record<string, string> = { "1": "11", "3": "21", "4": "31", "5": "41" };
const TYPES = [
  { id: "10000", name: "Epic", subtask: false },
  { id: "10001", name: "Story", subtask: false },
  { id: "10002", name: "Bug", subtask: false },
  { id: "10003", name: "Task", subtask: false },
  { id: "10004", name: "Sub-task", subtask: true },
];
const PRIORITIES = [
  { id: "1", name: "Highest" },
  { id: "2", name: "High" },
  { id: "3", name: "Medium" },
  { id: "4", name: "Low" },
];
const RESOLUTIONS = [
  { id: "10000", name: "Done" },
  { id: "10001", name: "Won't Do" },
];
const LINK_TYPES = [
  { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
  { id: "10001", name: "Relates", inward: "relates to", outward: "relates to" },
];
const SPRINT_FIELD = "customfield_10020";
const POINTS_FIELD = "customfield_10016";
const FLAGGED_FIELD = "customfield_10021";
const EPIC_LINK_FIELD = "customfield_10014";
// The fake users' profile time zone: UTC+7, no DST.
const TIME_ZONE = "Asia/Ho_Chi_Minh";
const TZ_OFFSET_MIN = 7 * 60;

function jiraTimestamp(ms: number): string {
  const local = new Date(ms + TZ_OFFSET_MIN * 60_000).toISOString().replace("Z", "");
  return `${local}+0700`;
}

function adfText(text: string): unknown {
  return {
    version: 1,
    type: "doc",
    content: text
      .split("\n\n")
      .map((paragraph) => ({ type: "paragraph", content: [{ type: "text", text: paragraph }] })),
  };
}

function plainOf(body: unknown): string {
  if (typeof body === "string") return body;
  return JSON.stringify(body ?? "");
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

function errorBody(messages: string[], errors: Record<string, string> = {}) {
  return { errorMessages: messages, errors };
}

export interface FakeJiraOptions {
  deployment: FakeDeployment;
  /** Access token lifetime the fake OAuth server grants, seconds. */
  accessTokenTtlS?: number;
}

export class FakeJiraServer {
  readonly deployment: FakeDeployment;
  readonly cloudId = "11111111-2222-4333-8444-555555555555";
  readonly users: FakeUser[] = [
    {
      accountId: "acc-admin-1",
      name: "test.admin",
      displayName: "Test Admin",
      email: "admin@jira.test",
    },
    {
      accountId: "acc-dev-2",
      name: "test.dev",
      displayName: "Test Developer",
      email: "dev@jira.test",
    },
    {
      accountId: "acc-rev-3",
      name: "test.reviewer",
      displayName: "Test Reviewer",
      email: "reviewer@jira.test",
    },
  ];
  /** Credentials the fake accepts. */
  readonly apiToken = "fake-api-token-value-0001";
  readonly pat = "fake-personal-access-token-0001";
  readonly oauthClient = { clientId: "fake-oauth-client", clientSecret: "fake-oauth-secret-value" };
  readonly requests: LoggedRequest[] = [];
  readonly tokenRequests: Array<{ grantType: string; at: number }> = [];
  readonly issues = new Map<string, FakeIssue>();
  readonly sprints: FakeSprint[] = [];
  readonly boards: FakeBoard[] = [];
  readonly links: FakeLink[] = [];
  readonly filters: Array<{
    id: string;
    name: string;
    jql: string;
    owner: string;
    favourite: boolean;
  }> = [];
  /** Registered OAuth callback URLs (developer console). */
  readonly redirectUris = new Set<string>(["http://127.0.0.1:8765/jira/callback"]);
  private server: http.Server | null = null;
  private port = 0;
  private nextId = 100;
  private readonly accessTtlS: number;
  private readonly codes = new Map<string, { redirectUri: string; user: string }>();
  // Rotating refresh tokens: exactly one valid token per grant; using an old one fails.
  private readonly refreshTokens = new Map<string, { grant: string; valid: boolean }>();
  private readonly accessTokens = new Map<string, { user: string; expiresAt: number }>();
  private readonly mediaTokens = new Map<string, string>();
  private readonly projectKeys = ["ABC", "OPS"];

  constructor(options: FakeJiraOptions) {
    this.deployment = options.deployment;
    this.accessTtlS = options.accessTokenTtlS ?? 3600;
    this.seed();
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  get me(): FakeUser {
    const user = this.users[0];
    if (!user) throw new Error("no users");
    return user;
  }

  refOf(user: FakeUser): string {
    return this.deployment === "cloud" ? user.accountId : user.name;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server?.closeAllConnections();
  }

  /** Every OAuth access token now counts as expired (the next API call gets 401). */
  expireAccessTokens(): void {
    for (const token of this.accessTokens.values()) token.expiresAt = 0;
  }

  requestsSince(at: number, pathPart?: string): LoggedRequest[] {
    return this.requests.filter((r) => r.at >= at && (!pathPart || r.path.includes(pathPart)));
  }

  /** Someone else changes an issue on the Jira web UI. */
  webTransition(key: string, statusId: string): void {
    const issue = this.mustIssue(key);
    this.recordChange(
      issue,
      this.users[1]?.name ?? "",
      "status",
      this.statusName(issue.statusId),
      this.statusName(statusId),
    );
    issue.statusId = statusId;
    issue.updated_ms = Date.now();
  }

  private seed(): void {
    const now = Date.now();
    const day = 86_400_000;
    const ref = (index: number) => this.refOf(this.users[index] as FakeUser);
    this.boards.push(
      { id: 1, name: "ABC board", type: "scrum", project: "ABC", filterId: "10000" },
      { id: 2, name: "OPS board", type: "kanban", project: "OPS", filterId: "10001" },
    );
    this.filters.push(
      {
        id: "10000",
        name: "Filter for ABC board",
        jql: "project = ABC ORDER BY Rank ASC",
        owner: ref(0),
        favourite: false,
      },
      {
        id: "10001",
        name: "Filter for OPS board",
        jql: "project = OPS ORDER BY Rank ASC",
        owner: ref(0),
        favourite: false,
      },
      {
        id: "10002",
        name: "My open issues",
        jql: "assignee = currentUser() AND resolution = Unresolved",
        owner: ref(0),
        favourite: true,
      },
    );
    this.sprints.push(
      {
        id: 1,
        name: "ABC Sprint 1",
        state: "active",
        boardId: 1,
        goal: "Ship the new checkout flow",
        startDate: new Date(now - 7 * day).toISOString(),
        endDate: new Date(now + 7 * day).toISOString(),
        completeDate: null,
      },
      {
        id: 2,
        name: "ABC Sprint 2",
        state: "future",
        boardId: 1,
        goal: "",
        startDate: null,
        endDate: null,
        completeDate: null,
      },
    );
    const add = (input: Partial<FakeIssue> & { key: string; summary: string }) => {
      const id = this.nextId++;
      const issue: FakeIssue = {
        id,
        project: input.key.split("-")[0] ?? "",
        typeId: "10001",
        statusId: "1",
        priorityId: "3",
        assignee: null,
        reporter: ref(0),
        labels: [],
        parentKey: null,
        description: null,
        created_ms: now - 10 * day,
        updated_ms: now - 2 * day,
        sprintId: null,
        storyPoints: null,
        flagged: false,
        rank: id,
        resolutionId: null,
        comments: [],
        worklogs: [],
        attachments: [],
        watchers: new Set([ref(0)]),
        remoteLinks: [],
        history: [],
        ...input,
      };
      this.issues.set(issue.key, issue);
      return issue;
    };
    const text = (markdown: string) => (this.deployment === "cloud" ? adfText(markdown) : markdown);
    add({ key: "ABC-1", summary: "Checkout revamp", typeId: "10000", priorityId: "2" });
    add({
      key: "ABC-2",
      summary: "Card form validates expiry date",
      statusId: "3",
      assignee: ref(1),
      parentKey: "ABC-1",
      sprintId: 1,
      storyPoints: 3,
      labels: ["frontend"],
      description: text(
        this.deployment === "cloud"
          ? "The expiry field accepts past dates.\n\nAcceptance criteria: reject past months; show the error under the field."
          : "h3. Problem\nThe expiry field accepts *past* dates.\n\nh3. Acceptance criteria\n* reject past months\n* show the error under the field",
      ),
    });
    add({
      key: "ABC-3",
      summary: "Persist cart between sessions",
      statusId: "1",
      parentKey: "ABC-1",
      sprintId: 1,
      storyPoints: 5,
      labels: ["backend"],
    });
    add({
      key: "ABC-4",
      summary: "Price rounding on totals",
      typeId: "10002",
      statusId: "4",
      priorityId: "1",
      assignee: ref(2),
      sprintId: 1,
      storyPoints: 2,
      flagged: true,
    });
    add({
      key: "ABC-5",
      summary: "Apple Pay button",
      statusId: "5",
      resolutionId: "10000",
      assignee: ref(1),
      parentKey: "ABC-1",
      sprintId: 1,
      storyPoints: 3,
    });
    add({
      key: "ABC-6",
      summary: "Address autocomplete",
      statusId: "1",
      assignee: ref(0),
      sprintId: 1,
      storyPoints: 8,
      labels: ["frontend", "ux"],
    });
    add({
      key: "ABC-7",
      summary: "Coupon code field",
      statusId: "3",
      assignee: ref(0),
      sprintId: 1,
      storyPoints: 2,
    });
    add({
      key: "ABC-8",
      summary: "Order confirmation email",
      statusId: "3",
      assignee: ref(2),
      sprintId: 1,
      storyPoints: 3,
    });
    add({ key: "ABC-9", summary: "Saved payment methods", statusId: "1", storyPoints: 5 });
    add({ key: "ABC-10", summary: "Guest checkout", statusId: "1", typeId: "10003" });
    add({
      key: "ABC-11",
      summary: "Unit tests for expiry parsing",
      typeId: "10004",
      statusId: "1",
      parentKey: "ABC-2",
      sprintId: 1,
    });
    add({
      key: "OPS-1",
      summary: "Rotate TLS certificates",
      project: "OPS",
      statusId: "1",
      typeId: "10003",
    });
    add({
      key: "OPS-2",
      summary: "Upgrade database minor version",
      project: "OPS",
      statusId: "3",
      assignee: ref(0),
      typeId: "10003",
    });
    add({
      key: "OPS-3",
      summary: "Alert on disk usage",
      project: "OPS",
      statusId: "4",
      typeId: "10003",
    });
    add({
      key: "OPS-4",
      summary: "Backup restore drill",
      project: "OPS",
      statusId: "5",
      resolutionId: "10000",
      typeId: "10003",
    });
    const abc2 = this.mustIssue("ABC-2");
    abc2.comments.push({
      id: "20001",
      author: ref(2),
      body: text(
        this.deployment === "cloud"
          ? "Repro on the staging build."
          : "Repro on *staging* — see {{expiry.ts}} and ping [~test.dev].",
      ),
      created_ms: now - day,
      updated_ms: now - day,
    });
    abc2.attachments.push({
      id: "30001",
      filename: "expiry-bug.png",
      mimeType: "image/png",
      bytes: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDEgAQYGBgA6JQIFhJ8oHgAAAABJRU5ErkJggg==",
        "base64",
      ),
      author: ref(2),
      created_ms: now - day,
    });
    abc2.remoteLinks.push({
      id: "40001",
      url: "https://git.test/shop/pull/7",
      title: "Validate expiry",
    });
    this.links.push({ id: "50001", type: "Blocks", inward: "ABC-2", outward: "ABC-3" });
  }

  // ── plumbing ──

  private mustIssue(key: string): FakeIssue {
    const issue =
      this.issues.get(key) ?? [...this.issues.values()].find((i) => String(i.id) === key);
    if (!issue)
      throw new HttpError(
        404,
        errorBody(["Issue does not exist or you do not have permission to see it."]),
      );
    return issue;
  }

  private statusName(id: string): string {
    return STATUSES.find((s) => s.id === id)?.name ?? id;
  }

  private userByRef(ref: string | null): FakeUser | null {
    if (!ref) return null;
    return this.users.find((u) => u.accountId === ref || u.name === ref) ?? null;
  }

  private userJson(ref: string | null): unknown {
    const user = this.userByRef(ref);
    if (!user) return null;
    const avatarUrls = { "48x48": `${this.baseUrl}/secure/useravatar?ownerId=${user.name}` };
    if (this.deployment === "cloud") {
      return {
        accountId: user.accountId,
        displayName: user.displayName,
        emailAddress: user.email,
        active: true,
        timeZone: TIME_ZONE,
        avatarUrls,
        accountType: "atlassian",
      };
    }
    return {
      name: user.name,
      key: `JIRAUSER${user.name.length}`,
      displayName: user.displayName,
      emailAddress: user.email,
      active: true,
      timeZone: TIME_ZONE,
      avatarUrls,
    };
  }

  private statusJson(id: string) {
    const status = STATUSES.find((s) => s.id === id) ?? STATUSES[0];
    return {
      id: status?.id,
      name: status?.name,
      iconUrl: `${this.baseUrl}/images/icons/status.png`,
      statusCategory: { id: 2, key: status?.category, name: status?.categoryName },
    };
  }

  private typeJson(id: string) {
    const type = TYPES.find((t) => t.id === id) ?? TYPES[1];
    return {
      ...type,
      iconUrl: `${this.baseUrl}/images/icons/type-${id}.svg`,
      hierarchyLevel: type?.subtask ? -1 : 0,
    };
  }

  private sprintJson(sprint: FakeSprint) {
    return {
      id: sprint.id,
      self: `${this.baseUrl}/rest/agile/1.0/sprint/${sprint.id}`,
      state: sprint.state,
      name: sprint.name,
      startDate: sprint.startDate ?? undefined,
      endDate: sprint.endDate ?? undefined,
      completeDate: sprint.completeDate ?? undefined,
      originBoardId: sprint.boardId,
      goal: sprint.goal,
    };
  }

  private issueView(issue: FakeIssue): JqlIssueView {
    const status = STATUSES.find((s) => s.id === issue.statusId);
    return {
      key: issue.key,
      project: issue.project,
      summary: issue.summary,
      status: status?.name ?? "",
      statusCategory: status?.categoryName ?? "",
      assignee: issue.assignee,
      reporter: issue.reporter,
      labels: issue.labels,
      updated_ms: issue.updated_ms,
      created_ms: issue.created_ms,
      issuetype: TYPES.find((t) => t.id === issue.typeId)?.name ?? "",
      parent: issue.parentKey,
      sprintIds: issue.sprintId ? [issue.sprintId] : [],
      watchers: [...issue.watchers],
      resolution: issue.resolutionId
        ? (RESOLUTIONS.find((r) => r.id === issue.resolutionId)?.name ?? null)
        : null,
      text: `${issue.summary} ${plainOf(issue.description)}`,
    };
  }

  private matchJql(jql: string | null, me: string): (issue: FakeIssue) => boolean {
    if (!jql) return () => true;
    try {
      const predicate = compileJql(jql, {
        me,
        openSprintIds: this.sprints.filter((s) => s.state !== "closed").map((s) => s.id),
        tzOffsetMinutes: TZ_OFFSET_MIN,
      });
      return (issue) => predicate(this.issueView(issue));
    } catch (error) {
      if (error instanceof JqlError) throw new HttpError(400, errorBody([error.message]));
      throw error;
    }
  }

  // oxlint-disable-next-line complexity
  private issueFields(issue: FakeIssue, agile: boolean): Record<string, unknown> {
    const parent = issue.parentKey ? this.issues.get(issue.parentKey) : undefined;
    const sprint = this.sprints.find((s) => s.id === issue.sprintId);
    const watchCount = issue.watchers.size;
    const links = this.links
      .filter((link) => link.inward === issue.key || link.outward === issue.key)
      .map((link) => {
        const type = LINK_TYPES.find((t) => t.name === link.type);
        const otherKey = link.inward === issue.key ? link.outward : link.inward;
        const other = this.issues.get(otherKey);
        const ref = {
          id: String(other?.id),
          key: otherKey,
          fields: {
            summary: other?.summary,
            status: this.statusJson(other?.statusId ?? "1"),
            issuetype: this.typeJson(other?.typeId ?? "10001"),
          },
        };
        // From the inward end, the other issue is the outwardIssue (reads "<this> blocks <other>").
        return link.inward === issue.key
          ? { id: link.id, type, outwardIssue: ref }
          : { id: link.id, type, inwardIssue: ref };
      });
    const fields: Record<string, unknown> = {
      summary: issue.summary,
      project: {
        id: String(this.projectKeys.indexOf(issue.project) + 10000),
        key: issue.project,
        name: `${issue.project} project`,
      },
      issuetype: this.typeJson(issue.typeId),
      status: this.statusJson(issue.statusId),
      priority: {
        ...PRIORITIES.find((p) => p.id === issue.priorityId),
        iconUrl: `${this.baseUrl}/images/icons/priority.svg`,
      },
      assignee: this.userJson(issue.assignee),
      reporter: this.userJson(issue.reporter),
      labels: issue.labels,
      created: jiraTimestamp(issue.created_ms),
      updated: jiraTimestamp(issue.updated_ms),
      description: issue.description,
      resolution: issue.resolutionId ? RESOLUTIONS.find((r) => r.id === issue.resolutionId) : null,
      duedate: null,
      fixVersions: [],
      components: [],
      subtasks: [...this.issues.values()]
        .filter(
          (child) =>
            child.parentKey === issue.key && TYPES.find((t) => t.id === child.typeId)?.subtask,
        )
        .map((child) => ({
          id: String(child.id),
          key: child.key,
          fields: {
            summary: child.summary,
            status: this.statusJson(child.statusId),
            issuetype: this.typeJson(child.typeId),
            priority: PRIORITIES.find((p) => p.id === child.priorityId),
          },
        })),
      issuelinks: links,
      attachment: issue.attachments.map((a) => this.attachmentJson(a)),
      watches: {
        watchCount,
        isWatching: issue.watchers.has(this.refOf(this.me)),
        self: `${this.baseUrl}/watchers`,
      },
      timetracking: issue.worklogs.length > 0 ? { timeSpent: `${issue.worklogs.length}h` } : {},
      [POINTS_FIELD]: issue.storyPoints,
      [FLAGGED_FIELD]: issue.flagged ? [{ value: "Impediment", id: "10019" }] : null,
    };
    const parentIsEpic = parent && parent.typeId === "10000";
    if (this.deployment === "cloud") {
      fields[SPRINT_FIELD] = sprint ? [this.sprintJson(sprint)] : null;
      if (parent) {
        fields.parent = {
          id: String(parent.id),
          key: parent.key,
          fields: {
            summary: parent.summary,
            status: this.statusJson(parent.statusId),
            issuetype: this.typeJson(parent.typeId),
          },
        };
      }
    } else {
      // DC: the sprint field holds serialized strings, the epic is a key in Epic Link.
      fields[SPRINT_FIELD] = sprint
        ? [
            `com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=${sprint.id},name=${sprint.name},state=${sprint.state.toUpperCase()}]`,
          ]
        : null;
      fields[EPIC_LINK_FIELD] = parentIsEpic ? parent.key : null;
      if (parent && !parentIsEpic) {
        fields.parent = {
          id: String(parent.id),
          key: parent.key,
          fields: {
            summary: parent.summary,
            status: this.statusJson(parent.statusId),
            issuetype: this.typeJson(parent.typeId),
          },
        };
      }
      if (agile) {
        fields.sprint = sprint ? this.sprintJson(sprint) : null;
        fields.flagged = issue.flagged;
        fields.epic = parentIsEpic
          ? {
              id: parent.id,
              key: parent.key,
              name: parent.summary,
              summary: parent.summary,
              done: parent.statusId === "5",
            }
          : null;
      }
    }
    return fields;
  }

  private issueJson(
    issue: FakeIssue,
    query: URLSearchParams,
    agile = false,
  ): Record<string, unknown> {
    const all = this.issueFields(issue, agile);
    const wanted = query.get("fields");
    let fields = all;
    if (wanted && wanted !== "*all" && wanted !== "*navigable") {
      const keys = wanted
        .split(",")
        .flatMap((k) => k.split(" "))
        .filter(Boolean);
      fields = Object.fromEntries(keys.filter((k) => k in all).map((k) => [k, all[k]]));
    }
    const json: Record<string, unknown> = {
      id: String(issue.id),
      key: issue.key,
      self: `${this.baseUrl}${this.api()}/issue/${issue.id}`,
      fields,
    };
    const expand = query.get("expand") ?? "";
    if (expand.includes("names")) {
      json.names = {
        summary: "Summary",
        assignee: "Assignee",
        reporter: "Reporter",
        labels: "Labels",
        priority: "Priority",
        [SPRINT_FIELD]: "Sprint",
        [POINTS_FIELD]: "Story point estimate",
        resolution: "Resolution",
        fixVersions: "Fix versions",
        components: "Components",
        duedate: "Due date",
      };
    }
    if (expand.includes("editmeta")) json.editmeta = { fields: this.editmeta() };
    if (expand.includes("changelog")) {
      json.changelog = {
        startAt: 0,
        maxResults: issue.history.length,
        total: issue.history.length,
        histories: issue.history.map((h) => this.historyJson(h)),
      };
    }
    return json;
  }

  private editmeta(): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      summary: {
        required: true,
        name: "Summary",
        key: "summary",
        schema: { type: "string", system: "summary" },
        operations: ["set"],
      },
      description: {
        required: false,
        name: "Description",
        key: "description",
        schema: { type: "string", system: "description" },
        operations: ["set"],
      },
      assignee: {
        required: false,
        name: "Assignee",
        key: "assignee",
        schema: { type: "user", system: "assignee" },
        operations: ["set"],
        autoCompleteUrl: `${this.baseUrl}/user/search?query=`,
      },
      labels: {
        required: false,
        name: "Labels",
        key: "labels",
        schema: { type: "array", items: "string", system: "labels" },
        operations: ["add", "set", "remove"],
      },
      priority: {
        required: false,
        name: "Priority",
        key: "priority",
        schema: { type: "priority", system: "priority" },
        operations: ["set"],
        allowedValues: PRIORITIES.map((p) => ({
          ...p,
          self: `${this.baseUrl}/priority/${p.id}`,
          iconUrl: `${this.baseUrl}/p.svg`,
        })),
      },
      [POINTS_FIELD]: {
        required: false,
        name: "Story point estimate",
        key: POINTS_FIELD,
        schema: {
          type: "number",
          custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
          customId: 10016,
        },
        operations: ["set"],
      },
      duedate: {
        required: false,
        name: "Due date",
        key: "duedate",
        schema: { type: "date", system: "duedate" },
        operations: ["set"],
      },
    };
    if (this.deployment === "cloud") {
      meta[SPRINT_FIELD] = {
        required: false,
        name: "Sprint",
        key: SPRINT_FIELD,
        schema: {
          type: "array",
          items: "json",
          custom: "com.pyxis.greenhopper.jira:gh-sprint",
          customId: 10020,
        },
        operations: ["set"],
      };
    }
    return meta;
  }

  private attachmentJson(a: FakeAttachment): Record<string, unknown> {
    const base =
      this.deployment === "cloud"
        ? `${this.baseUrl}/rest/api/3/attachment/content/${a.id}`
        : `${this.baseUrl}/secure/attachment/${a.id}/${a.filename}`;
    return {
      id: a.id,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.bytes.length,
      created: jiraTimestamp(a.created_ms),
      author: this.userJson(a.author),
      content: base,
      ...(a.mimeType.startsWith("image/")
        ? {
            thumbnail:
              this.deployment === "cloud"
                ? `${this.baseUrl}/rest/api/3/attachment/thumbnail/${a.id}`
                : `${this.baseUrl}/secure/thumbnail/${a.id}/_thumb_${a.id}.png`,
          }
        : {}),
    };
  }

  private historyJson(h: FakeHistory) {
    return {
      id: h.id,
      author: this.userJson(h.author),
      created: jiraTimestamp(h.created_ms),
      items: h.items.map((i) => ({ ...i, fieldtype: "jira" })),
    };
  }

  private recordChange(
    issue: FakeIssue,
    author: string,
    field: string,
    from: string | null,
    to: string | null,
  ): void {
    issue.history.push({
      id: String(this.nextId++),
      author,
      created_ms: Date.now(),
      items: [{ field, fromString: from, toString: to }],
    });
  }

  private api(): string {
    return this.deployment === "cloud" ? "/rest/api/3" : "/rest/api/2";
  }

  // ── auth ──

  private authenticate(req: http.IncomingMessage, path: string): { user: FakeUser; path: string } {
    const header = req.headers.authorization ?? "";
    const gateway = /^\/ex\/jira\/([^/]+)(\/.*)$/.exec(path);
    if (gateway) {
      if (this.deployment !== "cloud" || gateway[1] !== this.cloudId)
        throw new HttpError(404, errorBody(["Site not found"]));
      const token = this.accessTokens.get(header.replace(/^Bearer /, ""));
      if (!token || token.expiresAt < Date.now())
        throw new HttpError(401, { code: 401, message: "Unauthorized; scope does not match" });
      return { user: this.userByRef(token.user) ?? this.me, path: gateway[2] ?? "/" };
    }
    if (this.deployment === "cloud" && header.startsWith("Basic ")) {
      const [email, token] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
      const user = this.users.find((u) => u.email === email);
      if (user && token === this.apiToken) return { user, path };
    }
    if (this.deployment === "datacenter" && header === `Bearer ${this.pat}`)
      return { user: this.me, path };
    throw new HttpError(
      401,
      errorBody(["You are not authenticated. Authentication required to perform this operation."]),
    );
  }

  // ── HTTP ──

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const method = req.method ?? "GET";
    this.requests.push({ method, path: url.pathname, query: url.searchParams, at: Date.now() });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    try {
      const result = await this.route(req, method, url, raw);
      if (result === undefined) {
        res.writeHead(204).end();
      } else if (result instanceof Redirect) {
        res.writeHead(result.status, { Location: result.location }).end();
      } else if (result instanceof Binary) {
        res
          .writeHead(200, { "Content-Type": result.type, "Content-Length": result.bytes.length })
          .end(result.bytes);
      } else {
        const status = result instanceof Created ? 201 : 200;
        const body = result instanceof Created ? result.body : result;
        res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const body = error instanceof HttpError ? error.body : errorBody([String(error)]);
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    }
  }

  // oxlint-disable-next-line complexity
  private async route(
    req: http.IncomingMessage,
    method: string,
    url: URL,
    raw: Buffer,
  ): Promise<unknown> {
    const path = url.pathname;
    if (path === "/authorize") return this.authorize(url);
    if (path === "/oauth/token" && method === "POST") return this.token(raw);
    if (path === "/oauth/token/accessible-resources") return this.accessibleResources(req);
    const media = /^\/media\/(\d+)$/.exec(path);
    if (media) {
      // Cloud attachment content redirects here with a signed, credential-free URL.
      const id = media[1] ?? "";
      if (this.mediaTokens.get(id) !== url.searchParams.get("token"))
        throw new HttpError(403, errorBody(["bad media token"]));
      const attachment = this.findAttachment(id);
      return new Binary(attachment.bytes, attachment.mimeType);
    }
    const auth = this.authenticate(req, path);
    const body =
      raw.length > 0 && (req.headers["content-type"] ?? "").includes("json")
        ? (JSON.parse(raw.toString("utf8")) as unknown)
        : null;
    const ctx: RouteContext = {
      method,
      path: auth.path,
      query: url.searchParams,
      body,
      raw,
      req,
      user: auth.user,
    };
    const agile = this.routeAgile(ctx);
    return agile === NOT_AGILE ? this.routePlatform(ctx) : agile;
  }

  private authorize(url: URL): unknown {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (clientId !== this.oauthClient.clientId)
      throw new HttpError(400, { error: "invalid_client" });
    if (!this.redirectUris.has(redirectUri))
      throw new HttpError(400, {
        error: "invalid_request",
        error_description: "redirect_uri is not registered",
      });
    if (
      url.searchParams.get("response_type") !== "code" ||
      !url.searchParams.get("scope")?.includes("offline_access")
    ) {
      throw new HttpError(400, { error: "invalid_request" });
    }
    const code = `code-${randomBytes(8).toString("hex")}`;
    this.codes.set(code, { redirectUri, user: this.refOf(this.me) });
    const target = new URL(redirectUri);
    target.searchParams.set("code", code);
    target.searchParams.set("state", state);
    return new Redirect(302, target.toString());
  }

  private issueTokens(grant: string, user: string) {
    const access = `at-${randomBytes(12).toString("hex")}`;
    const refresh = `rt-${randomBytes(12).toString("hex")}`;
    this.accessTokens.set(access, { user, expiresAt: Date.now() + this.accessTtlS * 1000 });
    for (const token of this.refreshTokens.values()) if (token.grant === grant) token.valid = false;
    this.refreshTokens.set(refresh, { grant, valid: true });
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: this.accessTtlS,
      scope: "read:jira-work write:jira-work offline_access",
      token_type: "Bearer",
    };
  }

  private token(raw: Buffer): unknown {
    const body = JSON.parse(raw.toString("utf8")) as Record<string, string>;
    this.tokenRequests.push({ grantType: body.grant_type ?? "", at: Date.now() });
    if (
      body.client_id !== this.oauthClient.clientId ||
      body.client_secret !== this.oauthClient.clientSecret
    ) {
      throw new HttpError(401, { error: "access_denied", error_description: "Unauthorized" });
    }
    if (body.grant_type === "authorization_code") {
      const code = this.codes.get(body.code ?? "");
      if (!code || code.redirectUri !== body.redirect_uri)
        throw new HttpError(403, {
          error: "invalid_grant",
          error_description: "Invalid authorization code",
        });
      this.codes.delete(body.code ?? "");
      return this.issueTokens(`grant-${randomBytes(4).toString("hex")}`, code.user);
    }
    if (body.grant_type === "refresh_token") {
      const current = this.refreshTokens.get(body.refresh_token ?? "");
      if (!current || !current.valid)
        throw new HttpError(403, {
          error: "invalid_grant",
          error_description: "Unknown or invalid refresh token.",
        });
      return this.issueTokens(current.grant, this.refOf(this.me));
    }
    throw new HttpError(400, { error: "unsupported_grant_type" });
  }

  private accessibleResources(req: http.IncomingMessage): unknown {
    const token = this.accessTokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!token || token.expiresAt < Date.now())
      throw new HttpError(401, { code: 401, message: "Unauthorized" });
    return [
      {
        id: this.cloudId,
        url: this.baseUrl,
        name: "fake-site",
        scopes: ["read:jira-work", "write:jira-work", "read:jira-user"],
        avatarUrl: `${this.baseUrl}/avatar.png`,
      },
    ];
  }

  private findAttachment(id: string): FakeAttachment {
    for (const issue of this.issues.values()) {
      const found = issue.attachments.find((a) => a.id === id);
      if (found) return found;
    }
    throw new HttpError(404, errorBody(["The attachment does not exist."]));
  }

  private page<T>(
    items: T[],
    query: URLSearchParams,
    key: "values" | "issues" = "values",
    tokenPages = false,
  ): Record<string, unknown> {
    const max = Math.min(Number(query.get("maxResults") ?? 50) || 50, 100);
    if (tokenPages) {
      const start = query.get("nextPageToken")
        ? Number(Buffer.from(query.get("nextPageToken") ?? "", "base64").toString())
        : 0;
      const slice = items.slice(start, start + max);
      const more = start + max < items.length;
      return {
        [key]: slice,
        isLast: !more,
        ...(more ? { nextPageToken: Buffer.from(String(start + max)).toString("base64") } : {}),
      };
    }
    const startAt = Number(query.get("startAt") ?? 0) || 0;
    const slice = items.slice(startAt, startAt + max);
    return {
      startAt,
      maxResults: max,
      total: items.length,
      isLast: startAt + max >= items.length,
      [key]: slice,
    };
  }

  private boardOf(id: string): FakeBoard {
    const board = this.boards.find((b) => String(b.id) === id);
    if (!board)
      throw new HttpError(
        404,
        errorBody([
          "The requested board cannot be viewed because it either does not exist or you do not have permission to view it.",
        ]),
      );
    return board;
  }

  private issueList(
    ctx: RouteContext,
    filter: (issue: FakeIssue) => boolean,
    agile: boolean,
  ): unknown {
    const me = this.refOf(ctx.user);
    const jql = this.matchJql(ctx.query.get("jql"), me);
    const items = [...this.issues.values()]
      .filter(filter)
      .filter(jql)
      .sort((a, b) => a.rank - b.rank)
      .map((issue) => this.issueJson(issue, ctx.query, agile));
    return this.page(
      items,
      ctx.query,
      "issues",
      this.deployment === "cloud" && ctx.path.startsWith("/rest/software/"),
    );
  }

  // oxlint-disable-next-line complexity
  private routeAgile(ctx: RouteContext): unknown {
    const { path, method, query } = ctx;
    const software = path.startsWith("/rest/software/1.0/");
    if (software && this.deployment !== "cloud") throw new HttpError(404, errorBody(["Not found"]));
    const p = path.replace(/^\/rest\/(agile|software)\/1\.0/, "");
    if (!path.startsWith("/rest/agile/1.0/") && !software) return NOT_AGILE;
    // Cloud deprecates the agile issue lists in favor of /rest/software/1.0; the fake refuses them
    // so a test catches the daemon calling the deprecated path.
    const issueListPath = /^\/board\/\d+\/(issue|backlog|sprint\/\d+\/issue)$/.test(p);
    if (this.deployment === "cloud" && issueListPath && !software)
      throw new HttpError(410, errorBody(["Use /rest/software/1.0"]));
    let m: RegExpExecArray | null;
    if (p === "/board" && method === "GET") {
      const project = query.get("projectKeyOrId");
      const name = query.get("name")?.toLowerCase();
      const boards = this.boards
        .filter((b) => !project || b.project === project)
        .filter((b) => !name || b.name.toLowerCase().includes(name))
        .map((b) => ({
          id: b.id,
          name: b.name,
          type: b.type,
          self: `${this.baseUrl}/board/${b.id}`,
          location: {
            projectKey: b.project,
            projectName: `${b.project} project`,
            displayName: `${b.project} project (${b.project})`,
          },
        }));
      return this.page(boards, query);
    }
    if ((m = /^\/board\/(\d+)$/.exec(p))) {
      const b = this.boardOf(m[1] ?? "");
      return {
        id: b.id,
        name: b.name,
        type: b.type,
        location: { projectKey: b.project, projectName: `${b.project} project` },
      };
    }
    if ((m = /^\/board\/(\d+)\/configuration$/.exec(p))) {
      const b = this.boardOf(m[1] ?? "");
      return {
        id: b.id,
        name: b.name,
        type: b.type,
        filter: { id: b.filterId, self: `${this.baseUrl}/filter/${b.filterId}` },
        subQuery:
          b.type === "kanban"
            ? { query: "fixVersion in unreleasedVersions() OR fixVersion is EMPTY" }
            : undefined,
        columnConfig: {
          columns: [
            { name: "To Do", statuses: [{ id: "1", self: "" }] },
            { name: "In Progress", statuses: [{ id: "3", self: "" }], max: 2 },
            { name: "In Review", statuses: [{ id: "4", self: "" }] },
            { name: "Done", statuses: [{ id: "5", self: "" }] },
          ],
          constraintType: "issueCount",
        },
        estimation:
          b.type === "scrum"
            ? {
                type: "field",
                field: { fieldId: POINTS_FIELD, displayName: "Story point estimate" },
              }
            : undefined,
        ranking: { rankCustomFieldId: 10019 },
      };
    }
    if ((m = /^\/board\/(\d+)\/features$/.exec(p))) {
      if (this.deployment !== "cloud") throw new HttpError(404, errorBody(["Not found"]));
      const b = this.boardOf(m[1] ?? "");
      const scrum = b.type === "scrum";
      return {
        features: [
          {
            boardFeature: "BACKLOG",
            boardId: b.id,
            state: scrum ? "ENABLED" : "DISABLED",
            localisedName: "Backlog",
          },
          {
            boardFeature: "SPRINTS",
            boardId: b.id,
            state: scrum ? "ENABLED" : "DISABLED",
            localisedName: "Sprints",
          },
        ],
      };
    }
    if ((m = /^\/board\/(\d+)\/quickfilter$/.exec(p))) {
      if (this.deployment !== "cloud") throw new HttpError(404, errorBody(["Not found"]));
      this.boardOf(m[1] ?? "");
      return this.page(
        [
          {
            id: 1,
            boardId: Number(m[1]),
            name: "Only my issues",
            jql: "assignee = currentUser()",
            position: 0,
          },
          { id: 2, boardId: Number(m[1]), name: "Frontend", jql: "labels = frontend", position: 1 },
        ],
        query,
      );
    }
    if ((m = /^\/board\/(\d+)\/sprint$/.exec(p)) && method === "GET") {
      const states = (query.get("state") ?? "active,future,closed").split(",");
      return this.page(
        this.sprints
          .filter((s) => s.boardId === Number(m?.[1]) && states.includes(s.state))
          .map((s) => this.sprintJson(s)),
        query,
      );
    }
    if ((m = /^\/board\/(\d+)\/epic$/.exec(p))) {
      const b = this.boardOf(m[1] ?? "");
      const epics = [...this.issues.values()].filter(
        (i) => i.project === b.project && i.typeId === "10000",
      );
      return this.page(
        epics.map((e) => ({
          id: e.id,
          key: e.key,
          name: e.summary,
          summary: e.summary,
          done: e.statusId === "5",
        })),
        query,
      );
    }
    if ((m = /^\/board\/(\d+)\/version$/.exec(p))) {
      this.boardOf(m[1] ?? "");
      return this.page(
        [{ id: 10100, name: "1.4.0", released: false, releaseDate: "2026-12-01" }],
        query,
      );
    }
    if ((m = /^\/board\/(\d+)\/issue$/.exec(p))) {
      const b = this.boardOf(m[1] ?? "");
      return this.issueList(ctx, (i) => i.project === b.project, true);
    }
    if ((m = /^\/board\/(\d+)\/sprint\/(\d+)\/issue$/.exec(p))) {
      const b = this.boardOf(m[1] ?? "");
      const sprintId = Number(m[2]);
      return this.issueList(
        ctx,
        (i) => i.project === b.project && i.sprintId === sprintId && i.typeId !== "10000",
        true,
      );
    }
    if ((m = /^\/board\/(\d+)\/backlog$/.exec(p))) {
      const b = this.boardOf(m[1] ?? "");
      const open = new Set(this.sprints.filter((s) => s.state !== "closed").map((s) => s.id));
      return this.issueList(
        ctx,
        (i) =>
          i.project === b.project &&
          (!i.sprintId || !open.has(i.sprintId)) &&
          i.statusId !== "5" &&
          i.typeId !== "10000" &&
          !TYPES.find((t) => t.id === i.typeId)?.subtask,
        true,
      );
    }
    if (p === "/sprint" && method === "POST") {
      const input = ctx.body as {
        name: string;
        originBoardId: number;
        goal?: string;
        startDate?: string;
        endDate?: string;
      };
      const sprint: FakeSprint = {
        id: this.nextId++,
        name: input.name,
        state: "future",
        boardId: input.originBoardId,
        goal: input.goal ?? "",
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        completeDate: null,
      };
      this.sprints.push(sprint);
      return new Created(this.sprintJson(sprint));
    }
    if ((m = /^\/sprint\/(\d+)$/.exec(p)) && method === "POST")
      return this.updateSprint(Number(m[1]), ctx.body as Record<string, string>);
    if ((m = /^\/sprint\/(\d+)\/issue$/.exec(p)) && method === "POST") {
      const sprint = this.sprints.find((s) => s.id === Number(m?.[1]));
      if (!sprint || sprint.state === "closed")
        throw new HttpError(400, errorBody(["Sprint is closed or does not exist."]));
      for (const key of (ctx.body as { issues: string[] }).issues) {
        const issue = this.mustIssue(key);
        issue.sprintId = sprint.id;
        issue.updated_ms = Date.now();
      }
      return undefined;
    }
    if (p === "/backlog/issue" && method === "POST") {
      for (const key of (ctx.body as { issues: string[] }).issues) {
        const issue = this.mustIssue(key);
        issue.sprintId = null;
        issue.updated_ms = Date.now();
      }
      return undefined;
    }
    if (p === "/issue/rank" && method === "PUT") {
      const input = ctx.body as {
        issues: string[];
        rankBeforeIssue?: string;
        rankAfterIssue?: string;
      };
      const anchor = this.mustIssue(input.rankBeforeIssue ?? input.rankAfterIssue ?? "");
      const step = input.rankBeforeIssue ? -0.001 : 0.001;
      input.issues.forEach((key, index) => {
        const issue = this.mustIssue(key);
        issue.rank =
          anchor.rank + step * (input.rankBeforeIssue ? input.issues.length - index : index + 1);
        issue.updated_ms = Date.now();
      });
      return undefined;
    }
    throw new HttpError(404, errorBody([`No agile route ${method} ${path}`]));
  }

  private updateSprint(id: number, body: Record<string, string>): unknown {
    const sprint = this.sprints.find((s) => s.id === id);
    if (!sprint) throw new HttpError(404, errorBody(["Sprint not found"]));
    if (body.state === "active") {
      if (sprint.state !== "future")
        throw new HttpError(400, errorBody(["Only a future sprint can be started."]));
      if (!body.startDate || !body.endDate)
        throw new HttpError(400, errorBody([], { startDate: "Start and end dates are required." }));
      if (this.sprints.some((s) => s.boardId === sprint.boardId && s.state === "active")) {
        throw new HttpError(400, errorBody(["Another sprint is already active on this board."]));
      }
    }
    if (body.state === "closed") {
      if (sprint.state !== "active")
        throw new HttpError(400, errorBody(["Only an active sprint can be completed."]));
      sprint.completeDate = new Date().toISOString();
      // Like Jira, open issues move to the backlog when nothing moved them first.
      for (const issue of this.issues.values())
        if (issue.sprintId === id && issue.statusId !== "5") issue.sprintId = null;
    }
    if (body.name !== undefined) sprint.name = body.name;
    if (body.goal !== undefined) sprint.goal = body.goal;
    if (body.startDate) sprint.startDate = body.startDate;
    if (body.endDate) sprint.endDate = body.endDate;
    if (body.state === "active" || body.state === "closed") sprint.state = body.state;
    return this.sprintJson(sprint);
  }

  // oxlint-disable-next-line complexity, max-lines-per-function
  private async routePlatform(ctx: RouteContext): Promise<unknown> {
    const { method, query } = ctx;
    const api = this.api();
    if (!ctx.path.startsWith(api) && !ctx.path.startsWith("/secure/"))
      throw new HttpError(404, errorBody([`No route ${ctx.path}`]));
    if (ctx.path.startsWith(api === "/rest/api/3" ? "/rest/api/2/" : "/rest/api/3/"))
      throw new HttpError(404, errorBody(["Wrong API version for this deployment"]));
    const p = ctx.path.slice(api.length);
    const me = this.refOf(ctx.user);
    let m: RegExpExecArray | null;
    if ((m = /^\/secure\/(attachment|thumbnail)\/(\d+)\//.exec(ctx.path))) {
      const attachment = this.findAttachment(m[2] ?? "");
      return new Binary(attachment.bytes, attachment.mimeType);
    }
    if (p === "/myself") return this.userJson(me);
    if (p === "/field") {
      return [
        {
          id: "summary",
          name: "Summary",
          custom: false,
          schema: { type: "string", system: "summary" },
        },
        {
          id: SPRINT_FIELD,
          name: "Sprint",
          custom: true,
          schema: {
            type: "array",
            items: "json",
            custom: "com.pyxis.greenhopper.jira:gh-sprint",
            customId: 10020,
          },
        },
        {
          id: POINTS_FIELD,
          name: "Story point estimate",
          custom: true,
          schema: {
            type: "number",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
          },
        },
        {
          id: FLAGGED_FIELD,
          name: "Flagged",
          custom: true,
          schema: {
            type: "array",
            items: "option",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:multicheckboxes",
          },
        },
        ...(this.deployment === "datacenter"
          ? [
              {
                id: EPIC_LINK_FIELD,
                name: "Epic Link",
                custom: true,
                schema: { type: "any", custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
              },
            ]
          : []),
      ];
    }
    if (p === "/status") return STATUSES.map((s) => this.statusJson(s.id));
    if (p === "/project/search" && this.deployment === "cloud") {
      const q = query.get("query")?.toLowerCase() ?? "";
      const projects = this.projectKeys
        .map((key) => ({
          id: String(this.projectKeys.indexOf(key) + 10000),
          key,
          name: `${key} project`,
          projectTypeKey: "software",
          lead: this.userJson(me),
          avatarUrls: {},
        }))
        .filter(
          (pr) => !q || pr.name.toLowerCase().includes(q) || pr.key.toLowerCase().includes(q),
        );
      return this.page(projects, query);
    }
    if (p === "/project" && this.deployment === "datacenter") {
      return this.projectKeys.map((key) => ({
        id: String(this.projectKeys.indexOf(key) + 10000),
        key,
        name: `${key} project`,
        projectTypeKey: "software",
        lead: this.userJson(me),
      }));
    }
    if (p === "/search" && this.deployment === "cloud")
      throw new HttpError(
        410,
        errorBody([
          "The requested API has been removed. Please migrate to the /rest/api/3/search/jql API.",
        ]),
      );
    if (
      (p === "/search/jql" && this.deployment === "cloud") ||
      (p === "/search" && this.deployment === "datacenter")
    ) {
      const jql = this.matchJql(query.get("jql"), me);
      const items = [...this.issues.values()]
        .filter(jql)
        .sort((a, b) => b.updated_ms - a.updated_ms)
        .map((i) => this.issueJson(i, query));
      return this.page(items, query, "issues", this.deployment === "cloud");
    }
    if (p === "/jql/autocompletedata") {
      return {
        visibleFieldNames: [
          { value: "assignee", displayName: "assignee", operators: ["=", "!="] },
          { value: "status", displayName: "status", operators: ["=", "!="] },
          { value: "project", displayName: "project", operators: ["="] },
          { value: "labels", displayName: "labels", operators: ["="] },
        ],
        visibleFunctionNames: [{ value: "currentUser()", displayName: "currentUser()" }],
      };
    }
    if (p === "/jql/autocompletedata/suggestions") {
      const field = query.get("fieldName");
      const value = (query.get("fieldValue") ?? "").toLowerCase();
      const byField: Record<string, string[]> = {
        status: STATUSES.map((s) => s.name),
        project: this.projectKeys,
      };
      const values = byField[field ?? ""] ?? [];
      return {
        results: values
          .filter((v) => v.toLowerCase().includes(value))
          .map((v) => ({ value: `"${v}"`, displayName: `<b>${v}</b>` })),
      };
    }
    if (p === "/filter/my")
      return this.filters.filter((f) => f.owner === me).map((f) => this.filterJson(f));
    if (p === "/filter/favourite")
      return this.filters.filter((f) => f.favourite).map((f) => this.filterJson(f));
    if ((m = /^\/filter\/(\d+)$/.exec(p))) {
      const filter = this.filters.find((f) => f.id === m?.[1]);
      if (!filter) throw new HttpError(404, errorBody(["Filter not found"]));
      return this.filterJson(filter);
    }
    if (p === "/filter" && method === "POST") {
      const input = ctx.body as { name: string; jql: string; favourite?: boolean };
      this.matchJql(input.jql, me);
      const filter = {
        id: String(this.nextId++),
        name: input.name,
        jql: input.jql,
        owner: me,
        favourite: input.favourite ?? false,
      };
      this.filters.push(filter);
      return this.filterJson(filter);
    }
    if (p === "/issueLinkType") return { issueLinkTypes: LINK_TYPES };
    if (p === "/issueLink" && method === "POST") {
      const input = ctx.body as {
        type: { name: string };
        inwardIssue: { key: string };
        outwardIssue: { key: string };
      };
      this.mustIssue(input.inwardIssue.key);
      this.mustIssue(input.outwardIssue.key);
      this.links.push({
        id: String(this.nextId++),
        type: input.type.name,
        inward: input.inwardIssue.key,
        outward: input.outwardIssue.key,
      });
      return new Created(undefined);
    }
    if (p === "/user/assignable/search" || p === "/user/search") {
      const q = (query.get(this.deployment === "cloud" ? "query" : "username") ?? "").toLowerCase();
      return this.users
        .filter((u) => u.displayName.toLowerCase().includes(q) || u.name.includes(q))
        .map((u) => this.userJson(this.refOf(u)));
    }
    if ((m = /^\/attachment\/(\d+)$/.exec(p))) {
      const attachment = this.findAttachment(m[1] ?? "");
      if (method === "DELETE") {
        for (const issue of this.issues.values())
          issue.attachments = issue.attachments.filter((a) => a.id !== attachment.id);
        return undefined;
      }
      return this.attachmentJson(attachment);
    }
    if ((m = /^\/attachment\/(content|thumbnail)\/(\d+)$/.exec(p)) && this.deployment === "cloud") {
      const id = m[2] ?? "";
      this.findAttachment(id);
      const token = randomBytes(6).toString("hex");
      this.mediaTokens.set(id, token);
      return new Redirect(303, `${this.baseUrl}/media/${id}?token=${token}`);
    }
    if ((m = /^\/issue\/createmeta\/([A-Z]+)\/issuetypes(?:\/(\d+))?$/.exec(p))) {
      if (!m[2])
        return {
          startAt: 0,
          maxResults: 50,
          total: TYPES.length,
          [this.deployment === "cloud" ? "issueTypes" : "values"]: TYPES.map((t) =>
            this.typeJson(t.id),
          ),
        };
      const fields = [
        {
          fieldId: "summary",
          name: "Summary",
          required: true,
          schema: { type: "string", system: "summary" },
        },
        {
          fieldId: "priority",
          name: "Priority",
          required: false,
          schema: { type: "priority", system: "priority" },
          allowedValues: PRIORITIES,
        },
        {
          fieldId: "labels",
          name: "Labels",
          required: false,
          schema: { type: "array", items: "string", system: "labels" },
        },
        {
          fieldId: POINTS_FIELD,
          name: "Story point estimate",
          required: false,
          schema: {
            type: "number",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
          },
        },
      ];
      return {
        startAt: 0,
        maxResults: 50,
        total: fields.length,
        [this.deployment === "cloud" ? "fields" : "values"]: fields,
      };
    }
    if (p === "/issue" && method === "POST") return this.createIssue(ctx);
    if ((m = /^\/issue\/([^/]+)$/.exec(p))) {
      const issue = this.mustIssue(decodeURIComponent(m[1] ?? ""));
      if (method === "PUT") return this.editIssue(issue, ctx);
      return this.issueJson(issue, query);
    }
    if ((m = /^\/issue\/([^/]+)\/(.+)$/.exec(p)))
      return this.issueSub(this.mustIssue(decodeURIComponent(m[1] ?? "")), m[2] ?? "", ctx);
    throw new HttpError(404, errorBody([`No route ${method} ${ctx.path}`]));
  }

  private filterJson(f: {
    id: string;
    name: string;
    jql: string;
    owner: string;
    favourite: boolean;
  }) {
    return {
      id: f.id,
      name: f.name,
      jql: f.jql,
      favourite: f.favourite,
      owner: this.userJson(f.owner),
      viewUrl: `${this.baseUrl}/issues/?filter=${f.id}`,
    };
  }

  private validateText(value: unknown, field: string): void {
    const ok =
      this.deployment === "cloud"
        ? typeof value === "object" && value !== null && (value as { type?: string }).type === "doc"
        : typeof value === "string";
    if (!ok) {
      throw new HttpError(
        400,
        errorBody([], {
          [field]:
            this.deployment === "cloud"
              ? "Operation value must be an Atlassian Document (see the Atlassian Document Format)"
              : "Operation value must be a string",
        }),
      );
    }
  }

  private createIssue(ctx: RouteContext): unknown {
    const fields = (ctx.body as { fields: Record<string, unknown> }).fields;
    const project = (fields.project as { key: string }).key;
    if (!this.projectKeys.includes(project))
      throw new HttpError(400, errorBody([], { project: "valid project is required" }));
    if (!fields.summary)
      throw new HttpError(
        400,
        errorBody([], { summary: "You must specify a summary of the issue." }),
      );
    if (fields.description !== undefined) this.validateText(fields.description, "description");
    const count = [...this.issues.values()].filter((i) => i.project === project).length;
    const key = `${project}-${count + 1}`;
    const id = this.nextId++;
    const issue: FakeIssue = {
      id,
      key,
      project,
      summary: String(fields.summary),
      typeId: (fields.issuetype as { id: string }).id,
      statusId: "1",
      priorityId: (fields.priority as { id?: string } | undefined)?.id ?? "3",
      assignee: null,
      reporter: this.refOf(ctx.user),
      labels: (fields.labels as string[] | undefined) ?? [],
      parentKey: (fields.parent as { key?: string } | undefined)?.key ?? null,
      description: fields.description ?? null,
      created_ms: Date.now(),
      updated_ms: Date.now(),
      sprintId: null,
      storyPoints: (fields[POINTS_FIELD] as number | undefined) ?? null,
      flagged: false,
      rank: id,
      resolutionId: null,
      comments: [],
      worklogs: [],
      attachments: [],
      watchers: new Set([this.refOf(ctx.user)]),
      remoteLinks: [],
      history: [],
    };
    this.issues.set(key, issue);
    return new Created({ id: String(id), key, self: `${this.baseUrl}${this.api()}/issue/${id}` });
  }

  // oxlint-disable-next-line complexity
  private editIssue(issue: FakeIssue, ctx: RouteContext): unknown {
    const fields = (ctx.body as { fields?: Record<string, unknown> }).fields ?? {};
    const meta = this.editmeta();
    for (const [field, value] of Object.entries(fields)) {
      if (!(field in meta))
        throw new HttpError(
          400,
          errorBody([], {
            [field]: `Field '${field}' cannot be set. It is not on the appropriate screen, or unknown.`,
          }),
        );
      switch (field) {
        case "summary":
          this.recordChange(issue, this.refOf(ctx.user), "summary", issue.summary, String(value));
          issue.summary = String(value);
          break;
        case "description":
          this.validateText(value, "description");
          issue.description = value;
          break;
        case "labels":
          issue.labels = value as string[];
          break;
        case "priority":
          issue.priorityId = (value as { id: string }).id;
          break;
        case POINTS_FIELD:
          issue.storyPoints = value as number | null;
          break;
        case "assignee": {
          const ref =
            value === null
              ? null
              : ((value as { accountId?: string; name?: string }).accountId ??
                (value as { name?: string }).name ??
                null);
          issue.assignee = ref;
          break;
        }
        default:
          break;
      }
    }
    issue.updated_ms = Date.now();
    return undefined;
  }

  // oxlint-disable-next-line complexity, max-lines-per-function
  private async issueSub(issue: FakeIssue, sub: string, ctx: RouteContext): Promise<unknown> {
    const { method, query } = ctx;
    const me = this.refOf(ctx.user);
    if (sub === "editmeta") return { fields: this.editmeta() };
    if (sub === "transitions" && method === "GET") {
      const only = query.get("transitionId");
      const expandFields = (query.get("expand") ?? "").includes("transitions.fields");
      const resolutionField = {
        resolution: {
          required: true,
          name: "Resolution",
          key: "resolution",
          schema: { type: "resolution", system: "resolution" },
          operations: ["set"],
          allowedValues: RESOLUTIONS,
        },
      };
      const transitions = STATUSES.filter((s) => s.id !== issue.statusId)
        .map((s) => {
          const transition: Record<string, unknown> = {
            id: TRANSITION_IDS[s.id] ?? "",
            name: s.name,
            to: this.statusJson(s.id),
            hasScreen: s.id === "5",
            isGlobal: true,
            isInitial: false,
            isAvailable: true,
            isConditional: false,
            isLooped: false,
          };
          if (expandFields) transition.fields = s.id === "5" ? resolutionField : {};
          return transition;
        })
        .filter((t) => !only || t.id === only);
      return { expand: "transitions", transitions };
    }
    if (sub === "transitions" && method === "POST") {
      const body = ctx.body as {
        transition: { id: string };
        fields?: Record<string, unknown>;
        update?: { comment?: Array<{ add: { body: unknown } }> };
      };
      const target = Object.entries(TRANSITION_IDS).find(
        ([, id]) => id === body.transition.id,
      )?.[0];
      if (!target || target === issue.statusId)
        throw new HttpError(
          400,
          errorBody(["Transition id '" + body.transition.id + "' is not valid for this issue."]),
        );
      if (target === "5") {
        const resolution = body.fields?.resolution as { id?: string } | undefined;
        if (!resolution?.id)
          throw new HttpError(400, errorBody([], { resolution: "Resolution is required." }));
        issue.resolutionId = resolution.id;
      } else {
        issue.resolutionId = null;
      }
      for (const comment of body.update?.comment ?? []) {
        this.validateText(comment.add.body, "comment");
        issue.comments.push({
          id: String(this.nextId++),
          author: me,
          body: comment.add.body,
          created_ms: Date.now(),
          updated_ms: Date.now(),
        });
      }
      this.recordChange(
        issue,
        me,
        "status",
        this.statusName(issue.statusId),
        this.statusName(target),
      );
      issue.statusId = target;
      issue.updated_ms = Date.now();
      return undefined;
    }
    if (sub === "assignee" && method === "PUT") {
      const body = ctx.body as { accountId?: string | null; name?: string | null };
      const ref = this.deployment === "cloud" ? body.accountId : body.name;
      if (ref === undefined) throw new HttpError(400, errorBody(["Specify accountId"]));
      if (ref !== null && !this.userByRef(ref))
        throw new HttpError(400, errorBody([], { assignee: "User cannot be assigned issues." }));
      this.recordChange(
        issue,
        me,
        "assignee",
        this.userByRef(issue.assignee)?.displayName ?? null,
        this.userByRef(ref)?.displayName ?? null,
      );
      issue.assignee = ref;
      issue.updated_ms = Date.now();
      return undefined;
    }
    if (sub === "watchers") {
      if (method === "POST") {
        const ref = ctx.body === null ? me : String(ctx.body);
        if (!this.userByRef(ref)) throw new HttpError(400, errorBody(["Unknown user"]));
        issue.watchers.add(ref);
        return undefined;
      }
      if (method === "DELETE") {
        issue.watchers.delete(
          query.get(this.deployment === "cloud" ? "accountId" : "username") ?? "",
        );
        return undefined;
      }
      return {
        isWatching: issue.watchers.has(me),
        watchCount: issue.watchers.size,
        watchers: [...issue.watchers].map((r) => this.userJson(r)),
      };
    }
    if (sub === "changelog" && this.deployment === "cloud")
      return this.page(
        issue.history.map((h) => this.historyJson(h)),
        query,
      );
    if (sub === "comment" && method === "GET") {
      const sorted = [...issue.comments].sort((a, b) =>
        query.get("orderBy") === "-created"
          ? b.created_ms - a.created_ms
          : a.created_ms - b.created_ms,
      );
      const page = this.page(
        sorted.map((c) => this.commentJson(c)),
        query,
      );
      return {
        startAt: page.startAt,
        maxResults: page.maxResults,
        total: page.total,
        comments: page.values,
      };
    }
    if (sub === "comment" && method === "POST") {
      const body = (ctx.body as { body: unknown }).body;
      this.validateText(body, "comment");
      const comment = {
        id: String(this.nextId++),
        author: me,
        body,
        created_ms: Date.now(),
        updated_ms: Date.now(),
      };
      issue.comments.push(comment);
      issue.updated_ms = Date.now();
      return new Created(this.commentJson(comment));
    }
    let m: RegExpExecArray | null;
    if ((m = /^comment\/(\d+)$/.exec(sub)) && method === "PUT") {
      const comment = issue.comments.find((c) => c.id === m?.[1]);
      if (!comment) throw new HttpError(404, errorBody(["Comment not found"]));
      if (comment.author !== me)
        throw new HttpError(
          403,
          errorBody(["You do not have the permission to edit this comment."]),
        );
      const body = (ctx.body as { body: unknown }).body;
      this.validateText(body, "comment");
      comment.body = body;
      comment.updated_ms = Date.now();
      return this.commentJson(comment);
    }
    if (sub === "worklog" && method === "GET") {
      const page = this.page(
        issue.worklogs.map((w) => this.worklogJson(w)),
        query,
      );
      return {
        startAt: page.startAt,
        maxResults: page.maxResults,
        total: page.total,
        worklogs: page.values,
      };
    }
    if (sub === "worklog" && method === "POST") {
      const body = ctx.body as { timeSpent: string; started: string; comment?: unknown };
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/.test(body.started))
        throw new HttpError(400, errorBody([], { started: "Invalid date format." }));
      const seconds = parseDuration(body.timeSpent);
      if (seconds === null)
        throw new HttpError(400, errorBody([], { timeLogged: "Invalid time duration entered." }));
      if (body.comment !== undefined) this.validateText(body.comment, "comment");
      if (!["auto", "leave", "new", "manual"].includes(query.get("adjustEstimate") ?? "auto"))
        throw new HttpError(400, errorBody(["bad adjustEstimate"]));
      const worklog = {
        id: String(this.nextId++),
        author: me,
        timeSpent: body.timeSpent,
        timeSpentSeconds: seconds,
        started: body.started,
        comment: body.comment ?? null,
      };
      issue.worklogs.push(worklog);
      issue.updated_ms = Date.now();
      return new Created(this.worklogJson(worklog));
    }
    if (sub === "attachments" && method === "POST") {
      if (ctx.req.headers["x-atlassian-token"] !== "no-check")
        throw new HttpError(403, errorBody(["XSRF check failed"]));
      const form = await new Response(new Uint8Array(ctx.raw), {
        headers: { "content-type": String(ctx.req.headers["content-type"]) },
      }).formData();
      const file = form.get("file");
      if (!(file instanceof Blob)) throw new HttpError(400, errorBody(["No file"]));
      const attachment: FakeAttachment = {
        id: String(this.nextId++),
        filename: (file as File).name,
        mimeType: file.type || "application/octet-stream",
        bytes: Buffer.from(await file.arrayBuffer()),
        author: me,
        created_ms: Date.now(),
      };
      issue.attachments.push(attachment);
      issue.updated_ms = Date.now();
      return [this.attachmentJson(attachment)];
    }
    if (sub === "remotelink" && method === "GET")
      return issue.remoteLinks.map((l) => ({
        id: Number(l.id),
        self: `${this.baseUrl}/remotelink/${l.id}`,
        object: { url: l.url, title: l.title },
      }));
    if (sub === "remotelink" && method === "POST") {
      const object = (ctx.body as { object: { url: string; title: string } }).object;
      const link = { id: String(this.nextId++), url: object.url, title: object.title };
      issue.remoteLinks.push(link);
      return new Created({ id: Number(link.id), self: `${this.baseUrl}/remotelink/${link.id}` });
    }
    throw new HttpError(404, errorBody([`No route ${method} issue/${sub}`]));
  }

  private commentJson(c: FakeComment) {
    return {
      id: c.id,
      author: this.userJson(c.author),
      updateAuthor: this.userJson(c.author),
      body: c.body,
      created: jiraTimestamp(c.created_ms),
      updated: jiraTimestamp(c.updated_ms),
    };
  }

  private worklogJson(w: FakeWorklog) {
    return {
      id: w.id,
      author: this.userJson(w.author),
      timeSpent: w.timeSpent,
      timeSpentSeconds: w.timeSpentSeconds,
      started: w.started,
      comment: w.comment ?? undefined,
    };
  }
}

function parseDuration(text: string): number | null {
  const units: Record<string, number> = { w: 5 * 8 * 3600, d: 8 * 3600, h: 3600, m: 60 };
  let total = 0;
  const parts = text.trim().split(/\s+/);
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)([wdhm])$/.exec(part);
    if (!match) return null;
    total += Number(match[1]) * (units[match[2] ?? "m"] ?? 60);
  }
  return parts.length > 0 ? total : null;
}

interface RouteContext {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  raw: Buffer;
  req: http.IncomingMessage;
  user: FakeUser;
}

const NOT_AGILE = Symbol("not-agile");

class Redirect {
  constructor(
    readonly status: number,
    readonly location: string,
  ) {}
}

class Binary {
  constructor(
    readonly bytes: Buffer,
    readonly type: string,
  ) {}
}

class Created {
  constructor(readonly body: unknown) {}
}
