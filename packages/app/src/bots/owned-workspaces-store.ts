// Workspaces a bot owns leave the Projects tree and show under the bot (spec 37.3.2 item 3, 37.4.11):
// those handed to it (`bot.handedWorkspaces`, the chat tree's `workspaces`) and its workers'
// worktrees (the workspace each worker agent runs in). The Bots section publishes them per bot; the
// sidebar's workspace list hides them like background workspaces.
import { create } from "zustand";

interface BotOwned {
  workspaceIds: readonly string[];
  workerAgentIds: readonly string[];
  /** The bot's home folder: its Home Chat runs there, so the host lists it as a project. */
  home?: string;
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
        sameList(previous.workerAgentIds, owned.workerAgentIds) &&
        previous.home === owned.home
      )
        return state;
      return { byBot: { ...state.byBot, [key]: owned } };
    }),
}));

/** `path` is `home` or inside it. */
export function isInBotHome(path: string, home: string): boolean {
  const root = home.replace(/[\\/]+$/, "");
  return path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
}

/**
 * `<serverId>:<workspaceId>` of every workspace the bots own: handed ones, the ones their worker
 * agents run in (`agentWorkspace`), and any workspace inside a bot home (`workspaces`).
 */
export function botOwnedWorkspaceKeys(
  byBot: Record<string, BotOwned>,
  agentWorkspace: (serverId: string, agentId: string) => string | undefined,
  workspaces: (serverId: string) => Iterable<{ id: string; workspaceDirectory: string }> = () => [],
): Set<string> {
  const keys = new Set<string>();
  for (const [key, owned] of Object.entries(byBot)) {
    const serverId = key.slice(0, key.lastIndexOf(":"));
    for (const workspaceId of owned.workspaceIds) keys.add(`${serverId}:${workspaceId}`);
    for (const agentId of owned.workerAgentIds) {
      const workspaceId = agentWorkspace(serverId, agentId);
      if (workspaceId) keys.add(`${serverId}:${workspaceId}`);
    }
    if (owned.home)
      for (const workspace of workspaces(serverId))
        if (isInBotHome(workspace.workspaceDirectory, owned.home))
          keys.add(`${serverId}:${workspace.id}`);
  }
  return keys;
}
