import { describe, expect, it } from "vitest";
import { isDockAgent, resolveDockAgentOwner } from "./dock-agents";

describe("resolveDockAgentOwner", () => {
  it("maps each dock label to its owner", () => {
    expect(resolveDockAgentOwner({ "jagentdesk.simfleet.server": "srv" })).toEqual({
      kind: "simfleet",
      serverId: "srv",
    });
    expect(resolveDockAgentOwner({ "jagentdesk.database.id": "d1" })).toEqual({
      kind: "database",
      databaseId: "d1",
    });
    expect(resolveDockAgentOwner({ "jagentdesk.cluster.id": "c1" })).toEqual({
      kind: "cluster",
      clusterId: "c1",
    });
  });

  it("treats other agents as regular workspace agents", () => {
    expect(resolveDockAgentOwner({})).toBeNull();
    expect(resolveDockAgentOwner(undefined)).toBeNull();
    expect(isDockAgent({ labels: { "jagentdesk.team.role": "lead" } })).toBe(false);
  });
});
