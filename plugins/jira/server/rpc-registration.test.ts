import { JIRA_REQUEST_TYPES } from "@jagentdesk/protocol/jira/rpc-schemas";
import { describe, expect, it } from "vitest";
import { BuiltinServerRegistry } from "../../../packages/server/src/server/plugins/builtin/host-test-api.js";
import { register } from "./index.js";

// Every jira.* request is admitted and dispatched by the one built-in registration; a request
// missing from it never reaches JiraSession.handle and the client times out (the Forge Hub
// incident). The handler side is exhaustive by type; this pins the registration side.
describe("jira RPC registration", () => {
  it("registers every jira request type through the built-in host", () => {
    const registry = new BuiltinServerRegistry();
    register(registry.forPlugin("jira"));
    const names = registry.rpcNames();
    expect(JIRA_REQUEST_TYPES.filter((type) => !names.includes(type))).toEqual([]);
    expect(names).toHaveLength(48);
    expect(JIRA_REQUEST_TYPES.length).toBe(48);
  });
});
