import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { getTailscaleLoginAdapter } from "./adapter";

// ---------------------------------------------------------------------------
// Foreground tsnet revive (spec 05.7.4, "Hồi phục tầng tsnet khi lên
// foreground").
//
// When the app is suspended, iOS can reclaim its sockets: the bridge's
// loopback listener and the embedded tsnet node's own sockets die silently.
// On every foreground the app asks the native bridge to revive (re-open the
// loopback port, re-dial the daemon, restart the tsnet node from saved state
// when needed). Because a DaemonClient keeps the URL it was built with, a
// revived host whose loopback port changed gets its client rebuilt through
// the normal host-runtime connection switch.
// ---------------------------------------------------------------------------

/** Structural view of HostRuntimeStore so tests can pass fakes. */
export interface TailnetReviveStore {
  getHosts(): Array<{ serverId: string; connections: HostConnectionLike[] }>;
  getSnapshot(serverId: string): { activeConnectionId: string | null } | null;
  getClient(serverId: string): { url: string } | null;
  rebuildTailnetClient(serverId: string, connectionId: string): Promise<void>;
}

interface HostConnectionLike {
  id: string;
  type: string;
  tailnetAddress?: string;
  useTls?: boolean;
}

export async function reviveTailnetHosts(store: TailnetReviveStore): Promise<void> {
  const adapter = getTailscaleLoginAdapter();
  if (!adapter.revive) {
    // Web/desktop have no embedded tsnet node to revive.
    return;
  }
  for (const host of store.getHosts()) {
    const activeConnectionId = store.getSnapshot(host.serverId)?.activeConnectionId ?? null;
    const connection = host.connections.find(
      (candidate) => candidate.type === "tailnet" && candidate.id === activeConnectionId,
    );
    if (!connection?.tailnetAddress) {
      continue;
    }
    let address: string | null = null;
    try {
      address = await adapter.revive(connection.tailnetAddress);
    } catch {
      // A failed revive leaves recovery to the normal retry loop (05.7.4):
      // keep ensureConnectedAll/revalidateConnectedAll running as before.
      continue;
    }
    if (!address) {
      continue;
    }
    const client = store.getClient(host.serverId);
    if (!client || clientUsesAddress(client.url, address, connection.useTls ?? false)) {
      continue;
    }
    try {
      await store.rebuildTailnetClient(host.serverId, connection.id);
    } catch {
      // The rebuilt client reports its own connect failure through the
      // connection state machine; the retry loop keeps going.
    }
  }
}

/** True when the client's WebSocket URL already points at the given address. */
export function clientUsesAddress(clientUrl: string, address: string, useTls: boolean): boolean {
  return clientUrl === buildDaemonWebSocketUrl(address, { useTls });
}
