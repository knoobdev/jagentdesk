import type {
  ArgoCdAppDetail,
  ArgoCdAppSet,
  ArgoCdAppSource,
  ArgoCdAppSummary,
  ArgoCdCluster,
  ArgoCdEvent,
  ArgoCdHistoryEntry,
  ArgoCdLogEntry,
  ArgoCdManagedResource,
  ArgoCdOperationState,
  ArgoCdProject,
  ArgoCdRepo,
  ArgoCdResourceAction,
  ArgoCdResourceTree,
  ArgoCdRevisionMetadata,
  ArgoCdTreeNode,
} from "@jagentdesk/protocol/argocd/rpc-schemas";

// Allowlist mapping (spec 30.3, ADR-0034 §1): every Argo CD payload is read field by field
// into a wire DTO. Anything not copied here — repository passwords, SSH keys, cluster
// bearer tokens, `cluster.config`, Helm values — cannot reach the app.

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function strOr(value: unknown, fallback: string): string {
  return str(value) ?? fallback;
}

function bool(value: unknown): boolean {
  return value === true;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

export function timeMs(value: unknown): number | null {
  const text = str(value);
  if (!text) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(obj(value))) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function strings(value: unknown): string[] {
  return arr(value).filter((entry): entry is string => typeof entry === "string");
}

function toSource(raw: unknown): ArgoCdAppSource {
  const source = obj(raw);
  return {
    repoURL: strOr(source.repoURL, ""),
    path: str(source.path),
    chart: str(source.chart),
    targetRevision: str(source.targetRevision),
  };
}

function appSources(spec: Json): ArgoCdAppSource[] {
  const multi = arr(spec.sources);
  if (multi.length > 0) return multi.map(toSource);
  if (spec.source) return [toSource(spec.source)];
  return [];
}

function initiatedByLabel(raw: unknown): string | null {
  const initiatedBy = obj(raw);
  if (bool(initiatedBy.automated)) return "automated";
  return str(initiatedBy.username);
}

export function appKey(name: string, appNamespace: string | null): string {
  return `${appNamespace ?? ""}/${name}`;
}

export function toAppSummary(raw: unknown): ArgoCdAppSummary {
  const app = obj(raw);
  const metadata = obj(app.metadata);
  const spec = obj(app.spec);
  const status = obj(app.status);
  const destination = obj(spec.destination);
  const sync = obj(status.sync);
  const health = obj(status.health);
  const operationState = obj(status.operationState);
  const syncPolicy = obj(spec.syncPolicy);
  const syncRevisions = strings(sync.revisions);
  return {
    name: strOr(metadata.name, ""),
    appNamespace: str(metadata.namespace),
    project: strOr(spec.project, "default"),
    health: strOr(health.status, "Unknown"),
    sync: strOr(sync.status, "Unknown"),
    syncRevision: str(sync.revision) ?? syncRevisions[0] ?? null,
    sources: appSources(spec),
    destServer: str(destination.server),
    destName: str(destination.name),
    destNamespace: str(destination.namespace),
    labels: stringRecord(metadata.labels),
    autoSync: syncPolicy.automated !== undefined && syncPolicy.automated !== null,
    operationPhase: str(operationState.phase),
    operationStartedAt_ms: timeMs(operationState.startedAt),
    lastSyncAt_ms: timeMs(operationState.finishedAt),
    createdAt_ms: timeMs(metadata.creationTimestamp),
    deleting: str(metadata.deletionTimestamp) !== null,
  };
}

function toManagedResource(raw: unknown): ArgoCdManagedResource {
  const resource = obj(raw);
  const health = obj(resource.health);
  return {
    group: strOr(resource.group, ""),
    version: strOr(resource.version, ""),
    kind: strOr(resource.kind, ""),
    namespace: strOr(resource.namespace, ""),
    name: strOr(resource.name, ""),
    sync: strOr(resource.status, "Unknown"),
    health: resource.health
      ? { status: strOr(health.status, "Unknown"), message: str(health.message) }
      : null,
    hook: bool(resource.hook),
    requiresPruning: bool(resource.requiresPruning),
    requiresDeletionConfirmation: bool(resource.requiresDeletionConfirmation),
  };
}

function toOperationState(raw: unknown): ArgoCdOperationState | null {
  const state = obj(raw);
  const phase = str(state.phase);
  if (!phase) return null;
  const operation = obj(state.operation);
  const sync = obj(operation.sync);
  const syncResult = obj(state.syncResult);
  const initiatedBy = obj(operation.initiatedBy);
  return {
    phase,
    message: str(state.message),
    startedAt_ms: timeMs(state.startedAt),
    finishedAt_ms: timeMs(state.finishedAt),
    revision: str(syncResult.revision) ?? str(sync.revision),
    initiatedBy: initiatedByLabel(initiatedBy),
    automated: bool(initiatedBy.automated),
    prune: bool(sync.prune),
    dryRun: bool(sync.dryRun),
    resources: arr(syncResult.resources).map((entry) => {
      const resource = obj(entry);
      return {
        group: strOr(resource.group, ""),
        kind: strOr(resource.kind, ""),
        namespace: strOr(resource.namespace, ""),
        name: strOr(resource.name, ""),
        status: str(resource.status),
        message: str(resource.message),
        hookPhase: str(resource.hookPhase),
        syncPhase: str(resource.syncPhase),
      };
    }),
  };
}

function toHistoryEntry(raw: unknown): ArgoCdHistoryEntry {
  const entry = obj(raw);
  const initiatedBy = obj(entry.initiatedBy);
  return {
    id: num(entry.id) ?? 0,
    revision: str(entry.revision),
    revisions: strings(entry.revisions),
    deployedAt_ms: timeMs(entry.deployedAt),
    deployStartedAt_ms: timeMs(entry.deployStartedAt),
    initiatedBy: initiatedByLabel(initiatedBy),
    automated: bool(initiatedBy.automated),
    sources: appSources(entry),
  };
}

export function toAppDetail(
  raw: unknown,
  revisionMetadata: ArgoCdRevisionMetadata | null,
): ArgoCdAppDetail {
  const app = obj(raw);
  const spec = obj(app.spec);
  const status = obj(app.status);
  const syncPolicy = obj(spec.syncPolicy);
  const automated = obj(syncPolicy.automated);
  const operationState = toOperationState(status.operationState);
  const summary = obj(status.summary);
  const running =
    app.operation !== undefined ||
    operationState?.phase === "Running" ||
    operationState?.phase === "Terminating";
  return {
    ...toAppSummary(raw),
    syncOptions: strings(syncPolicy.syncOptions),
    autoSyncPrune: bool(automated.prune),
    autoSyncSelfHeal: bool(automated.selfHeal),
    conditions: arr(status.conditions).map((entry) => {
      const condition = obj(entry);
      return {
        type: strOr(condition.type, ""),
        message: strOr(condition.message, ""),
        lastTransitionTime_ms: timeMs(condition.lastTransitionTime),
      };
    }),
    operationState,
    operationRunning: running,
    history: arr(status.history).map(toHistoryEntry).toReversed(),
    resources: arr(status.resources).map(toManagedResource),
    images: strings(summary.images),
    externalURLs: strings(summary.externalURLs),
    reconciledAt_ms: timeMs(status.reconciledAt),
    revisionMetadata,
  };
}

export function toRevisionMetadata(revision: string, raw: unknown): ArgoCdRevisionMetadata {
  const metadata = obj(raw);
  return {
    revision,
    author: str(metadata.author),
    date_ms: timeMs(metadata.date),
    message: str(metadata.message),
    tags: strings(metadata.tags),
  };
}

function toTreeNode(raw: unknown): ArgoCdTreeNode {
  const node = obj(raw);
  const health = obj(node.health);
  return {
    group: strOr(node.group, ""),
    version: strOr(node.version, ""),
    kind: strOr(node.kind, ""),
    namespace: strOr(node.namespace, ""),
    name: strOr(node.name, ""),
    uid: strOr(node.uid, ""),
    parentRefs: arr(node.parentRefs).map((entry) => {
      const ref = obj(entry);
      return {
        group: strOr(ref.group, ""),
        kind: strOr(ref.kind, ""),
        namespace: strOr(ref.namespace, ""),
        name: strOr(ref.name, ""),
        uid: str(ref.uid),
      };
    }),
    health: node.health
      ? { status: strOr(health.status, "Unknown"), message: str(health.message) }
      : null,
    info: arr(node.info).map((entry) => {
      const info = obj(entry);
      return { name: strOr(info.name, ""), value: strOr(info.value, "") };
    }),
    images: strings(node.images),
    createdAt_ms: timeMs(node.createdAt),
  };
}

export function toResourceTree(raw: unknown): ArgoCdResourceTree {
  const tree = obj(raw);
  return {
    nodes: arr(tree.nodes).map(toTreeNode),
    orphanedNodes: arr(tree.orphanedNodes).map(toTreeNode),
  };
}

export function toEvent(raw: unknown): ArgoCdEvent {
  const event = obj(raw);
  const involved = obj(event.involvedObject);
  const source = obj(event.source);
  return {
    type: strOr(event.type, "Normal"),
    reason: strOr(event.reason, ""),
    message: strOr(event.message, ""),
    count: num(event.count) ?? 1,
    firstTimestamp_ms: timeMs(event.firstTimestamp) ?? timeMs(event.eventTime),
    lastTimestamp_ms: timeMs(event.lastTimestamp) ?? timeMs(event.eventTime),
    objectKind: strOr(involved.kind, ""),
    objectName: strOr(involved.name, ""),
    objectNamespace: str(involved.namespace),
    source: str(source.component) ?? str(event.reportingComponent),
  };
}

export function toLogEntry(raw: unknown): ArgoCdLogEntry & { last: boolean } {
  const entry = obj(raw);
  return {
    content: typeof entry.content === "string" ? entry.content : "",
    podName: strOr(entry.podName, ""),
    timeStamp_ms: timeMs(entry.timeStamp),
    last: bool(entry.last),
  };
}

export function toResourceAction(raw: unknown): ArgoCdResourceAction {
  const action = obj(raw);
  return {
    name: strOr(action.name, ""),
    displayName: str(action.displayName),
    disabled: bool(action.disabled),
    params: arr(action.params).map((entry) => {
      const param = obj(entry);
      return { name: strOr(param.name, ""), type: str(param.type) };
    }),
  };
}

function toConnectionState(raw: unknown): ArgoCdRepo["connectionState"] {
  if (!raw) return null;
  const state = obj(raw);
  return {
    status: strOr(state.status, "Unknown"),
    message: str(state.message),
    attemptedAt_ms: timeMs(state.attemptedAt),
  };
}

// Repository fields kept: identity and connection health only. Credential fields of
// v1alpha1Repository (password, username, sshPrivateKey, tlsClientCertData, tlsClientCertKey,
// githubAppPrivateKey, bearerToken, gcpServiceAccountKey, azureServicePrincipalClientSecret,
// proxy URLs that may embed credentials, …) are never read.
export function toRepo(raw: unknown): ArgoCdRepo {
  const repo = obj(raw);
  return {
    repo: strOr(repo.repo, ""),
    type: str(repo.type),
    name: str(repo.name),
    project: str(repo.project),
    insecure: bool(repo.insecure) || bool(repo.insecureIgnoreHostKey),
    enableLfs: bool(repo.enableLfs),
    enableOci: bool(repo.enableOCI),
    inheritedCreds: bool(repo.inheritedCreds),
    connectionState: toConnectionState(repo.connectionState),
  };
}

// `config` (bearer token, TLS client keys, exec/AWS/GCP auth) is never read.
export function toCluster(raw: unknown): ArgoCdCluster {
  const cluster = obj(raw);
  const info = obj(cluster.info);
  return {
    server: strOr(cluster.server, ""),
    name: strOr(cluster.name, ""),
    namespaces: strings(cluster.namespaces),
    project: str(cluster.project),
    labels: stringRecord(cluster.labels),
    serverVersion: str(info.serverVersion) ?? str(cluster.serverVersion),
    applicationsCount: num(info.applicationsCount),
    connectionState: toConnectionState(info.connectionState ?? cluster.connectionState),
  };
}

// Roles (with their JWT token metadata), sync windows and signature keys are not copied.
export function toProject(raw: unknown): ArgoCdProject {
  const project = obj(raw);
  const metadata = obj(project.metadata);
  const spec = obj(project.spec);
  return {
    name: strOr(metadata.name, ""),
    description: str(spec.description),
    sourceRepos: strings(spec.sourceRepos),
    destinations: arr(spec.destinations).map((entry) => {
      const destination = obj(entry);
      return {
        server: str(destination.server),
        name: str(destination.name),
        namespace: str(destination.namespace),
      };
    }),
    createdAt_ms: timeMs(metadata.creationTimestamp),
  };
}

// Generators can carry templates and SCM-provider token references, so only their type
// (the single key of each generator object) is copied.
export function toAppSet(raw: unknown): ArgoCdAppSet {
  const appset = obj(raw);
  const metadata = obj(appset.metadata);
  const spec = obj(appset.spec);
  const status = obj(appset.status);
  const template = obj(spec.template);
  const templateSpec = obj(template.spec);
  return {
    name: strOr(metadata.name, ""),
    namespace: str(metadata.namespace),
    project: str(templateSpec.project),
    generators: arr(spec.generators).flatMap((entry) => Object.keys(obj(entry))),
    conditions: arr(status.conditions).map((entry) => {
      const condition = obj(entry);
      return {
        type: strOr(condition.type, ""),
        message: strOr(condition.message, ""),
        lastTransitionTime_ms: timeMs(condition.lastTransitionTime),
      };
    }),
    resources: arr(status.resources).map((entry) => strOr(obj(entry).name, "")),
    createdAt_ms: timeMs(metadata.creationTimestamp),
  };
}
