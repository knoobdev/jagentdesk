import { parseHostTarget } from "@jagentdesk/protocol/host-target";
import type { ConnectionOffer } from "@jagentdesk/protocol/connection-offer";

export function parseAppPairingOffer(url: string) {
  const target = parseHostTarget(url);
  const link = target.pairing;
  if (!link.daemonPublicKeyB64) throw new Error("Generate a new pairing link on the host.");
  const endpoint = link.ip || link.host;
  const offer: ConnectionOffer = {
    v: 3,
    serverId: link.serverId,
    daemonPublicKeyB64: link.daemonPublicKeyB64,
    ...(endpoint
      ? { tailnetAddress: `${endpoint.includes(":") ? `[${endpoint}]` : endpoint}:${link.port}` }
      : {}),
    ...(link.relay ? { relay: link.relay } : {}),
  };
  return { offer, pk: link.pk, local: target.via === "local" };
}
