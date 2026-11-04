import { describe, expect, it } from "vitest";
import { buildJiraAssistantSystemPrompt, jiraAssistantScope } from "./assistant/context";
import { lastIssueKey } from "./composer/issue-key";
import { basicToJql } from "./home/search-view";
import { parseJiraLocation } from "./nav";

describe("Jira app helpers", () => {
  it("reads the Jira location from the route params", () => {
    expect(
      parseJiraLocation({ c: "jir_a1b2c3", view: "board", board: "7", issue: "ABC-2" }),
    ).toEqual({
      connectionId: "jir_a1b2c3",
      view: "board",
      boardId: 7,
      projectKey: null,
      issueKey: "ABC-2",
      jql: null,
    });
    expect(parseJiraLocation({ view: "nonsense", board: "x" })).toMatchObject({
      view: "projects",
      boardId: null,
    });
  });

  it("writes basic search as JQL", () => {
    expect(basicToJql({ projectKey: "ABC", mine: true, openOnly: true, text: 'say "hi"' })).toBe(
      'project = ABC AND assignee = currentUser() AND statusCategory != Done AND text ~ "say \\"hi\\"" ORDER BY updated DESC',
    );
    expect(basicToJql({ projectKey: null, mine: false, openOnly: false, text: "" })).toBe(
      "ORDER BY updated DESC",
    );
  });

  it("finds the last issue key typed in a composer", () => {
    expect(lastIssueKey("please look at ABC-12 and then OPS-3")).toBe("OPS-3");
    expect(lastIssueKey("utf-8 and abc-12 are not keys")).toBeNull();
  });

  it("scopes the assistant to the issue on screen and names it in the prompt", () => {
    const context = {
      connectionId: "jir_a1b2c3",
      siteLabel: "<site>",
      projectKey: "ABC",
      boardId: 1,
      issueKey: "ABC-2",
    };
    expect(jiraAssistantScope(context)).toBe("jir_a1b2c3/ABC-2");
    const prompt = buildJiraAssistantSystemPrompt(context);
    expect(prompt).toContain('connectionId "jir_a1b2c3"');
    expect(prompt).toContain("The issue on screen is ABC-2");
  });
});
