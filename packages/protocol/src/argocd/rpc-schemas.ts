import { z } from "zod";

// Wire schemas for Argo CD (spec 30, ADR-0034). Names follow docs/rpc-namespacing.md: the
// spec's `argocd/<noun>/<verb>` maps to `argocd.<noun>.<verb>.request|response`, pushes have
// no direction suffix.
//
// Every DTO below is an allowlist: the daemon maps Argo CD payloads field by field into these
// shapes, so a field that is not declared here never reaches the app. Tokens, refresh tokens,
// passwords, header values, mTLS keys and the PKCE verifier never appear on any message.

// ── shared enums ────────────────────────────────────────────────────────

export const ArgoCdAuthMethodSchema = z.enum(["password", "token", "sso"]);
export type ArgoCdAuthMethod = z.infer<typeof ArgoCdAuthMethodSchema>;

export const ArgoCdInstanceStateSchema = z.enum([
  "logged_out",
  "connecting",
  "connected",
  "needs_reauth",
  "error",
]);
export type ArgoCdInstanceState = z.infer<typeof ArgoCdInstanceStateSchema>;

// Machine-readable failure reasons the UI branches on. `error` keeps the human message.
export const ArgoCdErrorCodeSchema = z.enum([
  "not_found",
  "invalid_input",
  "unauthenticated",
  "needs_reauth",
  "forbidden",
  "tls_untrusted",
  "unreachable",
  "conflict",
  "rollback_auto_sync",
  "sso_unavailable",
  "sso_port_in_use",
  "sso_timeout",
  "sso_state_mismatch",
  "sso_idp_error",
  "sso_no_desktop",
  "unsupported_version",
  "argocd_error",
]);
export type ArgoCdErrorCode = z.infer<typeof ArgoCdErrorCodeSchema>;

// ── instances ───────────────────────────────────────────────────────────

export const ArgoCdInstanceSchema = z.object({
  id: z.string(), // `acd_…`
  url: z.string(),
  displayName: z.string(),
  authMethod: ArgoCdAuthMethodSchema,
  username: z.string().nullable(),
  tlsSkipVerify: z.boolean(),
  caPem: z.string().nullable(),
  // Custom header names only; the values are secrets and stay in the daemon.
  headerNames: z.array(z.string()),
  hasClientCert: z.boolean(),
  rememberPassword: z.boolean(),
  createdAt_ms: z.number(),
  state: ArgoCdInstanceStateSchema,
  groups: z.array(z.string()),
  expiresAt_ms: z.number().nullable(),
  serverVersion: z.string().nullable(),
  lastError: z.string().nullable(),
  lastErrorCode: ArgoCdErrorCodeSchema.nullable(),
  // SHA-256 fingerprint of the certificate Argo CD presented when TLS verification failed.
  tlsFingerprintSha256: z.string().nullable(),
  ssoConfigured: z.boolean(),
  userLoginsDisabled: z.boolean(),
});
export type ArgoCdInstance = z.infer<typeof ArgoCdInstanceSchema>;

export const ArgoCdHeaderInputSchema = z.object({
  name: z.string().min(1),
  // undefined keeps the stored value, a string replaces it.
  value: z.string().optional(),
});
export type ArgoCdHeaderInput = z.infer<typeof ArgoCdHeaderInputSchema>;

export const ArgoCdInstanceInputSchema = z.object({
  id: z.string(), // empty on create — the daemon assigns `acd_…`
  url: z.string().min(1),
  displayName: z.string(),
  authMethod: ArgoCdAuthMethodSchema,
  username: z.string().nullable(),
  tlsSkipVerify: z.boolean(),
  caPem: z.string().nullable(),
  headers: z.array(ArgoCdHeaderInputSchema),
  // mTLS: undefined keeps the stored pair, "" removes it, a PEM replaces it.
  clientCertPem: z.string().optional(),
  clientKeyPem: z.string().optional(),
  rememberPassword: z.boolean(),
});
export type ArgoCdInstanceInput = z.infer<typeof ArgoCdInstanceInputSchema>;

// ── applications ────────────────────────────────────────────────────────

export const ArgoCdAppRefSchema = z.object({
  name: z.string().min(1),
  appNamespace: z.string().nullable(),
});
export type ArgoCdAppRef = z.infer<typeof ArgoCdAppRefSchema>;

