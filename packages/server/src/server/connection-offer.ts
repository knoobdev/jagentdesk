import {
  TailnetConnectionOfferSchema,
  type ConnectionOffer,
  type RelayOfferEndpoint,
  type TailnetConnectionOffer,
} from "@jagentdesk/protocol/connection-offer";

export async function createTailnetConnectionOffer(args: {
  serverId: string;
  daemonPublicKeyB64: string;
  tailnetAddress: string;
  useTls?: boolean;
  relay?: RelayOfferEndpoint;
}): Promise<TailnetConnectionOffer> {
  return TailnetConnectionOfferSchema.parse({
    v: 3,
    serverId: args.serverId,
    daemonPublicKeyB64: args.daemonPublicKeyB64,
    tailnetAddress: args.tailnetAddress,
    ...(args.useTls ? { useTls: args.useTls } : {}),
    ...(args.relay ? { relay: args.relay } : {}),
  });
}

/**
 * Relay-only pairing offer (spec 35.4): issued when the tailnet is down but
 * relay is up. The app dials the Worker and pins `daemonPublicKeyB64` for the
 * Noise channel; there is no address to trust from the relay itself.
 */
export async function createRelayConnectionOffer(args: {
  serverId: string;
  daemonPublicKeyB64: string;
  relay: RelayOfferEndpoint;
}): Promise<ConnectionOffer> {
  return TailnetConnectionOfferSchema.parse({
    v: 3,
    serverId: args.serverId,
    daemonPublicKeyB64: args.daemonPublicKeyB64,
    relay: args.relay,
  });
}

export function encodeOfferToFragmentUrl(args: {
  offer: ConnectionOffer;
  appBaseUrl: string;
}): string {
  const json = JSON.stringify(args.offer);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  return `${args.appBaseUrl.replace(/\/$/, "")}/#offer=${encoded}`;
}
