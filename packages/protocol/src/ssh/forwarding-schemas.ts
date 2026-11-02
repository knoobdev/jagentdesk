import { z } from "zod";
import {
  SshModuleErrorSchema,
  sshModuleRequest as req,
  sshModuleResponse as resp,
} from "./module-rpc.js";

// Port forwarding rules (spec 25.6, milestone S3), stored in `$JAGENTDESK_HOME/ssh/forwarding.json`.
//   local   — the daemon listens on bindAddress:bindPort; each connection → direct-tcpip to
//             destHost:destPort through the server (`ssh -L`).
//   remote  — the server listens on bindAddress:bindPort (tcpip-forward); each connection comes
//             back to destHost:destPort as seen from the daemon (`ssh -R`).
//   dynamic — the daemon runs a SOCKS5 proxy on bindAddress:bindPort (`ssh -D`).

export const ForwardingKindSchema = z.enum(["local", "remote", "dynamic"]);
export type ForwardingKind = z.infer<typeof ForwardingKindSchema>;

export const ForwardingRuleSchema = z.object({
  id: z.string(), // `fwd_…`
  label: z.string(),
  kind: ForwardingKindSchema,
  serverId: z.string(),
  bindAddress: z.string(), // default "127.0.0.1"
  bindPort: z.number().int().min(0).max(65535),
  destHost: z.string().optional(), // required for local and remote
  destPort: z.number().int().min(1).max(65535).optional(),
  createdAtMs: z.number(),
  updatedAtMs: z.number(),
});
export type ForwardingRule = z.infer<typeof ForwardingRuleSchema>;

// New rules omit `id` and the timestamps; `bindAddress` defaults to 127.0.0.1.
export const ForwardingRuleInputSchema = z.object({
  id: z.string().optional(),
  label: z.string(),
  kind: ForwardingKindSchema,
  serverId: z.string(),
  bindAddress: z.string().optional(),
  bindPort: z.number().int().min(0).max(65535),
  destHost: z.string().optional(),
  destPort: z.number().int().min(1).max(65535).optional(),
});
export type ForwardingRuleInput = z.infer<typeof ForwardingRuleInputSchema>;

export const ForwardingStatusSchema = z.enum(["stopped", "starting", "active", "error"]);
export type ForwardingStatus = z.infer<typeof ForwardingStatusSchema>;

export const ForwardingStateSchema = z.object({
  ruleId: z.string(),
  status: ForwardingStatusSchema,
  /** The port actually bound (differs from bindPort only when bindPort is 0). */
  boundPort: z.number().int().optional(),
  activeConnections: z.number().int().nonnegative(),
  /** `port_in_use`, `remote_bind_refused`, `connection_lost`, … when status is `error`. */
  error: SshModuleErrorSchema.optional(),
  changedAtMs: z.number(),
});
export type ForwardingState = z.infer<typeof ForwardingStateSchema>;

export const SshForwardListRequestSchema = req("ssh.forward.list.request", {});
export const SshForwardListResponseSchema = resp("ssh.forward.list.response", {
  rules: z.array(ForwardingRuleSchema),
  states: z.array(ForwardingStateSchema),
});

export const SshForwardSaveRequestSchema = req("ssh.forward.save.request", {
  rule: ForwardingRuleInputSchema,
});
export const SshForwardSaveResponseSchema = resp("ssh.forward.save.response", {
  rule: ForwardingRuleSchema.nullable(),
});

// Stops the rule first when it is running.
export const SshForwardDeleteRequestSchema = req("ssh.forward.delete.request", { id: z.string() });
export const SshForwardDeleteResponseSchema = resp("ssh.forward.delete.response", {});

// Responds once the rule is `active` or `error`.
export const SshForwardStartRequestSchema = req("ssh.forward.start.request", { id: z.string() });
export const SshForwardStartResponseSchema = resp("ssh.forward.start.response", {
  state: ForwardingStateSchema.nullable(),
});

export const SshForwardStopRequestSchema = req("ssh.forward.stop.request", { id: z.string() });
export const SshForwardStopResponseSchema = resp("ssh.forward.stop.response", {
  state: ForwardingStateSchema.nullable(),
});

// Sent to every client whenever a rule's status or connection count changes, and with
// `status: "stopped"` after a rule is deleted.
export const SshForwardStateSchema = z.object({
  type: z.literal("ssh.forward.state"),
  state: ForwardingStateSchema,
});
export type SshForwardStateEvent = z.infer<typeof SshForwardStateSchema>;

export const ForwardingInboundSchemas = [
  SshForwardListRequestSchema,
  SshForwardSaveRequestSchema,
  SshForwardDeleteRequestSchema,
  SshForwardStartRequestSchema,
  SshForwardStopRequestSchema,
] as const;

export const ForwardingOutboundSchemas = [
  SshForwardListResponseSchema,
  SshForwardSaveResponseSchema,
  SshForwardDeleteResponseSchema,
  SshForwardStartResponseSchema,
  SshForwardStopResponseSchema,
  SshForwardStateSchema,
] as const;

export const ForwardingInboundMessageSchema = z.discriminatedUnion("type", [
  ...ForwardingInboundSchemas,
]);
export type ForwardingInboundMessage = z.infer<typeof ForwardingInboundMessageSchema>;
export const ForwardingOutboundMessageSchema = z.discriminatedUnion("type", [
  ...ForwardingOutboundSchemas,
]);
export type ForwardingOutboundMessage = z.infer<typeof ForwardingOutboundMessageSchema>;

/** Binding beyond loopback opens the port to the network; the UI asks before saving/starting. */
export function isLoopbackBindAddress(address: string): boolean {
  return address === "localhost" || address === "::1" || address.startsWith("127.");
}