export const ArgoCdAppSourceSchema = z.object({
  repoURL: z.string(),
  path: z.string().nullable(),
  chart: z.string().nullable(),
  targetRevision: z.string().nullable(),
});
export type ArgoCdAppSource = z.infer<typeof ArgoCdAppSourceSchema>;

export const ArgoCdAppSummarySchema = z.object({
  name: z.string(),
  appNamespace: z.string().nullable(),
  project: z.string(),
  health: z.string(), // Healthy | Progressing | Degraded | Suspended | Missing | Unknown
  sync: z.string(), // Synced | OutOfSync | Unknown
  syncRevision: z.string().nullable(),
  sources: z.array(ArgoCdAppSourceSchema),
  destServer: z.string().nullable(),
  destName: z.string().nullable(),
  destNamespace: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  autoSync: z.boolean(),
  operationPhase: z.string().nullable(), // Running | Terminating | Failed | Error | Succeeded
  operationStartedAt_ms: z.number().nullable(),
  lastSyncAt_ms: z.number().nullable(),
  createdAt_ms: z.number().nullable(),
  deleting: z.boolean(),
});
export type ArgoCdAppSummary = z.infer<typeof ArgoCdAppSummarySchema>;

export const ArgoCdResourceKeySchema = z.object({
  group: z.string(),
  kind: z.string(),
  namespace: z.string(),
  name: z.string(),
});
export type ArgoCdResourceKey = z.infer<typeof ArgoCdResourceKeySchema>;

export const ArgoCdResourceRefSchema = ArgoCdResourceKeySchema.extend({
  version: z.string(),
});
export type ArgoCdResourceRef = z.infer<typeof ArgoCdResourceRefSchema>;

export const ArgoCdHealthSchema = z.object({
  status: z.string(),
  message: z.string().nullable(),
});

// One entry of `status.resources`: the managed resources the sync dialog lists.
export const ArgoCdManagedResourceSchema = ArgoCdResourceRefSchema.extend({
  sync: z.string(),
  health: ArgoCdHealthSchema.nullable(),
  hook: z.boolean(),
  requiresPruning: z.boolean(),
  requiresDeletionConfirmation: z.boolean(),
});
export type ArgoCdManagedResource = z.infer<typeof ArgoCdManagedResourceSchema>;

export const ArgoCdConditionSchema = z.object({
  type: z.string(),
  message: z.string(),
  lastTransitionTime_ms: z.number().nullable(),
});

export const ArgoCdSyncResultResourceSchema = ArgoCdResourceKeySchema.extend({
  status: z.string().nullable(), // Synced | SyncFailed | Pruned | PruneSkipped
  message: z.string().nullable(),
  hookPhase: z.string().nullable(),
  syncPhase: z.string().nullable(),
});

export const ArgoCdOperationStateSchema = z.object({
  phase: z.string(),
  message: z.string().nullable(),
  startedAt_ms: z.number().nullable(),
  finishedAt_ms: z.number().nullable(),
  revision: z.string().nullable(),
  initiatedBy: z.string().nullable(),
  automated: z.boolean(),
  prune: z.boolean(),
  dryRun: z.boolean(),
  resources: z.array(ArgoCdSyncResultResourceSchema),
});
export type ArgoCdOperationState = z.infer<typeof ArgoCdOperationStateSchema>;

export const ArgoCdHistoryEntrySchema = z.object({
  id: z.number(),
  revision: z.string().nullable(),
  revisions: z.array(z.string()),
  deployedAt_ms: z.number().nullable(),
  deployStartedAt_ms: z.number().nullable(),
  initiatedBy: z.string().nullable(),
  automated: z.boolean(),
  sources: z.array(ArgoCdAppSourceSchema),
});
export type ArgoCdHistoryEntry = z.infer<typeof ArgoCdHistoryEntrySchema>;

export const ArgoCdRevisionMetadataSchema = z.object({
  revision: z.string(),
  author: z.string().nullable(),
  date_ms: z.number().nullable(),
  message: z.string().nullable(),
  tags: z.array(z.string()),
});
export type ArgoCdRevisionMetadata = z.infer<typeof ArgoCdRevisionMetadataSchema>;

