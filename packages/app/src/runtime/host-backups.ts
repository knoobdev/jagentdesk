import type { HostProfile } from "@/types/host-connection";

// Removed hosts are backed up here so returning to the host picker and
// re-logging in (Tailscale or Local) restores the host's saved label,
// appearance, and connections instead of losing them. Workspaces/projects are
// already keyed by serverId in the session store, so re-connecting the same
// daemon reunites them automatically — this only preserves the connection
// profile the user would otherwise have to re-add.
export const HOST_BACKUP_STORAGE_KEY = "@jagentdesk:host-backups:v1";

export function parseHostBackups(raw: string | null): HostProfile[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (entry): entry is HostProfile =>
        !!entry && typeof entry.serverId === "string" && Array.isArray(entry.connections),
    );
  } catch {
    return [];
  }
}

export function serializeHostBackups(backups: HostProfile[]): string {
  return JSON.stringify(backups);
}

/** Remember a removed host, deduped by serverId (newest wins). */
export function addHostBackup(backups: HostProfile[], removed: HostProfile): HostProfile[] {
  return [...backups.filter((entry) => entry.serverId !== removed.serverId), removed];
}

/** Pop the backup for a serverId, if any. */
export function takeHostBackup(
  backups: HostProfile[],
  serverId: string,
): { backup: HostProfile | null; remaining: HostProfile[] } {
  const backup = backups.find((entry) => entry.serverId === serverId) ?? null;
  if (!backup) return { backup: null, remaining: backups };
  return { backup, remaining: backups.filter((entry) => entry.serverId !== serverId) };
}

/**
 * Merge a freshly re-connected host with its backed-up profile: keep the fresh
 * connection(s), re-add backed-up connections the fresh one lacks, and restore
 * the user's saved label / appearance and original creation time.
 */
export function restoreHostProfile(fresh: HostProfile, backup: HostProfile): HostProfile {
  const freshConnectionIds = new Set(fresh.connections.map((connection) => connection.id));
  const restoredConnections = [
    ...fresh.connections,
    ...backup.connections.filter((connection) => !freshConnectionIds.has(connection.id)),
  ];
  return {
    ...fresh,
    label: backup.label?.trim() ? backup.label : fresh.label,
    appearance: backup.appearance ?? fresh.appearance,
    connections: restoredConnections,
    preferredConnectionId: fresh.preferredConnectionId ?? backup.preferredConnectionId,
    createdAt: backup.createdAt ?? fresh.createdAt,
    updatedAt: fresh.updatedAt,
  };
}
