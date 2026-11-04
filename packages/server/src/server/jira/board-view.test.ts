import type { JiraIssueCard } from "@jagentdesk/protocol/jira/rpc-schemas";
import { describe, expect, it } from "vitest";
import { andJql, applyBoardFilter, computeLanes, jqlTime, onBoard } from "./board-view.js";

function card(id: string, patch: Partial<JiraIssueCard> = {}): JiraIssueCard {
  return {
    id,
    key: `K-${id}`,
    summary: `Issue ${id}`,
    type: { id: "10001", name: "Story", subtask: false },
    status: { id: "1", name: "To Do", category: "new" },
    priority: null,
    assignee: null,
    estimate: null,
    parent: null,
    labels: [],
    flagged: false,
    sprintId: null,
    updated_ms: 0,
    ...patch,
  };
}

const ada = { ref: "u1", displayName: "B user" };
const bob = { ref: "u2", displayName: "A user" };

describe("board view", () => {
  it("keeps only issues whose status is mapped to a column", () => {
    const issues = [card("1"), card("2", { status: { id: "9", name: "Hidden", category: "new" } })];
    expect(
      onBoard(issues, [{ name: "To Do", statusIds: ["1"], min: null, max: null }]).map((i) => i.id),
    ).toEqual(["1"]);
  });

  it("groups by assignee (sorted, unassigned last) and by epic", () => {
    const issues = [
      card("1", { assignee: ada }),
      card("2"),
      card("3", {
        assignee: bob,
        parent: { id: "e", key: "E-1", summary: "Epic", typeName: "Epic" },
      }),
    ];
    expect(computeLanes(issues, { mode: "assignee", queries: [] }, new Map())).toEqual([
      { id: "user:u2", title: "A user", issueIds: ["3"] },
      { id: "user:u1", title: "B user", issueIds: ["1"] },
      { id: "rest", title: "Unassigned", issueIds: ["2"] },
    ]);
    expect(computeLanes(issues, { mode: "epic", queries: [] }, new Map())).toEqual([
      { id: "parent:E-1", title: "E-1 Epic", issueIds: ["3"] },
      { id: "rest", title: "Issues without epic", issueIds: ["1", "2"] },
    ]);
  });

  it("puts an issue in the first query lane it matches", () => {
    const issues = [card("1"), card("2"), card("3")];
    const lanes = computeLanes(
      issues,
      {
        mode: "queries",
        queries: [
          { id: "a", name: "A", jql: "x" },
          { id: "b", name: "B", jql: "y" },
        ],
      },
      new Map([
        ["a", new Set(["1"])],
        ["b", new Set(["1", "2"])],
      ]),
    );
    expect(lanes).toEqual([
      { id: "query:a", title: "A", issueIds: ["1"] },
      { id: "query:b", title: "B", issueIds: ["2"] },
      { id: "rest", title: "Everything else", issueIds: ["3"] },
    ]);
  });

  it("filters by text, assignee, label and type", () => {
    const issues = [
      card("1", { assignee: ada, labels: ["ui"] }),
      card("2", { summary: "Fix login" }),
    ];
    expect(applyBoardFilter(issues, { text: "login" }).map((i) => i.id)).toEqual(["2"]);
    expect(applyBoardFilter(issues, { assigneeRefs: ["unassigned"] }).map((i) => i.id)).toEqual([
      "2",
    ]);
    expect(applyBoardFilter(issues, { labels: ["ui"] }).map((i) => i.id)).toEqual(["1"]);
  });

  it("formats JQL clauses and times in the user's zone", () => {
    expect(andJql(["a = 1", null, " ", "b = 2"])).toBe("(a = 1) AND (b = 2)");
    expect(andJql([])).toBeNull();
    expect(jqlTime(Date.UTC(2026, 10, 4, 20, 5), "Asia/Ho_Chi_Minh")).toBe("2026/11/05 03:05");
    expect(jqlTime(Date.UTC(2026, 10, 4, 20, 5), "UTC")).toBe("2026/11/04 20:05");
  });
});