export const ArgoCdAppDetailSchema = ArgoCdAppSummarySchema.extend({
  syncOptions: z.array(z.string()),
  autoSyncPrune: z.boolean(),
  autoSyncSelfHeal: z.boolean(),
  conditions: z.array(ArgoCdConditionSchema),
  operationState: ArgoCdOperationStateSchema.nullable(),
  // True while an operation is requested or running (Terminate shows).
  operationRunning: z.boolean(),
  history: z.array(ArgoCdHistoryEntrySchema),
  resources: z.array(ArgoCdManagedResourceSchema),
  images: z.array(z.string()),
  externalURLs: z.array(z.string()),
  reconciledAt_ms: z.number().nullable(),
  revisionMetadata: ArgoCdRevisionMetadataSchema.nullable(),
});
export type ArgoCdAppDetail = z.infer<typeof ArgoCdAppDetailSchema>;

export const ArgoCdTreeNodeSchema = ArgoCdResourceRefSchema.extend({
  uid: z.string(),
  parentRefs: z.array(ArgoCdResourceKeySchema.extend({ uid: z.string().nullable() })),
  health: ArgoCdHealthSchema.nullable(),
  info: z.array(z.object({ name: z.string(), value: z.string() })),
  images: z.array(z.string()),
  createdAt_ms: z.number().nullable(),
});
export type ArgoCdTreeNode = z.infer<typeof ArgoCdTreeNodeSchema>;

export const ArgoCdResourceTreeSchema = z.object({
  nodes: z.array(ArgoCdTreeNodeSchema),
  orphanedNodes: z.array(ArgoCdTreeNodeSchema),
});
export type ArgoCdResourceTree = z.infer<typeof ArgoCdResourceTreeSchema>;

export const ArgoCdResourceDiffSchema = ArgoCdResourceKeySchema.extend({
  modified: z.boolean(),
  hook: z.boolean(),
  // Unified diff of normalized live (a) vs predicted live (b), as YAML. Empty when equal.
  diff: z.string(),
  truncated: z.boolean(),
});
export type ArgoCdResourceDiff = z.infer<typeof ArgoCdResourceDiffSchema>;

export const ArgoCdEventSchema = z.object({
  type: z.string(),
  reason: z.string(),
  message: z.string(),
  count: z.number(),
  firstTimestamp_ms: z.number().nullable(),
  lastTimestamp_ms: z.number().nullable(),
  objectKind: z.string(),
  objectName: z.string(),
  objectNamespace: z.string().nullable(),
  source: z.string().nullable(),
});
export type ArgoCdEvent = z.infer<typeof ArgoCdEventSchema>;

export const ArgoCdLogEntrySchema = z.object({
  content: z.string(),
  podName: z.string(),
  timeStamp_ms: z.number().nullable(),
});
export type ArgoCdLogEntry = z.infer<typeof ArgoCdLogEntrySchema>;

export const ArgoCdResourceActionSchema = z.object({
  name: z.string(),
  displayName: z.string().nullable(),
  disabled: z.boolean(),
  params: z.array(z.object({ name: z.string(), type: z.string().nullable() })),
});
export type ArgoCdResourceAction = z.infer<typeof ArgoCdResourceActionSchema>;

export const ArgoCdSyncRequestOptionsSchema = z.object({
  revision: z.string().optional(),
  prune: z.boolean(),
  dryRun: z.boolean(),
  force: z.boolean(),
  // Apply only: kubectl apply without running hooks (UI "Apply Only").
  applyOnly: z.boolean(),
  // Selective sync. Empty or absent = all resources.
  resources: z.array(ArgoCdResourceKeySchema).optional(),
  // `ApplyOutOfSyncOnly=true`, `ServerSideApply=true`, `PrunePropagationPolicy=foreground`, …
  syncOptions: z.array(z.string()),
  retry: z
    .object({
      limit: z.number().int(),
      backoffDuration: z.string().optional(),
      backoffMaxDuration: z.string().optional(),
      backoffFactor: z.number().int().optional(),
    })
    .optional(),
});
export type ArgoCdSyncRequestOptions = z.infer<typeof ArgoCdSyncRequestOptionsSchema>;

// ── settings lists (read-only, allowlisted) ─────────────────────────────

export const ArgoCdAppSetSchema = z.object({
  name: z.string(),
  namespace: z.string().nullable(),
  project: z.string().nullable(),
  generators: z.array(z.string()),
  conditions: z.array(ArgoCdConditionSchema),
  resources: z.array(z.string()),
  createdAt_ms: z.number().nullable(),
});
export type ArgoCdAppSet = z.infer<typeof ArgoCdAppSetSchema>;

