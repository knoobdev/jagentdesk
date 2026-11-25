import { useEffect, useState } from "react";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";

/**
 * Resolves an SSH server label by id through the server list the app loads from the daemon
 * (spec 33.9: look up by serverId, fall back to the raw id). One fetch per mount; ssh_run
 * results are terminal, so the label never needs to refresh.
 */
export function useSshServerLabel(client: DaemonClient | null, serverId: string): string | null {
  const [label, setLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!client || !serverId) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const res = await client.sshServersList();
        if (cancelled || res.error) return;
        const server = res.servers.find((entry) => entry.id === serverId);
        if (server) setLabel(server.label);
      } catch {
        // List read failed (reconnect, daemon restart): the card keeps the raw serverId.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, serverId]);
  return label;
}
