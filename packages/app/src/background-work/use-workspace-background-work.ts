import { useShallow } from "zustand/shallow";
import { useSessionStore } from "@/stores/session-store";
import { countRunningBackgroundWork } from "./sidebar-line";

export interface WorkspaceBackgroundWork {
  /** The agent whose task names the sidebar line; the one with the most recent update. */
  agentId: string;
  /** Running tasks across every agent of the workspace. */
  totalCount: number;
  /** No agent in the workspace has a turn running: only background work keeps it busy. */
  onlyBackground: boolean;
}

/** Background work of a workspace's agents, from the directory summaries already in the store. */
export function useWorkspaceBackgroundWork(
  serverId: string,
  workspaceId: string,
): WorkspaceBackgroundWork | null {
  const summary = useSessionStore(
    useShallow((state) => {
      const agents = state.sessions[serverId]?.agents;
      let agentId: string | null = null;
      let latest = -1;
      let totalCount = 0;
      let turnRunning = false;
      for (const agent of agents?.values() ?? []) {
        if (agent.workspaceId !== workspaceId) continue;
        if (agent.status === "running") turnRunning = true;
        const count = countRunningBackgroundWork(agent.backgroundWork);
        if (count === 0) continue;
        totalCount += count;
        const updated = agent.updatedAt.getTime();
        if (updated > latest) {
          latest = updated;
          agentId = agent.id;
        }
      }
      return { agentId, totalCount, turnRunning };
    }),
  );
  if (!summary.agentId || summary.totalCount === 0) return null;
  return {
    agentId: summary.agentId,
    totalCount: summary.totalCount,
    onlyBackground: !summary.turnRunning,
  };
}