export const ArgoCdProjectSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  sourceRepos: z.array(z.string()),
  destinations: z.array(
    z.object({
      server: z.string().nullable(),
      name: z.string().nullable(),
      namespace: z.string().nullable(),
    }),
  ),
  createdAt_ms: z.number().nullable(),
});
export type ArgoCdProject = z.infer<typeof ArgoCdProjectSchema>;

export const ArgoCdConnectionStateSchema = z.object({
  status: z.string(),
  message: z.string().nullable(),
  attemptedAt_ms: z.number().nullable(),
});

export const ArgoCdRepoSchema = z.object({
  repo: z.string(),
  type: z.string().nullable(),
  name: z.string().nullable(),
  project: z.string().nullable(),
  insecure: z.boolean(),
  enableLfs: z.boolean(),
  enableOci: z.boolean(),
  inheritedCreds: z.boolean(),
  connectionState: ArgoCdConnectionStateSchema.nullable(),
});
export type ArgoCdRepo = z.infer<typeof ArgoCdRepoSchema>;

export const ArgoCdClusterSchema = z.object({
  server: z.string(),
  name: z.string(),
  namespaces: z.array(z.string()),
  project: z.string().nullable(),
  labels: z.record(z.string(), z.string()),
  serverVersion: z.string().nullable(),
  applicationsCount: z.number().nullable(),
  connectionState: ArgoCdConnectionStateSchema.nullable(),
});
export type ArgoCdCluster = z.infer<typeof ArgoCdClusterSchema>;

export const ArgoCdClusterLinkSchema = z.object({
  instanceId: z.string(),
  destination: z.string(), // destination server URL or name
  clusterId: z.string(), // JAgentDesk `clu_…`
  verifiedBy: z.enum(["url", "uid", "manual"]),
});
export type ArgoCdClusterLink = z.infer<typeof ArgoCdClusterLinkSchema>;

// ── request / response helpers ──────────────────────────────────────────

const errorFields = {
  requestId: z.string(),
  error: z.string().nullable(),
  errorCode: ArgoCdErrorCodeSchema.nullable(),
};

function request<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...shape });
}

function response<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return z.object({ type: z.literal(type), payload: z.object({ ...errorFields, ...shape }) });
}

const instanceIdField = { instanceId: z.string().min(1) };
const appFields = { instanceId: z.string().min(1), app: ArgoCdAppRefSchema };

// ── instances ──
export const ArgoCdInstancesListRequestSchema = request("argocd.instances.list.request", {});
export const ArgoCdInstancesListResponseSchema = response("argocd.instances.list.response", {
  instances: z.array(ArgoCdInstanceSchema),
});
export const ArgoCdInstancesSaveRequestSchema = request("argocd.instances.save.request", {
  instance: ArgoCdInstanceInputSchema,
});
export const ArgoCdInstancesSaveResponseSchema = response("argocd.instances.save.response", {
  instance: ArgoCdInstanceSchema.nullable(),
});
export const ArgoCdInstancesDeleteRequestSchema = request("argocd.instances.delete.request", {
  id: z.string(),
});
export const ArgoCdInstancesDeleteResponseSchema = response("argocd.instances.delete.response", {});
// Password: uses `password` (or the remembered one). Token: uses `token`.
export const ArgoCdInstancesLoginRequestSchema = request("argocd.instances.login.request", {
  id: z.string(),
  password: z.string().optional(),
  token: z.string().optional(),
});
export const ArgoCdInstancesLoginResponseSchema = response("argocd.instances.login.response", {
  instance: ArgoCdInstanceSchema.nullable(),
});
export const ArgoCdInstancesLogoutRequestSchema = request("argocd.instances.logout.request", {
  id: z.string(),
});
export const ArgoCdInstancesLogoutResponseSchema = response("argocd.instances.logout.response", {
  instance: ArgoCdInstanceSchema.nullable(),
});

