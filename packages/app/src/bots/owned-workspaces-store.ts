// Workspaces a bot owns leave the Projects tree and show under the bot (spec 37.3.2 item 3, 37.4.11):
// those handed to it (`bot.handedWorkspaces`, the chat tree's `workspaces`) and its workers'
// worktrees (the workspace each worker agent runs in). The Bots section publishes them per bot; the
// sidebar's workspace list hides them like background workspaces.
import { create } from "zustand";

interface BotOwned {
  workspaceIds: readonly string[];
  workerAgentIds: readonly string[];
}

interface OwnedWorkspacesState {
  /** `<serverId>:<botId>` → what that bot owns. */
  byBot: Record<string, BotOwned>;
  publish: (serverId: string, botId: string, owned: BotOwned | null) => void;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export const useBotOwnedWorkspaces = create<OwnedWorkspacesState>()((set) => ({
  byBot: {},
  publish: (serverId, botId, owned) =>
    set((state) => {
      const key = `${serverId}:${botId}`;
      const previous = state.byBot[key];
      if (!owned) {
        if (!previous) return state;
        const { [key]: _removed, ...rest } = state.byBot;
        return { byBot: rest };
      }
      if (
        previous &&
        sameList(previous.workspaceIds, owned.workspaceIds) &&
        sameList(previous.workerAgentIds, owned.workerAgentIds)
      )
        return state;
      return { byBot: { ...state.byBot, [key]: owned } };
    }),
}));

/** `<serverId>:<workspaceId>` of every workspace the bots own; worker agents resolve through `agentWorkspace`. */
export function botOwnedWorkspaceKeys(
  byBot: Record<string, BotOwned>,
  agentWorkspace: (serverId: string, agentId: string) => string | undefined,
): Set<string> {
  const keys = new Set<string>();
  for (const [key, owned] of Object.entries(byBot)) {
    const serverId = key.slice(0, key.lastIndexOf(":"));
    for (const workspaceId of owned.workspaceIds) keys.add(`${serverId}:${workspaceId}`);
    for (const agentId of owned.workerAgentIds) {
      const workspaceId = agentWorkspace(serverId, agentId);
      if (workspaceId) keys.add(`${serverId}:${workspaceId}`);
    }
  }
  return keys;
}
