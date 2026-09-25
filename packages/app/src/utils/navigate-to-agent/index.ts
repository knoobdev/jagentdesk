import { router, type Href } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useClusterChatStore } from "@/stores/cluster-chat-store";
import { useDatabaseChatStore } from "@/stores/database-chat-store";
import { useSimChatStore } from "@/stores/sim-chat-store";
import { resolveDockAgentOwner } from "@/utils/dock-agents";
import {
  buildClusterWorkloadsRoute,
  buildDatabaseBrowseRoute,
  buildSimulatorRoute,
} from "@/utils/host-routes";
import { resolveNavigateToAgent, type NavigateToAgentInput } from "./resolve";

export type { NavigateToAgentInput } from "./resolve";

export function navigateToAgent(input: NavigateToAgentInput): string {
  return resolveNavigateToAgent(input, {
    readAgentNavTarget: ({ serverId, agentId }) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return {
        agentWorkspaceId: agent?.workspaceId,
        dockOwner: resolveDockAgentOwner(agent?.labels),
      };
    },
    // Open the conversation in its screen's dock. The dock stores' reset-on-open only fires for
    // a different owner id, so selecting the agent first survives the screen mounting.
    openDockAgent: ({ serverId, agentId, workspaceId, owner }) => {
      let route: string;
      if (owner.kind === "simfleet") {
        useSimChatStore.getState().openChat({ serverId: owner.serverId, agentId, workspaceId });
        route = buildSimulatorRoute(owner.serverId);
      } else if (owner.kind === "database") {
        useDatabaseChatStore
          .getState()
          .openChat({ databaseId: owner.databaseId, agentId, workspaceId });
        route = buildDatabaseBrowseRoute(serverId, owner.databaseId);
      } else {
        useClusterChatStore
          .getState()
          .openChat({ clusterId: owner.clusterId, agentId, workspaceId });
        route = buildClusterWorkloadsRoute(serverId, owner.clusterId);
      }
      router.navigate(route as Href);
      return route;
    },
    navigateToHostAgent: (route) => {
      router.navigate(route as Href);
    },
    navigateToWorkspace,
  });
}