// ── SSO (30.2.1 / 30.2.2) ──
export const ArgoCdSsoBeginRequestSchema = request("argocd.sso.begin.request", {
  id: z.string(),
});
export const ArgoCdSsoBeginResponseSchema = response("argocd.sso.begin.response", {
  authUrl: z.string().nullable(),
  state: z.string().nullable(),
  redirectUri: z.string().nullable(),
  expiresAt_ms: z.number().nullable(),
});
// The desktop sends either `code` or the IdP / listener error it got instead.
export const ArgoCdSsoCompleteRequestSchema = request("argocd.sso.complete.request", {
  id: z.string(),
  state: z.string(),
  code: z.string().optional(),
  error: z.string().optional(),
  errorDescription: z.string().optional(),
  errorCode: ArgoCdErrorCodeSchema.optional(),
});
export const ArgoCdSsoCompleteResponseSchema = response("argocd.sso.complete.response", {
  instance: ArgoCdInstanceSchema.nullable(),
});
export const ArgoCdSsoDelegateRequestSchema = request("argocd.sso.delegate.request", {
  id: z.string(),
});
export const ArgoCdSsoDelegateResponseSchema = response("argocd.sso.delegate.response", {
  desktops: z.number(),
});

// ── applications ──
export const ArgoCdAppsListRequestSchema = request("argocd.apps.list.request", instanceIdField);
export const ArgoCdAppsListResponseSchema = response("argocd.apps.list.response", {
  apps: z.array(ArgoCdAppSummarySchema),
});
// One subscription per (session, instance). The response carries the snapshot; later changes
// arrive as `argocd.apps.changed`.
export const ArgoCdAppsSubscribeRequestSchema = request(
  "argocd.apps.subscribe.request",
  instanceIdField,
);
export const ArgoCdAppsSubscribeResponseSchema = response("argocd.apps.subscribe.response", {
  apps: z.array(ArgoCdAppSummarySchema),
});
export const ArgoCdAppsUnsubscribeRequestSchema = request(
  "argocd.apps.unsubscribe.request",
  instanceIdField,
);
export const ArgoCdAppsUnsubscribeResponseSchema = response("argocd.apps.unsubscribe.response", {});
export const ArgoCdAppGetRequestSchema = request("argocd.app.get.request", appFields);
export const ArgoCdAppGetResponseSchema = response("argocd.app.get.response", {
  app: ArgoCdAppDetailSchema.nullable(),
});
export const ArgoCdAppTreeSubscribeRequestSchema = request("argocd.app.tree.subscribe.request", {
  ...appFields,
  subscriptionId: z.string().min(1),
});
export const ArgoCdAppTreeSubscribeResponseSchema = response("argocd.app.tree.subscribe.response", {
  subscriptionId: z.string(),
  app: ArgoCdAppDetailSchema.nullable(),
  tree: ArgoCdResourceTreeSchema.nullable(),
});
export const ArgoCdAppTreeUnsubscribeRequestSchema = request(
  "argocd.app.tree.unsubscribe.request",
  { subscriptionId: z.string().min(1) },
);
export const ArgoCdAppTreeUnsubscribeResponseSchema = response(
  "argocd.app.tree.unsubscribe.response",
  {},
);
export const ArgoCdAppDiffRequestSchema = request("argocd.app.diff.request", appFields);
export const ArgoCdAppDiffResponseSchema = response("argocd.app.diff.response", {
  items: z.array(ArgoCdResourceDiffSchema),
});
export const ArgoCdAppManifestsRequestSchema = request("argocd.app.manifests.request", {
  ...appFields,
  // Absent: desired manifests at `revision` (or the target). Present: live manifest of it.
  resource: ArgoCdResourceRefSchema.optional(),
  revision: z.string().optional(),
});
export const ArgoCdAppManifestsResponseSchema = response("argocd.app.manifests.response", {
  manifests: z.array(z.string()), // YAML documents
});
export const ArgoCdAppEventsRequestSchema = request("argocd.app.events.request", {
  ...appFields,
  resource: ArgoCdResourceKeySchema.extend({ uid: z.string() }).optional(),
});
export const ArgoCdAppEventsResponseSchema = response("argocd.app.events.response", {
  events: z.array(ArgoCdEventSchema),
});
export const ArgoCdAppLogsSubscribeRequestSchema = request("argocd.app.logs.subscribe.request", {
  ...appFields,
  subscriptionId: z.string().min(1),
  // Pod logs when `podName` is set; otherwise every pod of `resource` (e.g. a Deployment).
  podName: z.string().optional(),
  resource: ArgoCdResourceKeySchema.optional(),
  namespace: z.string(),
  container: z.string().optional(),
  tailLines: z.number().int().optional(),
  sinceSeconds: z.number().int().optional(),
  follow: z.boolean(),
  filter: z.string().optional(),
  previous: z.boolean(),
});
export const ArgoCdAppLogsSubscribeResponseSchema = response("argocd.app.logs.subscribe.response", {
  subscriptionId: z.string(),
});
export const ArgoCdAppLogsUnsubscribeRequestSchema = request(
  "argocd.app.logs.unsubscribe.request",
  { subscriptionId: z.string().min(1) },
);
export const ArgoCdAppLogsUnsubscribeResponseSchema = response(
  "argocd.app.logs.unsubscribe.response",
  {},
);
export const ArgoCdAppSyncRequestSchema = request("argocd.app.sync.request", {
  ...appFields,
  options: ArgoCdSyncRequestOptionsSchema,
});
export const ArgoCdAppSyncResponseSchema = response("argocd.app.sync.response", {
  app: ArgoCdAppDetailSchema.nullable(),
});
export const ArgoCdAppRefreshRequestSchema = request("argocd.app.refresh.request", {
  ...appFields,
  hard: z.boolean(),
});
export const ArgoCdAppRefreshResponseSchema = response("argocd.app.refresh.response", {
  app: ArgoCdAppDetailSchema.nullable(),
});
export const ArgoCdAppRollbackRequestSchema = request("argocd.app.rollback.request", {
  ...appFields,
  historyId: z.number().int(),
  prune: z.boolean(),
  dryRun: z.boolean(),
});
export const ArgoCdAppRollbackResponseSchema = response("argocd.app.rollback.response", {
  app: ArgoCdAppDetailSchema.nullable(),
});
export const ArgoCdAppTerminateRequestSchema = request("argocd.app.terminate.request", appFields);
export const ArgoCdAppTerminateResponseSchema = response("argocd.app.terminate.response", {});
// `confirmName` must equal the app name: the daemon refuses otherwise (typed confirmation).
export const ArgoCdAppDeleteRequestSchema = request("argocd.app.delete.request", {
  ...appFields,
  confirmName: z.string(),
  cascade: z.boolean(),
  propagationPolicy: z.enum(["foreground", "background"]),
});
export const ArgoCdAppDeleteResponseSchema = response("argocd.app.delete.response", {});
export const ArgoCdAppSetAutoSyncRequestSchema = request("argocd.app.set_auto_sync.request", {
  ...appFields,
  enabled: z.boolean(),
  prune: z.boolean(),
  selfHeal: z.boolean(),
});
export const ArgoCdAppSetAutoSyncResponseSchema = response("argocd.app.set_auto_sync.response", {
  app: ArgoCdAppDetailSchema.nullable(),
});
export const ArgoCdAppConfirmPruningRequestSchema = request(
  "argocd.app.confirm_pruning.request",
  appFields,
);
export const ArgoCdAppConfirmPruningResponseSchema = response(
  "argocd.app.confirm_pruning.response",
  {},
);
export const ArgoCdAppResourceActionsListRequestSchema = request(
  "argocd.app.resource_actions.list.request",
  { ...appFields, resource: ArgoCdResourceRefSchema },
);
export const ArgoCdAppResourceActionsListResponseSchema = response(
  "argocd.app.resource_actions.list.response",
  { actions: z.array(ArgoCdResourceActionSchema) },
);
export const ArgoCdAppResourceActionRequestSchema = request("argocd.app.resource_action.request", {
  ...appFields,
  resource: ArgoCdResourceRefSchema,
  action: z.string().min(1),
  params: z.array(z.object({ name: z.string(), value: z.string() })),
});
export const ArgoCdAppResourceActionResponseSchema = response(
  "argocd.app.resource_action.response",
  {},
);
export const ArgoCdCanIRequestSchema = request("argocd.can_i.request", {
  ...instanceIdField,
  resource: z.string(),
  action: z.string(),
  subresource: z.string(),
});
export const ArgoCdCanIResponseSchema = response("argocd.can_i.response", {
  allowed: z.boolean(),
});

