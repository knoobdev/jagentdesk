import {
  TailnetConnectionOfferSchema,
  type ConnectionOffer,
  type TailnetConnectionOffer,
} from "@jagentdesk/protocol/connection-offer";

export async function createTailnetConnectionOffer(args: {
  serverId: string;
  daemonPublicKeyB64: string;
  tailnetAddress: string;
  useTls?: boolean;
}): Promise<TailnetConnectionOffer> {
  return TailnetConnectionOfferSchema.parse({
    v: 3,
    serverId: args.serverId,
    daemonPublicKeyB64: args.daemonPublicKeyB64,
    tailnetAddress: args.tailnetAddress,
    ...(args.useTls ? { useTls: args.useTls } : {}),
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
