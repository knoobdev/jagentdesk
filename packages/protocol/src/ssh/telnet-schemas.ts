import { z } from "zod";

// Wire schemas for plain (unencrypted) telnet sessions (spec 25, milestone
// S4-telnet). Mirrors ssh/rpc-schemas.ts: every request carries a `type`
// literal + `requestId`; every response is `{ type, payload: { requestId,
// ...data, error } }`. New RPCs use dotted namespaces with direction suffixes
// (docs/rpc-namespacing.md). The UI copy stating the connection is
// unencrypted lives in the app lane, not here.

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── session ──
// Opens a plain TCP connection to address:port (default 23). The returned
// terminalId works with the existing terminal RPCs (subscribe, input, resize,
// capture, kill) exactly like ssh.session.create's terminalId.
export const SshTelnetSessionCreateRequestSchema = req("ssh.telnet.session.create.request", {
  address: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(), // default 23
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});
export type SshTelnetSessionCreateRequest = z.infer<typeof SshTelnetSessionCreateRequestSchema>;
export const SshTelnetSessionCreateResponseSchema = resp("ssh.telnet.session.create.response", {
  terminalId: z.string().nullable(),
});
export type SshTelnetSessionCreateResponse = z.infer<typeof SshTelnetSessionCreateResponseSchema>;

export const SshTelnetSessionDestroyRequestSchema = req("ssh.telnet.session.destroy.request", {
  terminalId: z.string(),
});
export type SshTelnetSessionDestroyRequest = z.infer<typeof SshTelnetSessionDestroyRequestSchema>;
export const SshTelnetSessionDestroyResponseSchema = resp(
  "ssh.telnet.session.destroy.response",
  {},
);
export type SshTelnetSessionDestroyResponse = z.infer<typeof SshTelnetSessionDestroyResponseSchema>;

export const TelnetInboundSchemas = [
  SshTelnetSessionCreateRequestSchema,
  SshTelnetSessionDestroyRequestSchema,
] as const;

export const TelnetOutboundSchemas = [
  SshTelnetSessionCreateResponseSchema,
  SshTelnetSessionDestroyResponseSchema,
] as const;
