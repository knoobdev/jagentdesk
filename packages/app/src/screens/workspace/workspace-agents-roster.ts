import { ORCHESTRATION_ROLE_LABEL } from "@jagentdesk/protocol/orchestration";
import type { Agent } from "@/stores/session-store";

export interface WorkspaceAgentsRosterEntry {
  agent: Agent;
  role: string;
  /**
   * The Supervisor lives in another workspace: a bot's chat that started this workspace's Lead
   * (spec 37.4.2, "Workspace của worker trên điện thoại"). It opens wherever it lives.
   */
  external: boolean;
}

const ROLE_ORDER: Record<string, number> = { supervisor: 0, lead: 1, peer: 2 };

/**
 * The ORC agents of a workspace (Supervisor → Lead → Peer). A bot worker's Lead runs in its own
 * worktree while the bot chat that dispatched it stays in the bot's home, so that chat joins the
 * roster as the Supervisor.
 */
export function buildWorkspaceAgentsRoster(input: {
  agents: Iterable<Agent>;
  workspaceId: string;
  lookup: (agentId: string) => Agent | undefined;
}): WorkspaceAgentsRosterEntry[] {
  const members: WorkspaceAgentsRosterEntry[] = [];
  for (const agent of input.agents) {
    const role = agent.labels[ORCHESTRATION_ROLE_LABEL];
    if (agent.workspaceId === input.workspaceId && role) {
      members.push({ agent, role, external: false });
    }
  }
  const entries = [...members];
  if (!members.some((entry) => entry.role === "supervisor")) {
    const memberIds = new Set(members.map((entry) => entry.agent.id));
    const added = new Set<string>();
    for (const entry of members) {
      const parentId = entry.role === "lead" ? entry.agent.parentAgentId : null;
      if (!parentId || memberIds.has(parentId) || added.has(parentId)) continue;
      const parent = input.lookup(parentId);
      if (!parent || parent.archivedAt) continue;
      added.add(parentId);
      entries.push({ agent: parent, role: "supervisor", external: true });
    }
  }
  return entries.sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
}
