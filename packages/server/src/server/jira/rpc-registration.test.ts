import { readFileSync } from "node:fs";
import path from "node:path";
import { JIRA_REQUEST_TYPES } from "@jagentdesk/protocol/jira/rpc-schemas";
import { describe, expect, it } from "vitest";

// A jira.* request must be listed in session.ts's dispatchJiraMessage AND handled by
// JiraSession.handle; a request missing from the session list never reaches the handler and the
// client times out with no response (the Forge Hub incident). The handler side is exhaustive by
// type; this pins the session side.
describe("jira RPC registration", () => {
  it("lists every jira request type in the session dispatcher", () => {
    const source = readFileSync(path.join(import.meta.dirname, "..", "session.ts"), "utf8");
    const start = source.indexOf("private dispatchJiraMessage(");
    const body = source.slice(start, source.indexOf("default:", start));
    const listed = new Set([...body.matchAll(/case "([^"]+)":/g)].map((match) => match[1]));
    const missing = JIRA_REQUEST_TYPES.filter((type) => !listed.has(type));
    expect(missing).toEqual([]);
    expect(JIRA_REQUEST_TYPES.length).toBe(48);
  });
});
