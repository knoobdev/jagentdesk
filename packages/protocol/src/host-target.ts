import { z } from "zod";
import { buildRelayWebSocketUrl } from "./daemon-endpoints.js";

export const HostPairingLinkSchema = z.object({
  v: z.literal(1),
  serverId: z.string().min(1),
  host: z.string(),
  ip: z.string(),
  port: z.number().int().min(1).max(65535),
  pk: z.string().min(1),
  daemonPublicKeyB64: z.string().optional(),
  relay: z.object({ endpoint: z.string().min(1), useTls: z.boolean().optional() }).optional(),
});
export type HostPairingLink = z.infer<typeof HostPairingLinkSchema>;
export interface HostTarget {
  kind: "socket";
  url: string;
  via: "local" | "tailnet" | "relay";
  pairing: HostPairingLink;
  description: string;
}

/** Saved daemon connections use paired device authentication on the three client paths. */
export function parseHostTarget(input: string): HostTarget {
  try {
    const uri = new URL(input);
    if (uri.protocol !== "jagentdesk:" || uri.hostname !== "pair") throw new Error();
    const bytes = Uint8Array.from(
      atob(uri.hash.slice(1).replace(/-/g, "+").replace(/_/g, "/")),
      (c) => c.charCodeAt(0),
    );
    const pairing = HostPairingLinkSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const endpoint = pairing.ip || pairing.host;
    if (!endpoint && pairing.relay && pairing.daemonPublicKeyB64) {
      return {
        kind: "socket",
        via: "relay",
        pairing,
        url: buildRelayWebSocketUrl({
          endpoint: pairing.relay.endpoint,
          useTls: pairing.relay.useTls ?? true,
          serverId: pairing.serverId,
          role: "client",
        }),
        description: `relay://${pairing.relay.endpoint}/${encodeURIComponent(pairing.serverId)}`,
      };
    }
    if (!endpoint || /[\s/@?#]/.test(endpoint)) throw new Error();
    const local = endpoint === "127.0.0.1" || endpoint === "::1" || endpoint === "localhost";
    if (!local && !isTailnetEndpoint(endpoint)) throw new Error();
    const host = endpoint.includes(":") ? `[${endpoint}]` : endpoint;
    return {
      kind: "socket",
      pairing,
      via: local ? "local" : "tailnet",
      url: `ws://${host}:${pairing.port}/ws${local ? "?paired=1" : ""}`,
      description: `${local ? "local" : "tailnet"}://${host}:${pairing.port}`,
    };
  } catch {
    throw Object.assign(
      new Error(
        "Invalid host pairing link. Use a jagentdesk://pair link from the destination's Pair a device action.",
      ),
      { code: "invalid_connection" },
    );
  }
}

function isTailnetEndpoint(endpoint: string): boolean {
  const octets = endpoint.split(".").map(Number);
  const tailnetIp =
    octets.length === 4 &&
    octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    octets[0] === 100 &&
    octets[1]! >= 64 &&
    octets[1]! <= 127;
  return tailnetIp || /^fd7a:115c:a1e0:/i.test(endpoint) || endpoint.endsWith(".ts.net");
}
