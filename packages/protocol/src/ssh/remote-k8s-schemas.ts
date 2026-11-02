import { z } from "zod";

// Kubernetes "through an SSH server" (spec 25.10). `import` reads a kubeconfig on the server
// over SFTP, forwards the chosen context's API server through the server, and makes that context
// loadable by the daemon's Clusters feature. The answer is a `cluster/import` request body
// (context name + display name): credentials stay in the daemon, never on the wire.

export const RemoteK8sClusterInputSchema = z.object({
  contextName: z.string(), // "ssh-<serverId>-<context>"
  displayName: z.string(),
});
export type RemoteK8sClusterInput = z.infer<typeof RemoteK8sClusterInputSchema>;

export const RemoteK8sErrorCodeSchema = z.enum([
  "connect_failed", // acquiring the SSH connection failed
  "kubeconfig_unreadable", // missing, not text, or not a kubeconfig
  "context_not_found", // the kubeconfig has no such context
  "forwarding_refused", // sshd forbids TCP forwarding (AllowTcpForwarding)
  "remote_unreachable", // the server could not connect to the API server
]);
export type RemoteK8sErrorCode = z.infer<typeof RemoteK8sErrorCodeSchema>;

export const SshRemoteK8sImportRequestSchema = z.object({
  type: z.literal("ssh.remote_k8s.import.request"),
  requestId: z.string(),
  serverId: z.string(),
  // On the server; relative paths start at the user's home (".kube/config").
  kubeconfigPath: z.string().min(1),
  context: z.string().min(1),
});
export type SshRemoteK8sImportRequest = z.infer<typeof SshRemoteK8sImportRequestSchema>;

export const SshRemoteK8sImportResponseSchema = z.object({
  type: z.literal("ssh.remote_k8s.import.response"),
  payload: z.object({
    requestId: z.string(),
    serverId: z.string(),
    clusterInput: RemoteK8sClusterInputSchema.nullable(),
    error: z.string().nullable(),
    errorCode: RemoteK8sErrorCodeSchema.nullable(),
  }),
});
export type SshRemoteK8sImportResponse = z.infer<typeof SshRemoteK8sImportResponseSchema>;

export const SshRemoteK8sInboundSchemas = [SshRemoteK8sImportRequestSchema] as const;
export const SshRemoteK8sOutboundSchemas = [SshRemoteK8sImportResponseSchema] as const;
