import { z } from "zod";

// ── DTO schemas (mirror cluster-dto.ts, Zod-ified) ──────────────────────

export const KubeContextInfoSchema = z.object({
  name: z.string(),
  cluster: z.string(),
  server: z.string(),
  user: z.string(),
  namespace: z.string().optional(),
  current: z.boolean(),
});

export const ClusterInfoSchema = z.object({
  id: z.string(),
  contextName: z.string(),
  displayName: z.string(),
  distro: z.string().optional(),
  state: z.enum(["saved", "connecting", "connected", "error"]),
  nodeCount: z.number().int().optional(),
  podCount: z.number().int().optional(),
  lastError: z.string().optional(),
  lastSeen_ms: z.number().optional(),
});

export const WriteResultSchema = z.object({
  ok: z.boolean(),
  dryRun: z.boolean(),
  message: z.string(),
});

// ── Request schemas ─────────────────────────────────────────────────────

export const ClusterContextsRequestSchema = z.object({
  type: z.literal("cluster/contexts"),
  requestId: z.string(),
});

export const ClusterImportRequestSchema = z.object({
  type: z.literal("cluster/import"),
  requestId: z.string(),
  contextName: z.string().optional(),
  kubeconfigYaml: z.string().optional(),
  displayName: z.string().optional(),
});

export const ClusterListRequestSchema = z.object({
  type: z.literal("cluster/list"),
  requestId: z.string(),
});

export const ClusterConnectRequestSchema = z.object({
  type: z.literal("cluster/connect"),
  requestId: z.string(),
  id: z.string(),
});

export const ClusterDisconnectRequestSchema = z.object({
  type: z.literal("cluster/disconnect"),
  requestId: z.string(),
  id: z.string(),
});

export const ClusterResourcesRequestSchema = z.object({
  type: z.literal("cluster/resources"),
  requestId: z.string(),
  id: z.string(),
  kind: z.enum(["pods", "deployments", "nodes", "events"]),
  namespace: z.string().optional(),
});

export const ClusterGetRequestSchema = z.object({
  type: z.literal("cluster/get"),
  requestId: z.string(),
  id: z.string(),
  kind: z.string(),
  namespace: z.string().optional(),
  name: z.string(),
});

export const ClusterLogsRequestSchema = z.object({
  type: z.literal("cluster/logs"),
  requestId: z.string(),
  id: z.string(),
  namespace: z.string(),
  pod: z.string(),
  container: z.string().optional(),
});

export const ClusterWriteRequestSchema = z.object({
  type: z.literal("cluster/write"),
  requestId: z.string(),
  id: z.string(),
  kind: z.string(),
  namespace: z.string().optional(),
  name: z.string(),
  action: z.enum(["scale", "delete", "restart", "apply"]),
  replicas: z.number().int().optional(),
  manifestYaml: z.string().optional(),
  dryRun: z.boolean(),
});

// ── Response schemas ────────────────────────────────────────────────────

export const ClusterContextsResponseSchema = z.object({
  type: z.literal("cluster/contexts/response"),
  payload: z.object({
    requestId: z.string(),
    contexts: z.array(KubeContextInfoSchema),
    error: z.string().nullable(),
  }),
});

export const ClusterImportResponseSchema = z.object({
  type: z.literal("cluster/import/response"),
  payload: z.object({
    requestId: z.string(),
    clusters: z.array(ClusterInfoSchema),
    error: z.string().nullable(),
  }),
});

export const ClusterListResponseSchema = z.object({
  type: z.literal("cluster/list/response"),
  payload: z.object({
    requestId: z.string(),
    clusters: z.array(ClusterInfoSchema),
    error: z.string().nullable(),
  }),
});

