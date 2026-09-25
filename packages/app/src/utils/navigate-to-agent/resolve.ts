import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import type { DockAgentOwner } from "@/utils/dock-agents";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Used as the workspace target when the agent is not yet in the session store
  // (cold deep-links). Otherwise the workspace is read from the store.
  workspaceId?: string | null;
  pin?: boolean;
}

export interface AgentNavTarget {
  agentWorkspaceId: string | null | undefined;
  /** Set when the agent belongs to a screen's chat dock rather than a workspace tab. */
  dockOwner?: DockAgentOwner | null;
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
  openDockAgent?: (input: {
    serverId: string;
    agentId: string;
    workspaceId: string | null;
    owner: DockAgentOwner;
  }) => string;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const target = deps.readAgentNavTarget({ serverId: input.serverId, agentId: input.agentId });
  const agentWorkspaceId = input.workspaceId ?? target.agentWorkspaceId;
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (target.dockOwner && deps.openDockAgent) {
    return deps.openDockAgent({
      serverId: input.serverId,
      agentId: input.agentId,
      workspaceId: workspaceId ?? null,
      owner: target.dockOwner,
    });
  }

  if (!workspaceId) {
    const route = buildHostAgentDetailRoute(input.serverId, input.agentId);
    deps.navigateToHostAgent(route);
    return route;
  }

  return deps.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    pin: input.pin,
  });
}
