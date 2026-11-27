import { describe, expect, it } from "vitest";
import { botOwnedWorkspaceKeys, useBotOwnedWorkspaces } from "./owned-workspaces-store";

describe("bot-owned workspaces", () => {
  it("keys handed workspaces and the workspaces its worker agents run in", () => {
    const keys = botOwnedWorkspaceKeys(
      {
        "host:b1": { workspaceIds: ["ws-handed"], workerAgentIds: ["worker-1", "gone"] },
        "host:b2": { workspaceIds: [], workerAgentIds: ["worker-2"] },
      },
      (_serverId, agentId) => ({ "worker-1": "ws-worker", "worker-2": "ws-other" })[agentId],
    );
    expect([...keys].sort()).toEqual(["host:ws-handed", "host:ws-other", "host:ws-worker"]);
  });
  it("keeps the same state when a bot republishes the same lists, and drops a deleted bot", () => {
    const store = useBotOwnedWorkspaces.getState();
    store.publish("host", "b1", { workspaceIds: ["a"], workerAgentIds: [] });
    const first = useBotOwnedWorkspaces.getState().byBot;
    store.publish("host", "b1", { workspaceIds: ["a"], workerAgentIds: [] });
    expect(useBotOwnedWorkspaces.getState().byBot).toBe(first);
    store.publish("host", "b1", null);
    expect(useBotOwnedWorkspaces.getState().byBot["host:b1"]).toBeUndefined();
  });
});
