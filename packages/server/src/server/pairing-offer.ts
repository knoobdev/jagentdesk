import type { Logger } from "pino";

import { createTailnetConnectionOffer, encodeOfferToFragmentUrl } from "./connection-offer.js";
import { loadOrCreateDaemonKeyPair } from "./daemon-keypair.js";
import { renderPairingQr } from "./pairing-qr.js";
import { getOrCreateServerId } from "./server-id.js";
import type { PairingCodeManager } from "./pairing/pairing-code.js";

export interface LocalPairingOffer {
  tailnetEnabled: boolean;
  url: string | null;
  qr: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAtMs: number | null;
}

export async function generateLocalPairingOffer(args: {
  jagentdeskHome: string;
  tailnetAddress?: string | null;
  useTls?: boolean;
  appBaseUrl?: string;
  includeQr?: boolean;
  logger?: Logger;
  pairingCodeManager?: PairingCodeManager;
  forceNewPairingCode?: boolean;
}): Promise<LocalPairingOffer> {
  const tailnetAddress = args.tailnetAddress ?? null;
  if (tailnetAddress === null) {
    return {
      tailnetEnabled: false,
      url: null,
      qr: null,
      pairingCode: null,
      pairingCodeExpiresAtMs: null,
    };
  }

  const useTls = args.useTls ?? false;
  const appBaseUrl = args.appBaseUrl ?? "jagentdesk://app";
  const serverId = getOrCreateServerId(args.jagentdeskHome, { logger: args.logger });
  const daemonKeyPair = await loadOrCreateDaemonKeyPair(args.jagentdeskHome, args.logger);
  const offer = await createTailnetConnectionOffer({
    serverId,
    daemonPublicKeyB64: daemonKeyPair.publicKeyB64,
    tailnetAddress,
    useTls,
  });
  const url = encodeOfferToFragmentUrl({ offer, appBaseUrl });
  if (args.includeQr === false) {
    return {
      tailnetEnabled: true,
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
    tailnetEnabled: true,
    url,
    qr,
    pairingCode: null,
    pairingCodeExpiresAtMs: null,
  };
}
