import type { DaemonClient } from "@jagentdesk/client";
import type {
  HostDataBundle,
  HostDataImportResult,
} from "@jagentdesk/protocol/migration/host-data-bundle";

import { useSessionStore } from "@/stores/session-store";
import { useDraftStore } from "@/stores/draft-store";
import { useMigrationProvenanceStore } from "./migration-provenance-store";

// ─────────────────────────────────────────────────────────────────────────────
// Host-to-host migration orchestration (client side).
//
// The daemon owns agent records / workspaces / projects and (best-effort)
// provider history — see the server `export_host_data` / `import_host_data` RPCs.
// After the target daemon has imported a bundle, the authoritative agent state
// arrives on the target host via directory sync. What the client must re-key
// itself is the state the daemon does NOT own:
//
//   - DRAFTS (unsent composer text), keyed by serverId + agentId.
//   - PROVENANCE (source-host display prefix + reverse-migration bookkeeping).
//
// It also defensively re-keys any cached/session snapshot the client already
// holds for the target host (safe no-op when the target session has not yet been
// populated). Provider conversation history portability across machines is a
// server-side seam (records travel, cross-machine history does not).
// ─────────────────────────────────────────────────────────────────────────────

export interface ReplicaCacheAgentRemap {
  remapAgentIds(serverId: string, idMap: Record<string, string>): void;
}

export interface MigrateHostDataInput {
  /** serverId of the source host the data is moving FROM. */
  sourceServerId: string;
  /** serverId of the target host the data is moving TO. */
  targetServerId: string;
  /** Connected client for the source host (exports the bundle). */
  sourceClient: DaemonClient;
  /** Connected client for the target host (imports the bundle). */
  targetClient: DaemonClient;
  /** Human label of the source host used for the display prefix. */
  sourceHostLabel: string | null;
  /** Restrict to these source agent ids; omit for the whole daemon. */
  agentIds?: string[];
  /** Replica cache to re-key (typically the host runtime's). */
  replicaCache?: ReplicaCacheAgentRemap;
}

/**
 * Move a host's data to another daemon: export from the source, import into the
 * target, then re-key client-side state (drafts, provenance, cached snapshots).
 * Returns the daemon-side import result (idMap + provenance + counts).
 */
export async function migrateHostData(input: MigrateHostDataInput): Promise<HostDataImportResult> {
  const bundle = await input.sourceClient.exportHostData(
    input.agentIds ? { agentIds: input.agentIds } : undefined,
  );

  // The client knows the human label of the source host; stamp it onto the
  // bundle so the target's provenance record and reverse migration can use it.
  const labeledBundle: HostDataBundle = input.sourceHostLabel
    ? { ...bundle, sourceHostLabel: input.sourceHostLabel }
    : bundle;

  const result = await input.targetClient.importHostData(labeledBundle);

  applyMigrationRekey({
    sourceServerId: input.sourceServerId,
    targetServerId: input.targetServerId,
    sourceHostLabel: input.sourceHostLabel ?? result.sourceHostLabel,
    idMap: result.idMap,
    replicaCache: input.replicaCache,
  });

  return result;
}

/**
 * Reverse a prior migration when the source host reconnects: export the migrated
 * agents (plus anything created on them since) from the CURRENT host and import
 * them back into the reconnected source, then clear their provenance so they no
 * longer show the "away" prefix (they are home).
 */
export async function reverseMigrateHostData(input: {
  /** The host the agents currently live on (previously the migration target). */
  currentServerId: string;
  /** The reconnected source host they should return to. */
  sourceServerId: string;
  currentClient: DaemonClient;
  sourceClient: DaemonClient;
  /** New agent ids on the current host that were migrated from the source. */
  migratedAgentIds: string[];
  sourceHostLabel: string | null;
  replicaCache?: ReplicaCacheAgentRemap;
}): Promise<HostDataImportResult> {
  const bundle = await input.currentClient.exportHostData({
    agentIds: input.migratedAgentIds,
  });
  const result = await input.sourceClient.importHostData(bundle);

  // The agents are home now: drop the provenance prefix for the ones we sent back.
  useMigrationProvenanceStore.getState().clearAgents(input.currentServerId, input.migratedAgentIds);

  // Fold drafts/cached snapshots back onto the source host under its new ids.
  applyMigrationRekey({
    sourceServerId: input.currentServerId,
    targetServerId: input.sourceServerId,
    // Home again — do not re-stamp a source prefix.
    sourceHostLabel: null,
    idMap: result.idMap,
    replicaCache: input.replicaCache,
    recordProvenance: false,
  });

  return result;
}

interface ApplyMigrationRekeyInput {
  sourceServerId: string;
  targetServerId: string;
  sourceHostLabel: string | null;
  idMap: Record<string, string>;
  replicaCache?: ReplicaCacheAgentRemap;
  recordProvenance?: boolean;
}

function applyMigrationRekey(input: ApplyMigrationRekeyInput): void {
  if (input.recordProvenance !== false) {
    useMigrationProvenanceStore.getState().recordMigration({
      newServerId: input.targetServerId,
      sourceServerId: input.sourceServerId,
      sourceHostLabel: input.sourceHostLabel,
      idMap: input.idMap,
    });
  }

  // Drafts are host+agent scoped and daemon-agnostic: move them from the source
  // host onto the target host under the new agent ids.
  useDraftStore.getState().remapServerDrafts({
    oldServerId: input.sourceServerId,
    newServerId: input.targetServerId,
    idMap: input.idMap,
  });

  // Defensive: re-key any snapshot the client already holds for the target host.
  // Authoritative agent state arrives from the target daemon's directory sync;
  // these are no-ops when the target session/cache has no matching old ids.
  useSessionStore.getState().remapAgentIds(input.targetServerId, input.idMap);
  input.replicaCache?.remapAgentIds(input.targetServerId, input.idMap);
}