export const ClusterConnectResponseSchema = z.object({
  type: z.literal("cluster/connect/response"),
  payload: z.object({
    requestId: z.string(),
    cluster: ClusterInfoSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ClusterDisconnectResponseSchema = z.object({
  type: z.literal("cluster/disconnect/response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
    error: z.string().nullable(),
  }),
});

export const ClusterResourcesResponseSchema = z.object({
  type: z.literal("cluster/resources/response"),
  payload: z.object({
    requestId: z.string(),
    kind: z.string(),
    items: z.array(z.unknown()),
    error: z.string().nullable(),
  }),
});

export const ClusterGetResponseSchema = z.object({
  type: z.literal("cluster/get/response"),
  payload: z.object({
    requestId: z.string(),
    yaml: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const ClusterLogsResponseSchema = z.object({
  type: z.literal("cluster/logs/response"),
  payload: z.object({
    requestId: z.string(),
    logs: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const ClusterWriteResponseSchema = z.object({
  type: z.literal("cluster/write/response"),
  payload: z.object({
    requestId: z.string(),
    result: WriteResultSchema.nullable(),
    error: z.string().nullable(),
  }),
});

// ── cluster/kinds ─────────────────────────────────────────────────────────

export const ClusterKindsRequestSchema = z.object({
  type: z.literal("cluster/kinds"),
  requestId: z.string(),
  id: z.string(),
});

export const ClusterKindsResponseSchema = z.object({
  type: z.literal("cluster/kinds/response"),
  payload: z.object({
    requestId: z.string(),
    kinds: z.array(
      z.object({
        kind: z.string(),
        apiVersion: z.string(),
        namespaced: z.boolean(),
        category: z.string(),
      }),
    ),
    error: z.string().nullable(),
  }),
});

// ── cluster/resource/list ──────────────────────────────────────────────────

export const ClusterResourceListRequestSchema = z.object({
  type: z.literal("cluster/resource/list"),
  requestId: z.string(),
  id: z.string(),
  kind: z.string(),
  namespace: z.string().optional(),
});

export const ClusterResourceListResponseSchema = z.object({
  type: z.literal("cluster/resource/list/response"),
  payload: z.object({
    requestId: z.string(),
    kind: z.string(),
    items: z.array(z.unknown()),
    error: z.string().nullable(),
  }),
});

// ── cluster/reveal-secret ────────────────────────────────────────────────────

export const ClusterRevealSecretRequestSchema = z.object({
  type: z.literal("cluster/reveal-secret"),
  requestId: z.string(),
  id: z.string(),
  namespace: z.string(),
  name: z.string(),
});

export const ClusterRevealSecretResponseSchema = z.object({
  type: z.literal("cluster/reveal-secret/response"),
  payload: z.object({
    requestId: z.string(),
    data: z.record(z.string(), z.string()).nullable(),
    error: z.string().nullable(),
  }),
});

// ── cluster/node-op ──────────────────────────────────────────────────────────

export const ClusterNodeOpRequestSchema = z.object({
  type: z.literal("cluster/node-op"),
  requestId: z.string(),
  id: z.string(),
  name: z.string(),
  op: z.enum(["cordon", "uncordon"]),
});

export const ClusterNodeOpResponseSchema = z.object({
  type: z.literal("cluster/node-op/response"),
  payload: z.object({
    requestId: z.string(),
    result: WriteResultSchema.nullable(),
    error: z.string().nullable(),
  }),
});

// ── cluster/cronjob-op ───────────────────────────────────────────────────────

export const ClusterCronjobOpRequestSchema = z.object({
  type: z.literal("cluster/cronjob-op"),
  requestId: z.string(),
  id: z.string(),
  namespace: z.string(),
  name: z.string(),
  op: z.enum(["trigger", "suspend", "resume"]),
});

export const ClusterCronjobOpResponseSchema = z.object({
  type: z.literal("cluster/cronjob-op/response"),
  payload: z.object({
    requestId: z.string(),
    result: WriteResultSchema.nullable(),
    error: z.string().nullable(),
  }),
});

// ── cluster/metrics ───────────────────────────────────────────────────────

export const ClusterMetricsRequestSchema = z.object({
  type: z.literal("cluster/metrics"),
  requestId: z.string(),
  id: z.string(),
  scope: z.enum(["nodes", "pods"]),
  namespace: z.string().optional(),
});

export const ClusterMetricsResponseSchema = z.object({
  type: z.literal("cluster/metrics/response"),
  payload: z.object({
    requestId: z.string(),
    scope: z.enum(["nodes", "pods"]),
    items: z.array(z.unknown()),
    error: z.string().nullable(),
  }),
});

// ── Type exports ────────────────────────────────────────────────────────

export type KubeContextInfo = z.infer<typeof KubeContextInfoSchema>;
export type ClusterInfo = z.infer<typeof ClusterInfoSchema>;
export type WriteResult = z.infer<typeof WriteResultSchema>;

export type ClusterContextsRequest = z.infer<typeof ClusterContextsRequestSchema>;
export type ClusterImportRequest = z.infer<typeof ClusterImportRequestSchema>;
export type ClusterListRequest = z.infer<typeof ClusterListRequestSchema>;
export type ClusterConnectRequest = z.infer<typeof ClusterConnectRequestSchema>;
export type ClusterDisconnectRequest = z.infer<typeof ClusterDisconnectRequestSchema>;
export type ClusterResourcesRequest = z.infer<typeof ClusterResourcesRequestSchema>;
export type ClusterGetRequest = z.infer<typeof ClusterGetRequestSchema>;
export type ClusterLogsRequest = z.infer<typeof ClusterLogsRequestSchema>;
export type ClusterWriteRequest = z.infer<typeof ClusterWriteRequestSchema>;

export type ClusterContextsResponse = z.infer<typeof ClusterContextsResponseSchema>;
export type ClusterImportResponse = z.infer<typeof ClusterImportResponseSchema>;
export type ClusterListResponse = z.infer<typeof ClusterListResponseSchema>;
export type ClusterConnectResponse = z.infer<typeof ClusterConnectResponseSchema>;
export type ClusterDisconnectResponse = z.infer<typeof ClusterDisconnectResponseSchema>;
export type ClusterResourcesResponse = z.infer<typeof ClusterResourcesResponseSchema>;
export type ClusterGetResponse = z.infer<typeof ClusterGetResponseSchema>;
export type ClusterLogsResponse = z.infer<typeof ClusterLogsResponseSchema>;
export type ClusterWriteResponse = z.infer<typeof ClusterWriteResponseSchema>;

export type ClusterKindsRequest = z.infer<typeof ClusterKindsRequestSchema>;
export type ClusterKindsResponse = z.infer<typeof ClusterKindsResponseSchema>;
export type ClusterResourceListRequest = z.infer<typeof ClusterResourceListRequestSchema>;
export type ClusterResourceListResponse = z.infer<typeof ClusterResourceListResponseSchema>;

export type ClusterRevealSecretRequest = z.infer<typeof ClusterRevealSecretRequestSchema>;
export type ClusterRevealSecretResponse = z.infer<typeof ClusterRevealSecretResponseSchema>;
export type ClusterNodeOpRequest = z.infer<typeof ClusterNodeOpRequestSchema>;
export type ClusterNodeOpResponse = z.infer<typeof ClusterNodeOpResponseSchema>;
export type ClusterCronjobOpRequest = z.infer<typeof ClusterCronjobOpRequestSchema>;
export type ClusterCronjobOpResponse = z.infer<typeof ClusterCronjobOpResponseSchema>;

export type ClusterMetricsRequest = z.infer<typeof ClusterMetricsRequestSchema>;
export type ClusterMetricsResponse = z.infer<typeof ClusterMetricsResponseSchema>;
