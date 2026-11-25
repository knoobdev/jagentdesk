import type { Logger } from "pino";

import {
  createRelayConnectionOffer,
  createTailnetConnectionOffer,
  encodeOfferToFragmentUrl,
} from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { renderPairingQr } from "./pairing-qr.js";
import { getOrCreateServerId } from "./server-id.js";
import type { PairingCodeManager } from "./pairing/pairing-code.js";

export interface LocalPairingOffer {
  tailnetEnabled: boolean;
  /** Spec 35.4: with relay on, the link/QR carries `relay` and pairs over it too. */
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAtMs: number | null;
}

const OFFER_DISABLED: LocalPairingOffer = {
  tailnetEnabled: false,
  relayEnabled: false,
  url: null,
  qr: null,
  pairingCode: null,
  pairingCodeExpiresAtMs: null,
};

export async function generateLocalPairingOffer(args: {
  jagentdeskHome: string;
  tailnetAddress?: string | null;
  useTls?: boolean;
  relayEnabled?: boolean;
  relayEndpoint?: string | null;
  relayUseTls?: boolean;
  appBaseUrl?: string;
  includeQr?: boolean;
  logger?: Logger;
  pairingCodeManager?: PairingCodeManager;
  forceNewPairingCode?: boolean;
}): Promise<LocalPairingOffer> {
  const tailnetAddress = args.tailnetAddress ?? null;
  const relayEnabled = args.relayEnabled === true && !!args.relayEndpoint;
  if (tailnetAddress === null && !relayEnabled) {
    // No path to dial: pairing needs at least one of the two transports (spec 35.4).
    return { ...OFFER_DISABLED };
  }

  const useTls = args.useTls ?? false;
  const appBaseUrl = args.appBaseUrl ?? "jagentdesk://app";
  const serverId = getOrCreateServerId(args.jagentdeskHome, { logger: args.logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(args.jagentdeskHome, args.logger);
  const relay = relayEnabled
    ? { endpoint: args.relayEndpoint as string, useTls: args.relayUseTls ?? true }
    : undefined;
  const offer = tailnetAddress
    ? await createTailnetConnectionOffer({
        serverId,
        daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
        tailnetAddress,
        useTls,
        ...(relay ? { relay } : {}),
      })
    : await createRelayConnectionOffer({
        serverId,
        daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
        relay: relay!,
      });
  const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });
  if (args.includeQr === false) {
    return {
      tailnetEnabled: tailnetAddress !== null,
      relayEnabled,
      url,
      qr: null,
      pairingCode: null,
      pairingCodeExpiresAtMs: null,
    };
  }

  let qr: string | null = null;
  try {
    qr = await renderPairingQr(url);
  } catch (error) {
    args.logger?.debug({ error }, "Failed to render pairing QR");
  }

  return {
    tailnetEnabled: tailnetAddress !== null,
    relayEnabled,
    url,
    qr,
    pairingCode: null,
    pairingCodeExpiresAtMs: null,
  };
}
