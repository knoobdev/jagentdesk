import { hostname } from "node:os";

import type { Logger } from "pino";
import {
  HOST_DATA_BUNDLE_VERSION,
  HostDataBundleSchema,
  type HostDataBundle,
  type HostDataBundleAgentEntry,
  type HistoryBlob,
} from "@jagentdesk/protocol/migration/host-data-bundle";

import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ProjectRegistry, WorkspaceRegistry } from "../workspace-registry.js";
import { captureProviderHistory, currentSourceHome } from "./provider-history.js";

export interface ExportHostDataInput {
  serverId: string;
  agentStorage: Pick<AgentStorage, "list">;
  workspaceRegistry: Pick<WorkspaceRegistry, "list">;
  projectRegistry: Pick<ProjectRegistry, "list">;
  logger: Logger;
  /** Restrict to these agent ids; omit for the whole daemon. */
  agentIds?: string[];
}

/**
 * Serialize this daemon's agents (whole daemon, or a subset) into a portable
 * `HostDataBundle`. Records, project rows, and workspace rows always travel;
 * provider conversation history is captured best-effort (see provider-history).
 */
export async function exportHostData(input: ExportHostDataInput): Promise<HostDataBundle> {
  const { serverId, agentStorage, workspaceRegistry, projectRegistry, logger } = input;
  const wanted = input.agentIds ? new Set(input.agentIds) : null;

  const allRecords = await agentStorage.list();
  const records = allRecords.filter((record) => {
    if (wanted) {
      return wanted.has(record.id);
    }
    // Default export: user-visible, live agents only.
    return !record.internal && !record.archivedAt;
  });

  const historyBlobs: Record<string, HistoryBlob> = {};
  const agents: HostDataBundleAgentEntry[] = [];

  for (const record of records) {
    const entry = await buildAgentEntry(record, logger);
    if (entry.blob && entry.historyBlobRef) {
      historyBlobs[entry.historyBlobRef] = entry.blob;
    }
    agents.push(entry.agent);
  }

  const referencedWorkspaceIds = new Set(
    records.map((record) => record.workspaceId).filter((id): id is string => Boolean(id)),
  );
  const allWorkspaces = await workspaceRegistry.list();
  const workspaces = allWorkspaces.filter((workspace) =>
    referencedWorkspaceIds.has(workspace.workspaceId),
  );

  const referencedProjectIds = new Set(workspaces.map((workspace) => workspace.projectId));
  const allProjects = await projectRegistry.list();
  const projects = allProjects.filter((project) => referencedProjectIds.has(project.projectId));

  const bundle: HostDataBundle = {
    version: HOST_DATA_BUNDLE_VERSION,
    sourceServerId: serverId,
    sourceHostLabel: hostname() || null,
    sourceHome: currentSourceHome(),
    exportedAt_ms: Date.now(),
    projects: projects.map((project) => project as unknown as Record<string, unknown>),
    workspaces: workspaces.map((workspace) => workspace as unknown as Record<string, unknown>),
    agents,
    historyBlobs,
  };

  // Validate the wire shape before it leaves the daemon.
  return HostDataBundleSchema.parse(bundle);
}

async function buildAgentEntry(
  record: StoredAgentRecord,
  logger: Logger,
): Promise<{
  agent: HostDataBundleAgentEntry;
  blob: HistoryBlob | null;
  historyBlobRef: string | null;
}> {
  const provider = record.provider;
  const sessionId = record.persistence?.sessionId ?? null;

  let blob: HistoryBlob | null = null;
  if (sessionId) {
    blob = await captureProviderHistory({
      provider,
      cwd: record.cwd,
      sessionId,
      logger,
    });
  }

  const historyBlobRef = blob ? `hist_${record.id}` : null;
  const agent: HostDataBundleAgentEntry = {
    oldAgentId: record.id,
    provider,
    record: record as unknown as Record<string, unknown>,
    usageTotals: record.usageTotals ?? null,
    historyPortable: blob !== null,
    historyBlobRef,
  };
  return { agent, blob, historyBlobRef };
}
