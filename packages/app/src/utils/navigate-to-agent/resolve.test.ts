import { describe, expect, it } from "vitest";
import {
  resolveNavigateToAgent,
  type AgentNavTarget,
  type NavigateToAgentDeps,
} from "@/utils/navigate-to-agent/resolve";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "workspace-1";
const AGENT_ID = "agent-1";

interface RecordedHostNav {
  route: string;
}

interface RecordedTabNav extends NavigateToWorkspaceInput {}

function createFakeNavigators(target: AgentNavTarget): {
  deps: NavigateToAgentDeps;
  hostNavigations: RecordedHostNav[];
  tabNavigations: RecordedTabNav[];
} {
  const hostNavigations: RecordedHostNav[] = [];
  const tabNavigations: RecordedTabNav[] = [];
  return {
    hostNavigations,
    tabNavigations,
    deps: {
      readAgentNavTarget: () => target,
      navigateToHostAgent: (route) => {
        hostNavigations.push({ route });
      },
      navigateToWorkspace: (input) => {
        tabNavigations.push(input);
        return `/h/${input.serverId}/workspace/${input.workspaceId}`;
      },
    },
  };
}

describe("resolveNavigateToAgent", () => {
  it("opens the workspace tab carried by the agent's workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
    });

    const route = resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, pin: true },
      deps,
    );

    expect(route).toBe("/h/server-1/workspace/workspace-1");
    expect(hostNavigations).toEqual([]);
    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: true,
      },
    ]);
  });

  it("prefers the input workspaceId over the stored one", () => {
    // The store is still read (a screen dock agent must be recognised even when the caller
    // passes a workspace), but an explicit workspaceId wins for the tab target.
    const { deps, tabNavigations } = createFakeNavigators({ agentWorkspaceId: "stale-workspace" });

    resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, workspaceId: WORKSPACE_ID },
      deps,
    );

    expect(tabNavigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: WORKSPACE_ID,
        target: { kind: "agent", agentId: AGENT_ID },
        pin: undefined,
      },
    ]);
  });

  it("falls back to the host agent route when the agent has no workspaceId", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: null,
    });

    const route = resolveNavigateToAgent({ serverId: SERVER_ID, agentId: "missing-agent" }, deps);

    expect(route).toBe("/h/server-1/agent/missing-agent");
    expect(hostNavigations).toEqual([{ route: "/h/server-1/agent/missing-agent" }]);
    expect(tabNavigations).toEqual([]);
  });
});

describe("resolveNavigateToAgent for screen dock agents", () => {
  it("opens the agent in its screen dock instead of a workspace tab", () => {
    const { deps, hostNavigations, tabNavigations } = createFakeNavigators({
      agentWorkspaceId: WORKSPACE_ID,
      dockOwner: { kind: "simfleet", serverId: SERVER_ID },
    });
    const docked: unknown[] = [];
    const route = resolveNavigateToAgent(
      { serverId: SERVER_ID, agentId: AGENT_ID, pin: true },
      {
        ...deps,
        openDockAgent: (input) => {
          docked.push(input);
          return `/h/${input.serverId}/simulator`;
        },
      },
    );

    expect(route).toBe(`/h/${SERVER_ID}/simulator`);
    expect(docked).toEqual([
      {
        serverId: SERVER_ID,
        agentId: AGENT_ID,
        workspaceId: WORKSPACE_ID,
        owner: { kind: "simfleet", serverId: SERVER_ID },
      },
    ]);
    expect(tabNavigations).toEqual([]);
    expect(hostNavigations).toEqual([]);
  });
});
