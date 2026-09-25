/**
 * Agents owned by a screen's chat dock (SimFleet, a database, a Kubernetes cluster). The daemon
 * places them in the workspace of the project they run in, but they belong to their screen: they
 * must not open as tabs in that workspace (another conversation's workspace when several share
 * the project directory), and navigating to one lands on its screen with the dock showing it.
 * Pure data — no React Native imports, so workspace-tab derivation can use it.
 */

export const SIM_AGENT_LABEL = "jagentdesk.simfleet.server";
export const DATABASE_AGENT_LABEL = "jagentdesk.database.id";
export const CLUSTER_AGENT_LABEL = "jagentdesk.cluster.id";

export type DockAgentOwner =
  | { kind: "simfleet"; serverId: string }
  | { kind: "database"; databaseId: string }
  | { kind: "cluster"; clusterId: string };

type AgentLabels = Readonly<Record<string, string>> | null | undefined;

export function resolveDockAgentOwner(labels: AgentLabels): DockAgentOwner | null {
  if (!labels) return null;
  const sim = labels[SIM_AGENT_LABEL];
  if (sim) return { kind: "simfleet", serverId: sim };
  const database = labels[DATABASE_AGENT_LABEL];
  if (database) return { kind: "database", databaseId: database };
  const cluster = labels[CLUSTER_AGENT_LABEL];
  if (cluster) return { kind: "cluster", clusterId: cluster };
  return null;
}

export function isDockAgent(agent: { labels?: AgentLabels }): boolean {
  return resolveDockAgentOwner(agent.labels) !== null;
}
