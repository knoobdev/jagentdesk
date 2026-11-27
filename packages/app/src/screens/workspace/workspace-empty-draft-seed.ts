export interface EmptyWorkspaceDraftSeedInput {
  workspaceKey: string;
  /** The workspace this screen last seeded a draft for while it had no tabs; null once it had one. */
  seededWorkspaceKey: string | null;
  isRouteFocused: boolean;
  hasPersistenceKey: boolean;
  hasWorkspaceDirectory: boolean;
  hasHydratedWorkspaceLayoutStore: boolean;
  hasHydratedAgents: boolean;
  hasLoadedTerminals: boolean;
  activeAgentCount: number;
  terminalCount: number;
  /** Tabs in every pane of the workspace, not only the focused one. */
  tabCount: number;
}

export interface EmptyWorkspaceDraftSeedDecision {
  seed: boolean;
  seededWorkspaceKey: string | null;
}

/**
 * An empty workspace gets one draft tab. The screen re-arms only after the workspace has shown a
 * tab again, so a hydration or focus flag that flickers while the workspace is still empty cannot
 * seed a second draft.
 */
export function resolveEmptyWorkspaceDraftSeed(
  input: EmptyWorkspaceDraftSeedInput,
): EmptyWorkspaceDraftSeedDecision {
  if (input.tabCount > 0) {
    return { seed: false, seededWorkspaceKey: null };
  }
  const isReady =
    input.isRouteFocused &&
    input.hasPersistenceKey &&
    input.hasWorkspaceDirectory &&
    input.hasHydratedWorkspaceLayoutStore &&
    input.hasHydratedAgents &&
    input.hasLoadedTerminals;
  const isEmpty = input.activeAgentCount === 0 && input.terminalCount === 0;
  if (!isReady || !isEmpty || input.seededWorkspaceKey === input.workspaceKey) {
    return { seed: false, seededWorkspaceKey: input.seededWorkspaceKey };
  }
  return { seed: true, seededWorkspaceKey: input.workspaceKey };
}
