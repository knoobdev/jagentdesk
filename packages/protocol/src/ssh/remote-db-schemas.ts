import { z } from "zod";
import { DatabaseEngineSchema } from "../database/rpc-schemas.js";

// Databases "through an SSH server" (spec 25.10). `prepare` opens (or reuses) a temporary local
// forward 127.0.0.1:<localPort> → remoteHost:remotePort as seen from the server, and answers
// with the fields a `database/add` request takes. The same target always gets the same
// localPort, so a saved connection keeps working; the forward closes when the database
// connections through it are gone.

export const RemoteDbKindSchema = DatabaseEngineSchema.exclude(["sqlite"]);
export type RemoteDbKind = z.infer<typeof RemoteDbKindSchema>;

// `engine` + `config` of database/add; credentials are added by the client as usual.
export const RemoteDbConnectionSchema = z.object({
  engine: RemoteDbKindSchema,
  config: z.object({ host: z.string(), port: z.number().int() }),
});
export type RemoteDbConnection = z.infer<typeof RemoteDbConnectionSchema>;

export const RemoteDbErrorCodeSchema = z.enum([
  "connect_failed", // acquiring the SSH connection failed
  "port_in_use", // the target's fixed local port is taken by another program
  "forwarding_refused", // sshd forbids TCP forwarding (AllowTcpForwarding)
  "remote_unreachable", // the server could not connect to remoteHost:remotePort
]);
export type RemoteDbErrorCode = z.infer<typeof RemoteDbErrorCodeSchema>;

export const SshRemoteDbPrepareRequestSchema = z.object({
  type: z.literal("ssh.remote_db.prepare.request"),
  requestId: z.string(),
  serverId: z.string(),
  kind: RemoteDbKindSchema,
  remoteHost: z.string().min(1),
  remotePort: z.number().int().min(1).max(65535),
});
export type SshRemoteDbPrepareRequest = z.infer<typeof SshRemoteDbPrepareRequestSchema>;

export const SshRemoteDbPrepareResponseSchema = z.object({
  type: z.literal("ssh.remote_db.prepare.response"),
  payload: z.object({
    requestId: z.string(),
    serverId: z.string(),
    localPort: z.number().int().nullable(),
    connection: RemoteDbConnectionSchema.nullable(),
    error: z.string().nullable(),
    errorCode: RemoteDbErrorCodeSchema.nullable(),
  }),
});
export type SshRemoteDbPrepareResponse = z.infer<typeof SshRemoteDbPrepareResponseSchema>;

export const SshRemoteDbInboundSchemas = [SshRemoteDbPrepareRequestSchema] as const;
export const SshRemoteDbOutboundSchemas = [SshRemoteDbPrepareResponseSchema] as const;
