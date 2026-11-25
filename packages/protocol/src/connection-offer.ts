import { z } from "zod";

/**
 * Connection offer (JAgentDesk).
 *
 * Carries the daemon's direct tailnet host:port plus its public key, and — once
 * the daemon enables relay (spec 35) — an optional public relay endpoint the
 * app can dial when the tailnet is down. Tailnet traffic rides WireGuard and
 * dials `ws(s)://<tailnetAddress>/ws` directly; relay traffic is E2EE over the
 * Cloudflare Worker (`@jagentdesk/relay`) and routes by `serverId`. A payload
 * must carry at least one route. Old clients strip the unknown `relay` key and
 * keep working from `tailnetAddress`; only `tailnetAddress`-less offers are
 * new-client-only.
 */
export const RelayOfferEndpointSchema = z.object({
  endpoint: z.string().min(1),
  useTls: z.boolean().optional(),
});

export type RelayOfferEndpoint = z.infer<typeof RelayOfferEndpointSchema>;

export const TailnetConnectionOfferSchema = z
  .object({
    v: z.literal(3),
    serverId: z.string().min(1),
    daemonPublicKeyB64: z.string().min(1),
    tailnetAddress: z.string().min(1).optional(),
    useTls: z.boolean().optional(),
    relay: RelayOfferEndpointSchema.optional(),
  })
  .superRefine((offer, ctx) => {
    if (!offer.tailnetAddress && !offer.relay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Connection offer requires tailnetAddress or relay",
      });
    }
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
