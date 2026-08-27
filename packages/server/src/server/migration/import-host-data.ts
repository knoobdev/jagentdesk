import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import {
  HostDataBundleSchema,
  type HostDataBundle,
  type HostDataImportAgentOutcome,
  type HostDataImportResult,
} from "@jagentdesk/protocol/migration/host-data-bundle";
import {
  MIGRATED_FROM_LABEL,
  MIGRATION_HISTORY_UNAVAILABLE_LABEL,
} from "@jagentdesk/protocol/agent-labels";

import {
  parseStoredAgentRecord,
  type AgentStorage,
  type StoredAgentRecord,
} from "../agent/agent-storage.js";
import type {
  PersistedProjectRecord,
  PersistedWorkspaceRecord,
  ProjectRegistry,
  WorkspaceRegistry,
} from "../workspace-registry.js";
import { materializeProviderHistory } from "./provider-history.js";

export interface ImportHostDataInput {
  targetServerId: string;
  bundle: HostDataBundle;
  agentStorage: Pick<AgentStorage, "upsert">;
  workspaceRegistry: Pick<WorkspaceRegistry, "upsert" | "get">;
  projectRegistry: Pick<ProjectRegistry, "upsert" | "get">;
  logger: Logger;
  /** Override for the id factory (tests). Defaults to randomUUID. */
  newAgentId?: () => string;
}

/**
 * Recreate a `HostDataBundle` on THIS (target) daemon: project + workspace rows,
 * and a fresh stored record per agent (new agentId, provenance stamped). Provider
 * history is materialized only when portable to this machine (see
 * provider-history); otherwise the agent is created and flagged so the UI can
 * show history is unavailable — we never fake a successful history transfer.
 */
export async function importHostData(input: ImportHostDataInput): Promise<HostDataImportResult> {
  const bundle = HostDataBundleSchema.parse(input.bundle);
  const { targetServerId, agentStorage, workspaceRegistry, projectRegistry, logger } = input;
  const mintId = input.newAgentId ?? (() => randomUUID());

  // 1. Projects — keep ids (unique per machine; collisions are astronomically
  //    unlikely and an upsert is idempotent).
  let importedProjectCount = 0;
  for (const raw of bundle.projects) {
    try {
      await projectRegistry.upsert(raw as unknown as PersistedProjectRecord);
      importedProjectCount += 1;
    } catch (error) {
      logger.warn({ err: error }, "Skipping unparseable project row during import");
    }
  }

  // 2. Workspaces — keep ids. workspaceIdMap is identity today but returned so the
  //    client can re-key uniformly and so future id remaps have a seam.
  const workspaceIdMap: Record<string, string> = {};
  let importedWorkspaceCount = 0;
  for (const raw of bundle.workspaces) {
    try {
      const workspace = raw as unknown as PersistedWorkspaceRecord;
      await workspaceRegistry.upsert(workspace);
      workspaceIdMap[workspace.workspaceId] = workspace.workspaceId;
      importedWorkspaceCount += 1;
    } catch (error) {
      logger.warn({ err: error }, "Skipping unparseable workspace row during import");
    }
  }

  // 3. Agents — new id, provenance stamp, best-effort history materialization.
  const idMap: Record<string, string> = {};
  const outcomes: HostDataImportAgentOutcome[] = [];
  let historyMaterializedCount = 0;
  let historyUnavailableCount = 0;

  for (const entry of bundle.agents) {
    let record: StoredAgentRecord;
    try {
      record = parseStoredAgentRecord(entry.record);
    } catch (error) {
      logger.warn(
        { err: error, oldAgentId: entry.oldAgentId },
        "Skipping unparseable agent record during import",
      );
      continue;
    }

    const newAgentId = mintId();
    const nowIso = new Date().toISOString();

    let historyMaterialized = false;
    if (entry.historyPortable && entry.historyBlobRef) {
      const blob = bundle.historyBlobs[entry.historyBlobRef];
      if (blob) {
        const result = await materializeProviderHistory({
          blob,
          targetCwd: record.cwd,
          sourceHome: bundle.sourceHome,
          logger,
        });
        historyMaterialized = result.ok;
      }
    }

    // Flag history-unavailable only when the source HAD history we could not carry
    // across (the honest cross-machine seam) — not when there was none to begin with.
    const historyLost = entry.historyPortable && !historyMaterialized;
    if (historyMaterialized) {
      historyMaterializedCount += 1;
    } else if (historyLost) {
      historyUnavailableCount += 1;
    }

    const labels: Record<string, string> = {
      ...record.labels,
      [MIGRATED_FROM_LABEL]: bundle.sourceServerId,
    };
    if (historyLost) {
      labels[MIGRATION_HISTORY_UNAVAILABLE_LABEL] = "true";
    } else {
      delete labels[MIGRATION_HISTORY_UNAVAILABLE_LABEL];
    }

    const importedRecord: StoredAgentRecord = {
      ...record,
      id: newAgentId,
      labels,
      updatedAt: nowIso,
      // A migrated agent starts idle; it is (re)hydrated on demand via resume.
      lastStatus: "closed",
      archivedAt: null,
    };

    try {
      await agentStorage.upsert(importedRecord);
    } catch (error) {
      logger.error(
        { err: error, oldAgentId: entry.oldAgentId, newAgentId },
        "Failed to write imported agent record",
      );
      continue;
    }

    idMap[entry.oldAgentId] = newAgentId;
    outcomes.push({ oldAgentId: entry.oldAgentId, newAgentId, historyMaterialized });
  }

  return {
    sourceServerId: bundle.sourceServerId,
    targetServerId,
    sourceHostLabel: bundle.sourceHostLabel,
    idMap,
    workspaceIdMap,
    agents: outcomes,
    importedAgentCount: outcomes.length,
    importedProjectCount,
    importedWorkspaceCount,
    historyMaterializedCount,
    historyUnavailableCount,
  };
}
