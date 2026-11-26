import { describe, expect, it } from "vitest";
import { extractJiraIssueRefs, matchJiraIssueRefs, siteHost } from "./issue-key";

const site = {
  connectionId: "jir_site",
  host: "acme.atlassian.net",
  projectKeys: new Set(["ABC", "OPS"]),
};

describe("Jira issue refs in a composer (spec 29.4, A29.agent.2)", () => {
  it("reads pasted browse links and typed keys", () => {
    expect(
      extractJiraIssueRefs(
        "see https://acme.atlassian.net/browse/ABC-1, then ABC-2 and #OPS-7 please",
      ),
    ).toEqual([
      { key: "ABC-1", host: "acme.atlassian.net" },
      { key: "ABC-2", host: null },
      { key: "OPS-7", host: null },
    ]);
  });

  it("reads board links that select an issue", () => {
    expect(
      extractJiraIssueRefs(
        "https://acme.atlassian.net/jira/software/projects/ABC/boards/3?selectedIssue=ABC-9",
      ),
    ).toEqual([{ key: "ABC-9", host: "acme.atlassian.net" }]);
  });

  it("leaves keys inside longer tokens and paths as text", () => {
    expect(extractJiraIssueRefs("encoding x-UTF-8 and src/ABC-1.ts and ABC-1x")).toEqual([]);
  });

  it("chips only keys whose project or site belongs to a connection", () => {
    const refs = extractJiraIssueRefs(
      "https://acme.atlassian.net/browse/ABC-1 ABC-2 UTF-8 ZZZ-4 https://other.example/browse/ABC-3 ABC-2",
    );
    expect(matchJiraIssueRefs(refs, [site])).toEqual([
      { connectionId: "jir_site", key: "ABC-1" },
      { connectionId: "jir_site", key: "ABC-2" },
    ]);
  });

  it("normalizes the connection's site URL to a host", () => {
    expect(siteHost("https://Acme.atlassian.net/")).toBe("acme.atlassian.net");
    expect(siteHost("not a url")).toBeNull();
  });
});
