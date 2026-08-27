import type { DaemonClient } from "@jagentdesk/client";

import type { HostRuntimeStore } from "@/runtime/host-runtime";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import { migrateHostData } from "./host-migration-service";

// ─────────────────────────────────────────────────────────────────────────────
// Recreate a broken local host (REQ 4) and carry its data across (REQ 5).
//
// A local host exhausts its retries when the built-in daemon endpoint stops
// answering. "Recreate" re-probes the SAME local endpoint the broken host used:
//
//   - Same daemon identity (same serverId): the re-probe restores the existing
//     connection. Data already lives on that daemon, so there is nothing to
//     migrate — the host is simply reconnected.
//   - A different daemon now answers the endpoint (fresh serverId): if the old
//     daemon is still reachable AND a new client is live, its data is migrated
//     onto the new daemon before the old host is dropped. In practice a live old
//     client implies the same daemon identity, so this branch is defensive; when
//     the old daemon is unreachable its data cannot be exported and the host is
//     recreated pointing at the new daemon without a data move.
//
// A probe failure (endpoint still unreachable) propagates so the caller keeps the
// old host and surfaces an error instead of silently dropping it.
// ─────────────────────────────────────────────────────────────────────────────

export type RecreateLocalHostOutcome =
  | { status: "reconnected"; serverId: string }
  | { status: "recreated"; serverId: string; migratedAgentCount: number };

export class NoLocalConnectionError extends Error {
  constructor(serverId: string) {
    super(`Host ${serverId} has no local (non-tailnet) connection to recreate.`);
    this.name = "NoLocalConnectionError";
  }
}

export interface RecreateLocalHostDeps {
  hostRuntime: Pick<
    HostRuntimeStore,
    | "getHosts"
    | "getClient"
    | "getHostLabel"
    | "remapReplicaCacheAgentIds"
    | "probeAndUpsertConnection"
    | "removeHost"
  >;
  /** Injectable for tests; defaults to the real migration orchestration. */
  migrate?: typeof migrateHostData;
}

/**
 * Return the connection a local host should be recreated from: its preferred
 * connection when that is reachable without Tailscale, else the first non-tailnet
 * connection. Pure; returns null when the host has only tailnet connections.
 */
export function findLocalConnection(host: HostProfile): HostConnection | null {
  const preferred = host.connections.find(
    (connection) => connection.id === host.preferredConnectionId,
  );
  if (preferred && preferred.type !== "tailnet") {
    return preferred;
  }
  return host.connections.find((connection) => connection.type !== "tailnet") ?? null;
}

export async function recreateLocalHost(
  oldServerId: string,
  deps: RecreateLocalHostDeps,
): Promise<RecreateLocalHostOutcome> {
  const migrate = deps.migrate ?? migrateHostData;
  const oldHost = deps.hostRuntime.getHosts().find((host) => host.serverId === oldServerId);
  if (!oldHost) {
    throw new NoLocalConnectionError(oldServerId);
  }
  const connection = findLocalConnection(oldHost);
  if (!connection) {
    throw new NoLocalConnectionError(oldServerId);
  }

  const label = oldHost.label;
  // Capture the old client BEFORE re-probing: a successful probe that resolves to
  // a new daemon identity replaces the old registry entry (connection match), so
  // the old controller — and its client — is gone afterwards.
  const sourceClient: DaemonClient | null = deps.hostRuntime.getClient(oldServerId);

  const { serverId: newServerId } = await deps.hostRuntime.probeAndUpsertConnection({
    connection,
    label,
  });

  const targetClient = deps.hostRuntime.getClient(newServerId);

  // Same daemon healed, or the new/old daemon cannot be exported: reconnected
  // without a data move. Nothing to migrate and nothing extra to remove — the
  // re-probe already reconciled the registry entry onto newServerId.
  if (newServerId === oldServerId || !sourceClient || !targetClient) {
    return { status: "reconnected", serverId: newServerId };
  }

  const result = await migrate({
    sourceServerId: oldServerId,
    targetServerId: newServerId,
    sourceClient,
    targetClient,
    sourceHostLabel: deps.hostRuntime.getHostLabel(oldServerId) ?? label,
    replicaCache: {
      remapAgentIds: (serverId, idMap) =>
        deps.hostRuntime.remapReplicaCacheAgentIds(serverId, idMap),
    },
  });

  // Migration succeeded: drop any lingering old registry entry (no-op when the
  // re-probe already merged it onto newServerId). If migration threw, this line
  // is never reached, so the old host is preserved.
  await deps.hostRuntime.removeHost(oldServerId);

  return {
    status: "recreated",
    serverId: newServerId,
    migratedAgentCount: Object.keys(result.idMap).length,
  };
}
