import { z } from "zod";

export const DirectTcpHostConnectionSchema = z.object({
  id: z.string(),
  type: z.literal("directTcp"),
  endpoint: z.string(),
  useTls: z.boolean().optional().default(false),
  password: z.string().optional(),
});

export type DirectTcpHostConnection = z.input<typeof DirectTcpHostConnectionSchema>;
export type NormalizedDirectTcpHostConnection = z.output<typeof DirectTcpHostConnectionSchema>;

/**
 * Relay host connection (spec 35.4). Routes through the public Cloudflare
 * Worker relay; content is E2EE in a Noise channel pinned to
 * `daemonPublicKeyB64`. Routing uses the owning host's `serverId`.
 */
export const RelayHostConnectionSchema = z.object({
  id: z.string(),
  type: z.literal("relay"),
  endpoint: z.string(),
  useTls: z.boolean().optional().default(true),
  daemonPublicKeyB64: z.string(),
});

export type RelayHostConnection = z.input<typeof RelayHostConnectionSchema>;
export type NormalizedRelayHostConnection = z.output<typeof RelayHostConnectionSchema>;
