import type { DaemonClient } from "@jagentdesk/client";

import type { HostRuntimeStore } from "@/runtime/host-runtime";
import { useMigrationProvenanceStore } from "./migration-provenance-store";
import { reverseMigrateHostData } from "./host-migration-service";

export interface ReverseMigrationConfirmInput {
  sourceServerId: string;
  currentServerId: string;
  agentCount: number;
  sourceHostLabel: string | null;
}

export interface ReverseMigrationHandlerDeps {
  hostRuntime: Pick<HostRuntimeStore, "getClient" | "getHostLabel" | "remapReplicaCacheAgentIds">;
  /** Ask the user whether to migrate data back to the reconnected source host. */
  confirm: (input: ReverseMigrationConfirmInput) => Promise<boolean>;
  onError?: (error: unknown, context: { sourceServerId: string }) => void;
}

/**
 * Build a listener for `HostRuntimeStore.subscribeSourceHostReconnect`. When a host
 * that was previously a migration source comes back online, and its migrated-away
 * agents still live on a currently-online target host, it offers (via `confirm`)
 * to migrate them back and clears the "away" provenance prefix on success.
 */
export function createSourceHostReconnectHandler(
  deps: ReverseMigrationHandlerDeps,
): (reconnectedServerId: string) => void {
  // Guard against overlapping runs for the same source while a confirm is pending.
  const inFlight = new Set<string>();

  return (reconnectedServerId: string): void => {
    if (inFlight.has(reconnectedServerId)) {
      return;
    }

    const provenance = useMigrationProvenanceStore.getState();
    // Find target hosts whose migrated agents originated from the reconnected host.
    const targets = Object.entries(provenance.sourceServerByTarget)
      .filter(([, sourceServerId]) => sourceServerId === reconnectedServerId)
      .map(([targetServerId]) => targetServerId);
    if (targets.length === 0) {
      return;
    }

    const sourceClient = deps.hostRuntime.getClient(reconnectedServerId);
    if (!sourceClient) {
      return;
    }

    inFlight.add(reconnectedServerId);
    void runReverseMigrations({
      deps,
      reconnectedServerId,
      sourceClient,
      targets,
    }).finally(() => {
      inFlight.delete(reconnectedServerId);
    });
  };
}

async function runReverseMigrations(input: {
  deps: ReverseMigrationHandlerDeps;
  reconnectedServerId: string;
  sourceClient: DaemonClient;
  targets: string[];
}): Promise<void> {
  const { deps, reconnectedServerId, sourceClient, targets } = input;
  const provenance = useMigrationProvenanceStore.getState();

  for (const targetServerId of targets) {
    const migratedAgentIds = provenance.getMigratedAgentIds(targetServerId);
    if (migratedAgentIds.length === 0) {
      provenance.clearServer(targetServerId);
      continue;
    }
    const targetClient = deps.hostRuntime.getClient(targetServerId);
    if (!targetClient) {
      // Target is offline; nothing to move right now. Leave provenance intact so we
      // can try again the next time both hosts are online.
      continue;
    }

    const sourceHostLabel = deps.hostRuntime.getHostLabel(reconnectedServerId);
    const confirmed = await deps.confirm({
      sourceServerId: reconnectedServerId,
      currentServerId: targetServerId,
      agentCount: migratedAgentIds.length,
      sourceHostLabel,
    });
    if (!confirmed) {
      continue;
    }

    try {
      await reverseMigrateHostData({
        currentServerId: targetServerId,
        sourceServerId: reconnectedServerId,
        currentClient: targetClient,
        sourceClient,
        migratedAgentIds,
        sourceHostLabel,
        replicaCache: {
          remapAgentIds: (serverId, idMap) =>
            deps.hostRuntime.remapReplicaCacheAgentIds(serverId, idMap),
        },
      });
    } catch (error) {
      deps.onError?.(error, { sourceServerId: reconnectedServerId });
    }
  }
}
