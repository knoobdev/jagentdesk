export const PARENT_AGENT_ID_LABEL = "jagentdesk.parent-agent-id";

const OPEN_AGENT_TAB_LABEL_PREFIX = "jagentdesk.open-agent-tab.";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}

// Provenance stamp written on an agent record when it is imported via a
// host-to-host migration. Value is the source daemon's serverId. Used to build
// the "[source-host] title" display prefix and to drive reverse migration when
// the source host reconnects.
export const MIGRATED_FROM_LABEL = "jagentdesk.migrated-from";

export function getMigratedFromLabel(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const value = labels?.[MIGRATED_FROM_LABEL];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Set to "true" on a migrated agent whose provider conversation history could not
// be carried across (e.g. a cross-machine migration where the provider transcript
// is not portable). The record still exists so the agent is visible; the UI uses
// this to indicate that history is unavailable.
export const MIGRATION_HISTORY_UNAVAILABLE_LABEL = "jagentdesk.migration.history-unavailable";

export function isMigrationHistoryUnavailable(
  labels: Record<string, unknown> | null | undefined,
): boolean {
  return labels?.[MIGRATION_HISTORY_UNAVAILABLE_LABEL] === "true";
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}
