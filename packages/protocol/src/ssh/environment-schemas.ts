import { z } from "zod";

// Wire schemas for the server environment (spec 25.10, milestone S7). Same shape rules as
// ssh/rpc-schemas.ts: requests carry `type` + `requestId` at the top level; responses put the
// result under `payload` with `requestId` and `error` (docs/rpc-namespacing.md).

// A command found on the server's PATH; `version` is the first line its version flag prints,
// null when the command printed nothing.
export const ServerToolSchema = z.object({
  version: z.string().nullable(),
});
export type ServerTool = z.infer<typeof ServerToolSchema>;

// Docker is present when the CLI is on PATH or an engine socket exists. The daemon needs only
// the socket (it runs its own `docker` against the forwarded socket, 25.10).
export const ServerDockerSchema = z.object({
  version: z.string().nullable(),
  socketPath: z.string().nullable(),
  socketAccessible: z.boolean(),
});
export type ServerDocker = z.infer<typeof ServerDockerSchema>;

export const ServerPackageManagerSchema = z.enum([
  "apt",
  "dnf",
  "yum",
  "apk",
  "brew",
  "pacman",
  "zypper",
]);
export type ServerPackageManager = z.infer<typeof ServerPackageManagerSchema>;

export const ServerOsSchema = z.object({
  kernelName: z.string(), // `uname -s`, e.g. "Linux", "Darwin"
  kernelRelease: z.string(), // `uname -r`
  arch: z.string(), // `uname -m`
  distroId: z.string().nullable(), // os-release ID
  distroName: z.string().nullable(), // os-release NAME
  distroVersion: z.string().nullable(), // os-release VERSION_ID
  prettyName: z.string().nullable(), // os-release PRETTY_NAME
});
export type ServerOs = z.infer<typeof ServerOsSchema>;

export const ServerDiskSchema = z.object({
  mount: z.string(),
  totalBytes: z.number(),
  usedBytes: z.number(),
  availableBytes: z.number(),
});
export type ServerDisk = z.infer<typeof ServerDiskSchema>;

// systemd is non-null only when the server booted with systemd (`/run/systemd/system`).
export const ServerSystemdSchema = z.object({
  runningServices: z.array(z.string()),
  failedServices: z.array(z.string()),
  // The running list is capped; true when the server had more.
  runningTruncated: z.boolean(),
});
export type ServerSystemd = z.infer<typeof ServerSystemdSchema>;

export const ServerEnvironmentSchema = z.object({
  serverId: z.string(),
  detectedAtMs: z.number(),
  hostname: z.string().nullable(),
  os: ServerOsSchema,
  cpuCores: z.number().nullable(),
  cpuModel: z.string().nullable(),
  memoryTotalBytes: z.number().nullable(),
  memoryAvailableBytes: z.number().nullable(),
  rootDisk: ServerDiskSchema.nullable(),
  uptimeSeconds: z.number().nullable(),
  shell: z.string().nullable(), // login shell path ($SHELL)
  docker: ServerDockerSchema.nullable(),
  podman: ServerToolSchema.nullable(),
  systemctl: ServerToolSchema.nullable(),
  kubectl: ServerToolSchema.nullable(),
  psql: ServerToolSchema.nullable(),
  mysql: ServerToolSchema.nullable(),
  redisCli: ServerToolSchema.nullable(),
  nginx: ServerToolSchema.nullable(),
  packageManagers: z.array(ServerPackageManagerSchema),
  systemd: ServerSystemdSchema.nullable(),
});
export type ServerEnvironment = z.infer<typeof ServerEnvironmentSchema>;

// `force: false` (default) answers from the cached environment when one exists and only opens an
// exec channel when nothing was detected yet; `force: true` is the "Re-detect" button.
export const SshEnvironmentDetectRequestSchema = z.object({
  type: z.literal("ssh.environment.detect.request"),
  requestId: z.string(),
  serverId: z.string(),
  force: z.boolean().optional(),
});
export type SshEnvironmentDetectRequest = z.infer<typeof SshEnvironmentDetectRequestSchema>;

export const SshEnvironmentErrorCodeSchema = z.enum([
  "connect_failed", // acquiring the SSH connection failed
  "channel_refused", // the server refused another exec channel (MaxSessions=1, network gear)
  "timed_out",
  "unparseable", // the script ran but its output was not a detection report
]);
export type SshEnvironmentErrorCode = z.infer<typeof SshEnvironmentErrorCodeSchema>;

export const SshEnvironmentDetectResponseSchema = z.object({
  type: z.literal("ssh.environment.detect.response"),
  payload: z.object({
    requestId: z.string(),
    serverId: z.string(),
    environment: ServerEnvironmentSchema.nullable(),
    error: z.string().nullable(),
    errorCode: SshEnvironmentErrorCodeSchema.nullable(),
  }),
});
export type SshEnvironmentDetectResponse = z.infer<typeof SshEnvironmentDetectResponseSchema>;

export const SshEnvironmentInboundSchemas = [SshEnvironmentDetectRequestSchema] as const;
export const SshEnvironmentOutboundSchemas = [SshEnvironmentDetectResponseSchema] as const;
