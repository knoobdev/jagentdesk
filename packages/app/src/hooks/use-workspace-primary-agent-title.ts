import { useSessionStore } from "@/stores/session-store";

/**
 * Title of a workspace's active (root) chat, or null. Used to give untitled
 * workspaces a distinct sidebar label — several local checkouts on the same
 * branch otherwise all render as the bare branch name (e.g. "main"). Reuses the
 * per-workspace root-agent index the sidebar already maintains.
 */
export function useWorkspacePrimaryAgentTitle(
  serverId: string,
  workspaceId: string,
): string | null {
  return useSessionStore((state) => {
    const session = state.sessions[serverId];
    if (!session) {
      return null;
    }
    const activity = session.workspaceAgentActivity.get(workspaceId);
    if (!activity) {
      return null;
    }
    const agent = session.agents.get(activity.agentId);
    const title = agent?.title?.trim();
    return title && title.length > 0 ? title : null;
  });
}
