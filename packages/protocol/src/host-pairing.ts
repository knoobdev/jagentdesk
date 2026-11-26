import { z } from "zod";
import { HostAddSchema, HostSummarySchema } from "./hosts.js";
export const DeviceKindSchema = z.enum(["desktop", "mobile", "daemon"]);
const requestId = z.string();
export const HostPairingRequestSchemas = [
  z.object({ type: z.literal("pairing.sas.begin.request"), requestId }),
  z.object({
    type: z.literal("pairing.sas.confirm.request"),
    requestId,
    pk: z.string(),
    accepted: z.boolean(),
  }),
  z.object({
    type: z.literal("hosts.pair.begin.request"),
    requestId,
    input: HostAddSchema,
    registrationId: z.string().optional(),
    replaceIdentity: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("hosts.pair.confirm.request"),
    requestId,
    transactionId: z.string(),
    accepted: z.boolean(),
  }),
] as const;
export const HostPairingResponseSchemas = [
  z.object({
    type: z.literal("pairing.sas.begin.response"),
    payload: z.object({ requestId, link: z.string(), pk: z.string(), expiresAt: z.number() }),
  }),
  z.object({ type: z.literal("pairing.sas.confirm.response"), payload: z.object({ requestId }) }),
  z.object({
    type: z.literal("pairing.sas.changed"),
    payload: z.object({
      pk: z.string(),
      code: z.string().optional(),
      label: z.string().optional(),
      kind: DeviceKindSchema.optional(),
      state: z.enum(["waiting", "comparing", "completed", "cancelled"]),
      /** Why a `cancelled` attempt ended (`PairingEndReason`). Absent from older daemons. */
      reason: z.string().optional(),
      /** `completed` renewed a device whose key was already paired. Absent from older daemons. */
      repaired: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("hosts.pair.begin.response"),
    payload: z.object({
      requestId,
      transactionId: z.string(),
      code: z.string(),
      expiresAt: z.number(),
    }),
  }),
  z.object({
    type: z.literal("hosts.pair.confirm.response"),
    payload: z.object({ requestId, host: HostSummarySchema }),
  }),
] as const;
export const PairHelloSchema = z.object({
  type: z.literal("pair_hello"),
  pk: z.string(),
  pk_client: z.string(),
  nonce_client: z.string(),
  publicKeyEd25519: z.string(),
  label: z.string().max(64),
  kind: DeviceKindSchema,
});
export const PairConfirmSchema = z.object({
  type: z.literal("pair_confirm"),
  pk: z.string(),
  accepted: z.boolean(),
});
/**
 * Why an SAS pairing attempt ended, or why the daemon refused a `pair_hello` /
 * `pair_confirm`. Sent as `pair_error.reason` and `pairing.sas.changed.reason`.
 * The wire fields are plain strings so a newer daemon can add a reason without
 * breaking an older app; readers map the values they know.
 */
export const PAIRING_END_REASONS = [
  "expired",
  "replaced",
  "host_cancelled",
  "client_cancelled",
  "in_use",
  "connection_lost",
  "unknown_link",
  "completed",
  "bad_key",
  "node_changed",
  "daemon_stopped",
] as const;
export type PairingEndReason = (typeof PAIRING_END_REASONS)[number];
/**
 * `code` keeps the spec 05 error codes (`pairing_expired`, `pairing_in_use`,
 * `pairing_bad_key`, `node_changed`); daemons before 0.10.2 send only
 * `code: "pairing_failed"`.
 */
export const PairErrorSchema = z.object({
  type: z.literal("pair_error"),
  code: z.string(),
  reason: z.string().optional(),
});
export type PairError = z.infer<typeof PairErrorSchema>;