// ── settings lists ──
export const ArgoCdAppSetsListRequestSchema = request(
  "argocd.appsets.list.request",
  instanceIdField,
);
export const ArgoCdAppSetsListResponseSchema = response("argocd.appsets.list.response", {
  appsets: z.array(ArgoCdAppSetSchema),
});
export const ArgoCdProjectsListRequestSchema = request(
  "argocd.projects.list.request",
  instanceIdField,
);
export const ArgoCdProjectsListResponseSchema = response("argocd.projects.list.response", {
  projects: z.array(ArgoCdProjectSchema),
});
export const ArgoCdReposListRequestSchema = request("argocd.repos.list.request", instanceIdField);
export const ArgoCdReposListResponseSchema = response("argocd.repos.list.response", {
  repos: z.array(ArgoCdRepoSchema),
});
export const ArgoCdClustersListRequestSchema = request(
  "argocd.clusters.list.request",
  instanceIdField,
);
export const ArgoCdClustersListResponseSchema = response("argocd.clusters.list.response", {
  clusters: z.array(ArgoCdClusterSchema),
});

// ── cluster links (30.1 ClusterLink, 30.3 "Open in Clusters") ──
export const ArgoCdClusterLinksListRequestSchema = request("argocd.cluster_links.list.request", {
  instanceId: z.string().optional(),
});
export const ArgoCdClusterLinksListResponseSchema = response("argocd.cluster_links.list.response", {
  links: z.array(ArgoCdClusterLinkSchema),
});
// Manual assignment; `clusterId: null` removes the link.
export const ArgoCdClusterLinksSetRequestSchema = request("argocd.cluster_links.set.request", {
  instanceId: z.string().min(1),
  destination: z.string().min(1),
  clusterId: z.string().nullable(),
});
export const ArgoCdClusterLinksSetResponseSchema = response("argocd.cluster_links.set.response", {
  link: ArgoCdClusterLinkSchema.nullable(),
});
// Finds (and stores) the link for an app's destination: URL match first, then for
// `in-cluster` a read-only `get` of one tree node on each connected cluster, comparing uid.
export const ArgoCdClusterLinksResolveRequestSchema = request(
  "argocd.cluster_links.resolve.request",
  appFields,
);
export const ArgoCdClusterLinksResolveResponseSchema = response(
  "argocd.cluster_links.resolve.response",
  { link: ArgoCdClusterLinkSchema.nullable(), clusterConnected: z.boolean() },
);

