import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createJiraAgentTools, type JiraToolPermissionRequest } from "./agent-tools.js";
import { JiraService } from "./service.js";
import { FakeJiraServer } from "./test-support/fake-jira-server.js";

// Spec 29.4 / criterion 7: the agent reads without asking, every write raises the permission
// card first, and a denied write never reaches Jira.

const READS = [
  "jira_list_connections",
  "jira_list_projects",
  "jira_search",
  "jira_get_issue",
  "jira_get_comments",
  "jira_get_changelog",
  "jira_get_worklogs",
  "jira_get_transitions",
  "jira_get_create_meta",
  "jira_list_boards",
  "jira_get_board",
  "jira_list_sprints",
  "jira_get_sprint_issues",
  "jira_get_backlog",
  "jira_find_users",
  "jira_list_filters",
  "jira_get_attachment",
];
const WRITES = [
  "jira_create_issue",
  "jira_update_issue",
  "jira_transition_issue",
  "jira_assign_issue",
  "jira_add_comment",
  "jira_add_worklog",
  "jira_link_issues",
  "jira_add_remote_link",
  "jira_add_attachment",
  "jira_move_to_sprint",
  "jira_move_to_backlog",
  "jira_rank_issues",
  "jira_create_sprint",
  "jira_update_sprint",
];

describe("jira_* agent tools", () => {
  let fake: FakeJiraServer;
  let home: string;
  let service: JiraService;
  let asked: JiraToolPermissionRequest[];
  let decision: "allow" | "deny";

  beforeEach(async () => {
    fake = new FakeJiraServer({ deployment: "cloud" });
    await fake.start();
    home = mkdtempSync(path.join(tmpdir(), "jad-jira-tools-"));
    service = new JiraService({
      jagentdeskHome: home,
      endpoints: { authUrl: fake.baseUrl, apiUrl: fake.baseUrl },
      logger: pino({ level: "silent" }),
    });
    await service.initialize();
    await service.addTokenConnection({
      deployment: "cloud",
      siteUrl: fake.baseUrl,
      method: "api_token",
      email: "admin@jira.test",
      token: fake.apiToken,
    });
    asked = [];
    decision = "allow";
  });
  afterEach(async () => {
    service.dispose();
    await fake.stop();
    rmSync(home, { recursive: true, force: true });
  });

  function tools() {
    return createJiraAgentTools({
      service,
      callerAgentId: "agent-1",
      requestPermission: async (_agentId, request) => {
        asked.push(request);
        return decision === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: "Denied by user." };
      },
    });
  }

  async function call(name: string, input: Record<string, unknown>) {
    const tool = tools().find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`no tool ${name}`);
    const result = await tool.handler(input, {});
    return { text: String(result.content[0]?.text ?? ""), isError: result.isError === true };
  }

  it("offers exactly the spec's tools, with no delete tool", () => {
    const all = tools();
    expect(
      all
        .filter((t) => !t.requiresPermission)
        .map((t) => t.name)
        .sort(),
    ).toEqual([...READS].sort());
    expect(
      all
        .filter((t) => t.requiresPermission)
        .map((t) => t.name)
        .sort(),
    ).toEqual([...WRITES].sort());
    expect(all.some((t) => t.name.includes("delete"))).toBe(false);
  });

  it("criterion 7: reads without asking; transition and comment ask first, then write", async () => {
    const issue = await call("jira_get_issue", { issueKey: "ABC-2" });
    expect(issue.isError).toBe(false);
    expect(issue.text).toContain("# ABC-2: Card form validates expiry date");
    expect(issue.text).toContain("Acceptance criteria: reject past months");
    expect(issue.text).toContain("**Test Reviewer**");
    expect(asked).toEqual([]);

    const transitions = await call("jira_get_transitions", { issueKey: "ABC-2" });
    expect(transitions.text).toContain("id 31: In Review → In Review");

    decision = "deny";
    const denied = await call("jira_add_comment", {
      issueKey: "ABC-2",
      bodyMarkdown: "PR: https://git.test/pr/7",
    });
    expect(denied).toEqual({ text: "Denied by user.", isError: true });
    expect(fake.issues.get("ABC-2")?.comments).toHaveLength(1);

    decision = "allow";
    const moved = await call("jira_transition_issue", { issueKey: "ABC-2", transitionId: "31" });
    expect(moved).toEqual({ text: "ABC-2 is now In Review.", isError: false });
    const commented = await call("jira_add_comment", {
      issueKey: "ABC-2",
      bodyMarkdown: "Opened [PR 7](https://git.test/shop/pull/7)",
    });
    expect(commented.isError).toBe(false);
    expect(asked.map((a) => [a.name, a.kind, a.title])).toEqual([
      ["jira_add_comment", "tool", "Comment on ABC-2"],
      ["jira_transition_issue", "tool", "Transition ABC-2"],
      ["jira_add_comment", "tool", "Comment on ABC-2"],
    ]);
    const stored = JSON.stringify(fake.issues.get("ABC-2")?.comments.at(-1)?.body);
    expect(stored).toContain('"href":"https://git.test/shop/pull/7"');
    expect(fake.issues.get("ABC-2")?.statusId).toBe("4");
  });

  it("reports Jira errors as tool errors", async () => {
    const result = await call("jira_search", { jql: "bogus = 1" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("bogus");
  });
});
