import { z } from "zod";

/**
 * Tailnet direct-connection offer (JAgentDesk).
 *
 * Carries the daemon's direct tailnet host:port plus its public key. There are
 * no hosted transport fields: transport encryption comes from WireGuard, and the client
 * dials `ws(s)://<tailnetAddress>/ws` directly with no `serverId`, `role`, or
 * `connectionId` query parameters.
 */
export const TailnetConnectionOfferSchema = z.object({
  v: z.literal(3),
  serverId: z.string().min(1),
  daemonPublicKeyB64: z.string().min(1),
  tailnetAddress: z.string().min(1),
  useTls: z.boolean().optional(),
});

export type TailnetConnectionOffer = z.infer<typeof TailnetConnectionOfferSchema>;

export const ConnectionOfferSchema = TailnetConnectionOfferSchema;
export type ConnectionOffer = TailnetConnectionOffer;

function decodeBase64UrlToUtf8(input: string): string {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function decodeOfferFragmentPayload(encoded: string): unknown {
  const json = decodeBase64UrlToUtf8(encoded);
  return JSON.parse(json) as unknown;
}

const OFFER_FRAGMENT_PREFIX = "#offer=";

function extractOfferFragmentEncoded(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const fragmentIndex = trimmed.indexOf(OFFER_FRAGMENT_PREFIX);
  if (fragmentIndex === -1) return null;
  const encoded = trimmed.slice(fragmentIndex + OFFER_FRAGMENT_PREFIX.length).trim();
  return encoded.length > 0 ? encoded : null;
}

/**
 * Parse a pairing-offer URL of the form `jagentdesk://app/#offer=<base64url>`.
 *
 * Returns `null` if the input has no `#offer=` fragment. Throws if the fragment
 * exists but the payload is malformed or fails schema validation.
 */
export function parseConnectionOfferFromUrl(input: string): ConnectionOffer | null {
  const encoded = extractOfferFragmentEncoded(input);
  if (!encoded) return null;
  const payload = decodeOfferFragmentPayload(encoded);
  return ConnectionOfferSchema.parse(payload);
}
