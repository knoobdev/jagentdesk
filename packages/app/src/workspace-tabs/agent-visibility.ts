import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { isDockAgent } from "@/utils/dock-agents";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  knownAgentIds: Set<string>;
  foreignAgentIds: Set<string>;
}

function agentBelongsToWorkspace(agent: Agent, workspaceId: string): boolean {
  return normalizeWorkspaceOpaqueId(agent.workspaceId) === workspaceId;
}

function earliestRegularAgentCreatedAt(
  agents: Map<string, Agent> | undefined,
  workspaceId: string,
): number | null {
  let earliest: number | null = null;
  for (const agent of agents?.values() ?? []) {
    if (!agentBelongsToWorkspace(agent, workspaceId) || isDockAgent(agent)) continue;
    const at = agent.createdAt.getTime();
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}

/**
 * A screen dock's chat (SimFleet / database / cluster) now gets its own workspace and shows as a
 * tab there. Older ones were filed by the daemon into another conversation's workspace (same
 * project directory); those stay out of that workspace's tabs — and a tab auto-opened for one is
 * pruned — while the chat remains reachable from its screen's dock and from History.
 */
function isMisfiledDockAgent(agent: Agent, earliestRegularAgentAt: number | null): boolean {
  if (!isDockAgent(agent)) return false;
  return earliestRegularAgentAt !== null && earliestRegularAgentAt < agent.createdAt.getTime();
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  if ((!sessionAgents && !agentDetails) || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      knownAgentIds: new Set<string>(),
      foreignAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const knownAgentIds = new Set<string>();
  const foreignAgentIds = new Set<string>();
  const earliestRegularAgentAt = earliestRegularAgentCreatedAt(sessionAgents, workspaceId);
  for (const agent of sessionAgents?.values() ?? []) {
    if (!agentBelongsToWorkspace(agent, workspaceId)) {
      if (normalizeWorkspaceOpaqueId(agent.workspaceId)) foreignAgentIds.add(agent.id);
      continue;
    }
    knownAgentIds.add(agent.id);
    if (!agent.archivedAt && !isMisfiledDockAgent(agent, earliestRegularAgentAt)) {
      activeAgentIds.add(agent.id);
      const parentAgent = agent.parentAgentId
        ? (sessionAgents?.get(agent.parentAgentId) ?? agentDetails?.get(agent.parentAgentId))
        : undefined;
      if (shouldAutoOpenBackgroundAgent(agent, parentAgent)) {
        autoOpenAgentIds.add(agent.id);
      }
    }
  }
  addHistoricalOwnership({
    sessionAgents,
    agentDetails,
    workspaceId,
    knownAgentIds,
    foreignAgentIds,
  });

  return { activeAgentIds, autoOpenAgentIds, knownAgentIds, foreignAgentIds };
}

function addHistoricalOwnership({
  sessionAgents,
  agentDetails,
  workspaceId,
  knownAgentIds,
  foreignAgentIds,
}: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails: Map<string, Agent> | undefined;
  workspaceId: string;
  knownAgentIds: Set<string>;
  foreignAgentIds: Set<string>;
}) {
  for (const agent of agentDetails?.values() ?? []) {
    if (sessionAgents?.has(agent.id)) continue;
    const ownerId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (ownerId === workspaceId) knownAgentIds.add(agent.id);
    else if (ownerId) foreignAgentIds.add(agent.id);
  }
}

interface AgentMapsSnapshot {
  sessions: Record<
    string,
    { agents: Map<string, Agent>; agentDetails: Map<string, Agent> } | undefined
  >;
}

// Session-store selectors run on every store update, including every stream tick, which
// leaves the agent maps untouched. Reuse the previous result until either map changes, and
// keep it when a recompute yields the same sets so the hook's equality check stays O(1).
export function createWorkspaceAgentVisibilitySelector(input: {
  serverId: string;
  workspaceId: string | null | undefined;
}): (state: AgentMapsSnapshot) => WorkspaceAgentVisibility {
  let previousAgents: Map<string, Agent> | undefined;
  let previousAgentDetails: Map<string, Agent> | undefined;
  let previousVisibility: WorkspaceAgentVisibility | null = null;

  return (state) => {
    const session = state.sessions[input.serverId];
    const agents = session?.agents;
    const agentDetails = session?.agentDetails;
    if (previousVisibility && agents === previousAgents && agentDetails === previousAgentDetails) {
      return previousVisibility;
    }

    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: agents,
      agentDetails,
      workspaceId: input.workspaceId,
    });
    previousAgents = agents;
    previousAgentDetails = agentDetails;
    if (!previousVisibility || !workspaceAgentVisibilityEqual(previousVisibility, visibility)) {
      previousVisibility = visibility;
    }
    return previousVisibility;
  };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    knownAgentIds: input.agentVisibility.knownAgentIds,
    foreignAgentIds: input.agentVisibility.foreignAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  if (a === b) return true;
  return (
    setsEqual(a.activeAgentIds, b.activeAgentIds) &&
    setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
    setsEqual(a.knownAgentIds, b.knownAgentIds) &&
    setsEqual(a.foreignAgentIds, b.foreignAgentIds)
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}

function shouldAutoOpenBackgroundAgent(agent: Agent, parentAgent: Agent | undefined): boolean {
  return !agent.background && isWorkspaceRootAgent(agent, parentAgent);
}
