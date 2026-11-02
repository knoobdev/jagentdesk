import { z } from "zod";

// Wire schemas for Docker on an SSH server (spec 25.10, milestone S8). The daemon forwards the
// server's Docker socket over `direct-streamlocal@openssh.com` to a 0600 socket under
// `$JAGENTDESK_HOME/ssh/run/` and runs its own `docker` against it, so the existing Docker
// cockpit and `docker_*` tools work unchanged on the forwarded socket.

export const RemoteDockerErrorCodeSchema = z.enum([
  "connect_failed", // acquiring the SSH connection failed
  "docker_not_found", // no Docker socket on the server
  "docker_socket_denied", // the socket exists but this user cannot open it (not in group docker)
  "forwarding_refused", // sshd refused the streamlocal channel (AllowStreamLocalForwarding no)
]);
export type RemoteDockerErrorCode = z.infer<typeof RemoteDockerErrorCodeSchema>;

// Opens (or joins) the forwarded socket. Every attach must be paired with a detach; the socket
// closes once nobody holds it and nothing used it for the idle period.
export const SshDockerAttachRequestSchema = z.object({
  type: z.literal("ssh.docker.attach.request"),
  requestId: z.string(),
  serverId: z.string(),
});
export type SshDockerAttachRequest = z.infer<typeof SshDockerAttachRequestSchema>;

export const SshDockerAttachResponseSchema = z.object({
  type: z.literal("ssh.docker.attach.response"),
  payload: z.object({
    requestId: z.string(),
    serverId: z.string(),
    // `unix://…` on the daemon machine; pass as `docker -H` (e.g. the cockpit's exec terminal).
    dockerHost: z.string().nullable(),
    remoteSocketPath: z.string().nullable(),
    error: z.string().nullable(),
    errorCode: RemoteDockerErrorCodeSchema.nullable(),
  }),
});
export type SshDockerAttachResponse = z.infer<typeof SshDockerAttachResponseSchema>;

export const SshDockerDetachRequestSchema = z.object({
  type: z.literal("ssh.docker.detach.request"),
  requestId: z.string(),
  serverId: z.string(),
});
export type SshDockerDetachRequest = z.infer<typeof SshDockerDetachRequestSchema>;

export const SshDockerDetachResponseSchema = z.object({
  type: z.literal("ssh.docker.detach.response"),
  payload: z.object({
    requestId: z.string(),
    serverId: z.string(),
    error: z.string().nullable(),
  }),
});
export type SshDockerDetachResponse = z.infer<typeof SshDockerDetachResponseSchema>;

export const SshRemoteDockerInboundSchemas = [
  SshDockerAttachRequestSchema,
  SshDockerDetachRequestSchema,
] as const;
export const SshRemoteDockerOutboundSchemas = [
  SshDockerAttachResponseSchema,
  SshDockerDetachResponseSchema,
] as const;