// ── pushes ──
export const ArgoCdAppsChangedSchema = z.object({
  type: z.literal("argocd.apps.changed"),
  payload: z.object({
    instanceId: z.string(),
    upserts: z.array(ArgoCdAppSummarySchema),
    deletes: z.array(ArgoCdAppRefSchema),
    // True after the daemon reconnected the stream: `upserts` is the full set.
    reset: z.boolean(),
  }),
});
export const ArgoCdAppChangedSchema = z.object({
  type: z.literal("argocd.app.changed"),
  payload: z.object({
    subscriptionId: z.string(),
    app: ArgoCdAppDetailSchema.nullable(), // null: the app was deleted
  }),
});
export const ArgoCdAppTreeChangedSchema = z.object({
  type: z.literal("argocd.app.tree.changed"),
  payload: z.object({ subscriptionId: z.string(), tree: ArgoCdResourceTreeSchema }),
});
export const ArgoCdAppLogsChunkSchema = z.object({
  type: z.literal("argocd.app.logs.chunk"),
  payload: z.object({
    subscriptionId: z.string(),
    entries: z.array(ArgoCdLogEntrySchema),
    last: z.boolean(),
    error: z.string().nullable(),
  }),
});
export const ArgoCdInstancesChangedSchema = z.object({
  type: z.literal("argocd.instances.changed"),
  payload: z.object({ instance: ArgoCdInstanceSchema }),
});
// Sent to desktop clients that advertise the `argocd_sso_loopback` capability (30.2.2).
export const ArgoCdSsoDelegateRequestedSchema = z.object({
  type: z.literal("argocd.sso.delegate_requested"),
  payload: z.object({
    instanceId: z.string(),
    displayName: z.string(),
    url: z.string(),
  }),
});

