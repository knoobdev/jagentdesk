import type { DaemonClientConfig } from "@jagentdesk/client/internal/daemon-client";
import type { DirectTcpHostConnection } from "@/types/host-connection";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { getRelayDeviceSigning } from "@/utils/relay-device-signing";
import { isDesktopSignedLocalHost } from "@/runtime/desktop-signed-local-hosts";

export type DirectTcpClientConfig = Pick<
  DaemonClientConfig,
  "url" | "password" | "expectChallenge" | "deviceSigning"
>;

/**
 * URL and auth for a direct TCP connection. Both the runtime client and the
 * probe client (which the runtime adopts once it wins) are built here, so the
 * hello is the same on either path.
 *
 * The desktop's own bundled daemon paired the desktop device key at bootstrap,
 * so its Local hello is signed too (ADR-0010); `paired=1` asks the daemon for
 * the challenge. Any other loopback or LAN daemon keeps the plain hello.
 */
export function directTcpClientConfig(input: {
  serverId: string | null | undefined;
  connection: DirectTcpHostConnection;
}): DirectTcpClientConfig {
  const { connection } = input;
  const url = buildDaemonWebSocketUrl(connection.endpoint, {
    useTls: connection.useTls ?? false,
  });
  const localSigning =
    input.serverId && isDesktopSignedLocalHost(input.serverId) ? getRelayDeviceSigning() : null;
  if (localSigning) {
    return {
      url: `${url}${url.includes("?") ? "&" : "?"}paired=1`,
      expectChallenge: true,
      deviceSigning: localSigning,
    };
  }
  return { url, ...(connection.password ? { password: connection.password } : {}) };
}
