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

// ── cluster/logs/subscribe ─────────────────────────────────────────────────────

export const ClusterLogsSubscribeRequestSchema = z.object({
  type: z.literal("cluster/logs/subscribe"),
  requestId: z.string(),
  id: z.string(),
  subscriptionId: z.string(),
  namespace: z.string(),
  pod: z.string(),
  container: z.string().optional(),
});

export const ClusterLogsSubscribeResponseSchema = z.object({
  type: z.literal("cluster/logs/subscribe/response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string(),
    error: z.string().nullable(),
  }),
});

// ── cluster/logs/chunk (PUSH, no requestId) ────────────────────────────────────

export const ClusterLogsChunkSchema = z.object({
  type: z.literal("cluster/logs/chunk"),
  subscriptionId: z.string(),
  chunk: z.string(),
});

// ── cluster/logs/unsubscribe ───────────────────────────────────────────────────

export const ClusterLogsUnsubscribeRequestSchema = z.object({
  type: z.literal("cluster/logs/unsubscribe"),
  requestId: z.string(),
  subscriptionId: z.string(),
});

export const ClusterLogsUnsubscribeResponseSchema = z.object({
  type: z.literal("cluster/logs/unsubscribe/response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
  }),
});

export type ClusterLogsSubscribeRequest = z.infer<typeof ClusterLogsSubscribeRequestSchema>;
export type ClusterLogsSubscribeResponse = z.infer<typeof ClusterLogsSubscribeResponseSchema>;
export type ClusterLogsChunk = z.infer<typeof ClusterLogsChunkSchema>;
export type ClusterLogsUnsubscribeRequest = z.infer<typeof ClusterLogsUnsubscribeRequestSchema>;
export type ClusterLogsUnsubscribeResponse = z.infer<typeof ClusterLogsUnsubscribeResponseSchema>;

// ── cluster/helm/* ────────────────────────────────────────────────────────────

export const HelmReleaseDTOSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  revision: z.string(),
  updated: z.string(),
  status: z.string(),
  chart: z.string(),
  appVersion: z.string(),
});

export const HelmRevisionDTOSchema = z.object({
  revision: z.number(),
  updated: z.string(),
  status: z.string(),
  chart: z.string(),
  appVersion: z.string(),
  description: z.string(),
});

export const HelmResultSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
});

export const ClusterHelmListRequestSchema = z.object({
  type: z.literal("cluster/helm/list"),
  requestId: z.string(),
  id: z.string(),
});

export const ClusterHelmListResponseSchema = z.object({
  type: z.literal("cluster/helm/list/response"),
  payload: z.object({
    requestId: z.string(),
    releases: z.array(HelmReleaseDTOSchema),
    error: z.string().nullable(),
  }),
});

export const ClusterHelmHistoryRequestSchema = z.object({
  type: z.literal("cluster/helm/history"),
  requestId: z.string(),
  id: z.string(),
  namespace: z.string(),
  name: z.string(),
});

export const ClusterHelmHistoryResponseSchema = z.object({
  type: z.literal("cluster/helm/history/response"),
  payload: z.object({
    requestId: z.string(),
    revisions: z.array(HelmRevisionDTOSchema),
    error: z.string().nullable(),
  }),
});

export const ClusterHelmValuesRequestSchema = z.object({
  type: z.literal("cluster/helm/values"),
  requestId: z.string(),
  id: z.string(),
  namespace: z.string(),
  name: z.string(),
});

export const ClusterHelmValuesResponseSchema = z.object({
  type: z.literal("cluster/helm/values/response"),
  payload: z.object({
    requestId: z.string(),
    values: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const ClusterHelmRollbackRequestSchema = z.object({
  type: z.literal("cluster/helm/rollback"),
  requestId: z.string(),
  id: z.string(),
  namespace: z.string(),
  name: z.string(),
  revision: z.number(),
});

export const ClusterHelmRollbackResponseSchema = z.object({
  type: z.literal("cluster/helm/rollback/response"),
  payload: z.object({
    requestId: z.string(),
    result: HelmResultSchema.nullable(),
    error: z.string().nullable(),
  }),
});

export const ClusterHelmUninstallRequestSchema = z.object({
  type: z.literal("cluster/helm/uninstall"),
  requestId: z.string(),
  id: z.string(),
  namespace: z.string(),
  name: z.string(),
});

export const ClusterHelmUninstallResponseSchema = z.object({
  type: z.literal("cluster/helm/uninstall/response"),
  payload: z.object({
    requestId: z.string(),
    result: HelmResultSchema.nullable(),
    error: z.string().nullable(),
  }),
});

// ── cluster/exec/* ────────────────────────────────────────────────────────────

export const ClusterExecStartRequestSchema = z.object({
  type: z.literal("cluster/exec/start"),
  requestId: z.string(),
  id: z.string(),
  execId: z.string(),
  namespace: z.string(),
  pod: z.string(),
  container: z.string().optional(),
  command: z.array(z.string()).optional(),
});

export const ClusterExecStartResponseSchema = z.object({
  type: z.literal("cluster/exec/start/response"),
  payload: z.object({
    requestId: z.string(),
    execId: z.string(),
    error: z.string().nullable(),
  }),
});

export const ClusterExecStdinRequestSchema = z.object({
  type: z.literal("cluster/exec/stdin"),
  requestId: z.string().optional(),
  execId: z.string(),
  data: z.string(),
});

export const ClusterExecDataSchema = z.object({
  type: z.literal("cluster/exec/data"),
  execId: z.string(),
  data: z.string(),
});

export const ClusterExecCloseRequestSchema = z.object({
  type: z.literal("cluster/exec/close"),
  requestId: z.string(),
  execId: z.string(),
});

export const ClusterExecCloseResponseSchema = z.object({
  type: z.literal("cluster/exec/close/response"),
  payload: z.object({
    requestId: z.string(),
    ok: z.boolean(),
  }),
});

export type ClusterExecStartRequest = z.infer<typeof ClusterExecStartRequestSchema>;
export type ClusterExecStartResponse = z.infer<typeof ClusterExecStartResponseSchema>;
export type ClusterExecStdinRequest = z.infer<typeof ClusterExecStdinRequestSchema>;
export type ClusterExecData = z.infer<typeof ClusterExecDataSchema>;
export type ClusterExecCloseRequest = z.infer<typeof ClusterExecCloseRequestSchema>;
export type ClusterExecCloseResponse = z.infer<typeof ClusterExecCloseResponseSchema>;

export type ClusterHelmListRequest = z.infer<typeof ClusterHelmListRequestSchema>;
export type ClusterHelmListResponse = z.infer<typeof ClusterHelmListResponseSchema>;
export type ClusterHelmHistoryRequest = z.infer<typeof ClusterHelmHistoryRequestSchema>;
export type ClusterHelmHistoryResponse = z.infer<typeof ClusterHelmHistoryResponseSchema>;
export type ClusterHelmValuesRequest = z.infer<typeof ClusterHelmValuesRequestSchema>;
export type ClusterHelmValuesResponse = z.infer<typeof ClusterHelmValuesResponseSchema>;
export type ClusterHelmRollbackRequest = z.infer<typeof ClusterHelmRollbackRequestSchema>;
export type ClusterHelmRollbackResponse = z.infer<typeof ClusterHelmRollbackResponseSchema>;
export type ClusterHelmUninstallRequest = z.infer<typeof ClusterHelmUninstallRequestSchema>;
export type ClusterHelmUninstallResponse = z.infer<typeof ClusterHelmUninstallResponseSchema>;