export const ArgoCdRequestSchemas = [
  ArgoCdInstancesListRequestSchema,
  ArgoCdInstancesSaveRequestSchema,
  ArgoCdInstancesDeleteRequestSchema,
  ArgoCdInstancesLoginRequestSchema,
  ArgoCdInstancesLogoutRequestSchema,
  ArgoCdSsoBeginRequestSchema,
  ArgoCdSsoCompleteRequestSchema,
  ArgoCdSsoDelegateRequestSchema,
  ArgoCdAppsListRequestSchema,
  ArgoCdAppsSubscribeRequestSchema,
  ArgoCdAppsUnsubscribeRequestSchema,
  ArgoCdAppGetRequestSchema,
  ArgoCdAppTreeSubscribeRequestSchema,
  ArgoCdAppTreeUnsubscribeRequestSchema,
  ArgoCdAppDiffRequestSchema,
  ArgoCdAppManifestsRequestSchema,
  ArgoCdAppEventsRequestSchema,
  ArgoCdAppLogsSubscribeRequestSchema,
  ArgoCdAppLogsUnsubscribeRequestSchema,
  ArgoCdAppSyncRequestSchema,
  ArgoCdAppRefreshRequestSchema,
  ArgoCdAppRollbackRequestSchema,
  ArgoCdAppTerminateRequestSchema,
  ArgoCdAppDeleteRequestSchema,
  ArgoCdAppSetAutoSyncRequestSchema,
  ArgoCdAppConfirmPruningRequestSchema,
  ArgoCdAppResourceActionsListRequestSchema,
  ArgoCdAppResourceActionRequestSchema,
  ArgoCdCanIRequestSchema,
  ArgoCdAppSetsListRequestSchema,
  ArgoCdProjectsListRequestSchema,
  ArgoCdReposListRequestSchema,
  ArgoCdClustersListRequestSchema,
  ArgoCdClusterLinksListRequestSchema,
  ArgoCdClusterLinksSetRequestSchema,
  ArgoCdClusterLinksResolveRequestSchema,
] as const;

export const ArgoCdResponseSchemas = [
  ArgoCdInstancesListResponseSchema,
  ArgoCdInstancesSaveResponseSchema,
  ArgoCdInstancesDeleteResponseSchema,
  ArgoCdInstancesLoginResponseSchema,
  ArgoCdInstancesLogoutResponseSchema,
  ArgoCdSsoBeginResponseSchema,
  ArgoCdSsoCompleteResponseSchema,
  ArgoCdSsoDelegateResponseSchema,
  ArgoCdAppsListResponseSchema,
  ArgoCdAppsSubscribeResponseSchema,
  ArgoCdAppsUnsubscribeResponseSchema,
  ArgoCdAppGetResponseSchema,
  ArgoCdAppTreeSubscribeResponseSchema,
  ArgoCdAppTreeUnsubscribeResponseSchema,
  ArgoCdAppDiffResponseSchema,
  ArgoCdAppManifestsResponseSchema,
  ArgoCdAppEventsResponseSchema,
  ArgoCdAppLogsSubscribeResponseSchema,
  ArgoCdAppLogsUnsubscribeResponseSchema,
  ArgoCdAppSyncResponseSchema,
  ArgoCdAppRefreshResponseSchema,
  ArgoCdAppRollbackResponseSchema,
  ArgoCdAppTerminateResponseSchema,
  ArgoCdAppDeleteResponseSchema,
  ArgoCdAppSetAutoSyncResponseSchema,
  ArgoCdAppConfirmPruningResponseSchema,
  ArgoCdAppResourceActionsListResponseSchema,
  ArgoCdAppResourceActionResponseSchema,
  ArgoCdCanIResponseSchema,
  ArgoCdAppSetsListResponseSchema,
  ArgoCdProjectsListResponseSchema,
  ArgoCdReposListResponseSchema,
  ArgoCdClustersListResponseSchema,
  ArgoCdClusterLinksListResponseSchema,
  ArgoCdClusterLinksSetResponseSchema,
  ArgoCdClusterLinksResolveResponseSchema,
] as const;

export const ArgoCdPushSchemas = [
  ArgoCdAppsChangedSchema,
  ArgoCdAppChangedSchema,
  ArgoCdAppTreeChangedSchema,
  ArgoCdAppLogsChunkSchema,
  ArgoCdInstancesChangedSchema,
  ArgoCdSsoDelegateRequestedSchema,
] as const;

export type ArgoCdRequest = z.infer<(typeof ArgoCdRequestSchemas)[number]>;
export type ArgoCdResponse = z.infer<(typeof ArgoCdResponseSchemas)[number]>;
export type ArgoCdPush = z.infer<(typeof ArgoCdPushSchemas)[number]>;
