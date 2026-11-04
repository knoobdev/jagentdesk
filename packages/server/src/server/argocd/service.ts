import path from "node:path";
import type { Logger } from "pino";
import type {
  ArgoCdAppDetail,
  ArgoCdAppRef,
  ArgoCdAppSet,
  ArgoCdAppSummary,
  ArgoCdCluster,
  ArgoCdClusterLink,
  ArgoCdEvent,
  ArgoCdInstance,
  ArgoCdInstanceInput,
  ArgoCdProject,
  ArgoCdRepo,
  ArgoCdResourceAction,
  ArgoCdResourceDiff,
  ArgoCdResourceKey,
  ArgoCdResourceRef,
  ArgoCdResourceTree,
  ArgoCdRevisionMetadata,
  ArgoCdSyncRequestOptions,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import { FileSecretStore, type SecretStore } from "../database/secret-store.js";
import { ArgoCdConnection, parseVersion, secretKeys } from "./connection.js";
import {
  appKey,
  toAppDetail,
  toAppSet,
  toCluster,
  toEvent,
  toProject,
  toRepo,
  toResourceAction,
  toResourceTree,
  toRevisionMetadata,
} from "./dto.js";
import { manifestToYaml, unifiedDiff } from "./diff.js";
import { ArgoCdError, toArgoCdError } from "./errors.js";
import { ArgoCdRegistry, newInstanceId, type StoredArgoCdInstance } from "./registry.js";
import { ArgoCdSsoFlows, type SsoBegin } from "./sso.js";
import {
  AppWatch,
  AppsHub,
  listAppSummaries,
  streamLogs,
  type AppsListener,
  type LogChunk,
  type LogStreamOptions,
} from "./streams.js";
import type { ArgoCdStreamHandle } from "./http.js";

export const IN_CLUSTER_SERVER = "https://kubernetes.default.svc";
const DIFF_MAX_BYTES_PER_RESOURCE = 64 * 1024;

/** What the Argo CD feature needs from the Clusters feature (spec 30.3 "Nối Clusters"). */
export interface ArgoCdClusterAccess {
  list(): Promise<Array<{ clusterId: string; server: string | null; connected: boolean }>>;
  /** Read-only `get`; null when the resource is absent on that cluster. */
  resourceUid(clusterId: string, resource: ArgoCdResourceKey): Promise<string | null>;
}

export interface SsoDelegate {
  notify(payload: { instanceId: string; displayName: string; url: string }): void;
}

export type InstanceListener = (instance: ArgoCdInstance) => void;

function appQuery(ref: ArgoCdAppRef): { appNamespace?: string } {
  return ref.appNamespace ? { appNamespace: ref.appNamespace } : {};
}

function appPath(ref: ArgoCdAppRef, suffix = ""): string {
  return `/api/v1/applications/${encodeURIComponent(ref.name)}${suffix}`;
}

function resourceQuery(resource: ArgoCdResourceRef) {
  return {
    namespace: resource.namespace,
    resourceName: resource.name,
    version: resource.version,
    group: resource.group,
    kind: resource.kind,
  };
}

export function normalizeServerUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    const port = parsed.port || (parsed.protocol === "http:" ? "80" : "443");
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim().toLowerCase().replace(/\/+$/, "");
  }
}

function itemsOf(body: unknown): unknown[] {
  const items = (body as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items : [];
}

/** The exact `applicationApplicationSyncRequest` body (reference §1.3, CLI `app sync`). */
export function buildSyncBody(
  ref: ArgoCdAppRef,
  project: string | null,
  options: ArgoCdSyncRequestOptions,
): Record<string, unknown> {
  const strategy = options.applyOnly
    ? { apply: { force: options.force } }
    : { hook: { force: options.force } };
  const body: Record<string, unknown> = {
    name: ref.name,
    ...appQuery(ref),
    ...(project ? { project } : {}),
    prune: options.prune,
    dryRun: options.dryRun,
    strategy,
  };
  if (options.revision) body.revision = options.revision;
  if (options.resources && options.resources.length > 0) {
    body.resources = options.resources.map((resource) => ({
      group: resource.group,
      kind: resource.kind,
      name: resource.name,
      namespace: resource.namespace,
    }));
  }
  if (options.syncOptions.length > 0) body.syncOptions = { items: options.syncOptions };
  if (options.retry) {
    body.retryStrategy = {
      limit: options.retry.limit,
      ...(options.retry.backoffDuration
        ? {
            backoff: {
              duration: options.retry.backoffDuration,
              maxDuration: options.retry.backoffMaxDuration,
              factor: options.retry.backoffFactor,
            },
          }
        : {}),
    };
  }
  return body;
}

export interface SyncPreview {
  toChange: number;
  toPrune: number;
  resources: string[];
}

/** Counts what a sync would touch, from the app's managed resources (sync dialog summary). */
export function previewSync(app: ArgoCdAppDetail, options: ArgoCdSyncRequestOptions): SyncPreview {
  const selected = options.resources && options.resources.length > 0 ? options.resources : null;
  const inScope = app.resources.filter(
    (resource) =>
      !selected ||
      selected.some(
        (key) =>
          key.group === resource.group &&
          key.kind === resource.kind &&
          key.name === resource.name &&
          key.namespace === resource.namespace,
      ),
  );
  const outOfSync = inScope.filter((resource) => resource.sync !== "Synced");
  const toPrune = outOfSync.filter((resource) => resource.requiresPruning).length;
  return {
    toChange: outOfSync.length - toPrune,
    toPrune: options.prune ? toPrune : 0,
    resources: outOfSync.map(
      (resource) =>
        `${resource.kind}/${resource.namespace ? `${resource.namespace}/` : ""}${resource.name}${resource.requiresPruning ? " (prune)" : ""}`,
    ),
  };
}

export class ArgoCdService {
  private readonly registry: ArgoCdRegistry;
  private readonly secrets: SecretStore;
  private readonly connections = new Map<string, ArgoCdConnection>();
  private readonly hubs = new Map<string, AppsHub>();
  private readonly sso = new ArgoCdSsoFlows();
  private readonly instanceListeners = new Set<InstanceListener>();
  private readonly delegates = new Map<string, SsoDelegate>();
  private readonly revisionCache = new Map<string, ArgoCdRevisionMetadata>();

  constructor(
    private readonly options: {
      jagentdeskHome: string;
      logger: Logger;
      clusters: ArgoCdClusterAccess | null;
      secrets?: SecretStore;
    },
  ) {
    const directory = path.join(options.jagentdeskHome, "argocd");
    this.registry = new ArgoCdRegistry(directory);
    this.secrets = options.secrets ?? new FileSecretStore(directory);
  }

  async initialize(): Promise<void> {
    await this.registry.initialize();
    for (const record of this.registry.list()) {
      const connection = this.createConnection(record);
      await connection.load();
    }
  }

  dispose(): void {
    for (const hub of this.hubs.values()) hub.stop();
    for (const connection of this.connections.values()) connection.dispose();
  }

  onInstanceChanged(listener: InstanceListener): () => void {
    this.instanceListeners.add(listener);
    return () => this.instanceListeners.delete(listener);
  }

  registerSsoDelegate(key: string, delegate: SsoDelegate): () => void {
    this.delegates.set(key, delegate);
    return () => this.delegates.delete(key);
  }

  // ── instances ──

  listInstances(): ArgoCdInstance[] {
    return this.registry.list().map((record) => this.connection(record.id).toWire());
  }

  getInstance(id: string): ArgoCdInstance {
    return this.connection(id).toWire();
  }

  async saveInstance(input: ArgoCdInstanceInput): Promise<ArgoCdInstance> {
    const url = input.url.trim();
    if (!/^https?:\/\/[^/\s]+/i.test(url)) {
      throw new ArgoCdError("invalid_input", "URL must start with https:// or http://.");
    }
    if (input.authMethod === "password" && !input.username) {
      throw new ArgoCdError("invalid_input", "Username is required for password sign-in.");
    }
    const existing = input.id ? this.registry.get(input.id) : null;
    if (input.id && !existing) throw new ArgoCdError("not_found", `Unknown instance ${input.id}.`);
    const id = existing?.id ?? newInstanceId();
    const headerNames = await this.saveHeaders(id, input, existing?.headers ?? []);
    await this.saveClientCert(id, input);
    if (!input.rememberPassword) await this.secrets.delete(secretKeys.password(id));
    const record: StoredArgoCdInstance = {
      id,
      url: url.replace(/\/+$/, ""),
      displayName: input.displayName.trim() || new URL(url).host,
      authMethod: input.authMethod,
      username: input.authMethod === "password" ? input.username : null,
      tlsSkipVerify: input.tlsSkipVerify,
      caPem: input.caPem?.trim() ? input.caPem : null,
      headers: headerNames,
      rememberPassword: input.authMethod === "password" && input.rememberPassword,
      createdAt_ms: existing?.createdAt_ms ?? Date.now(),
    };
    await this.registry.upsert(record);
    const connection = this.connections.get(id);
    if (connection) await connection.updateRecord(record);
    else await this.createConnection(record).load();
    return this.connection(id).toWire();
  }

  /** Header values are secrets; the registry keeps only the names. */
  private async saveHeaders(
    id: string,
    input: ArgoCdInstanceInput,
    previous: string[],
  ): Promise<string[]> {
    const names = [...new Set(input.headers.map((header) => header.name.trim()))].filter(Boolean);
    for (const name of previous) {
      if (!names.includes(name)) await this.secrets.delete(secretKeys.header(id, name));
    }
    for (const header of input.headers) {
      if (header.value !== undefined) {
        await this.secrets.set(secretKeys.header(id, header.name.trim()), header.value);
      }
    }
    return names;
  }

  async deleteInstance(id: string): Promise<void> {
    const connection = this.connection(id);
    this.hubs.get(id)?.stop();
    this.hubs.delete(id);
    await connection.forget();
    connection.dispose();
    this.connections.delete(id);
    await this.registry.remove(id);
  }

  async login(
    id: string,
    credentials: { password?: string; token?: string },
  ): Promise<ArgoCdInstance> {
    const connection = this.connection(id);
    if (connection.record.authMethod === "token") {
      if (!credentials.token) throw new ArgoCdError("invalid_input", "Paste an API token.");
      await connection.loginWithToken(credentials.token.trim());
    } else if (connection.record.authMethod === "password") {
      await connection.loginWithPassword(credentials.password);
    } else {
      throw new ArgoCdError("invalid_input", "This instance signs in with SSO.");
    }
    return connection.toWire();
  }

  async logout(id: string): Promise<ArgoCdInstance> {
    const connection = this.connection(id);
    this.hubs.get(id)?.stop();
    this.hubs.delete(id);
    await connection.logout();
    return connection.toWire();
  }

  async ssoBegin(id: string): Promise<SsoBegin> {
    const connection = this.connection(id);
    if (connection.record.authMethod !== "sso") {
      throw new ArgoCdError("invalid_input", "This instance does not sign in with SSO.");
    }
    try {
      await connection.probe();
      return await this.sso.begin(id, await connection.transport());
    } catch (error) {
      throw toArgoCdError(error);
    }
  }

  async ssoComplete(
    id: string,
    input: {
      state: string;
      code?: string;
      error?: string;
      errorDescription?: string;
      errorCode?: ArgoCdError["code"];
    },
  ): Promise<ArgoCdInstance> {
    const connection = this.connection(id);
    if (!input.code) {
      this.sso.cancel(input.state);
      if (input.errorCode) {
        throw new ArgoCdError(
          input.errorCode,
          input.errorDescription ?? input.error ?? input.errorCode,
        );
      }
      const idpMessage = [input.error, input.errorDescription].filter(Boolean).join(": ");
      throw new ArgoCdError(
        "sso_idp_error",
        `${idpMessage || "The identity provider returned no code"}. You can sign in with an API token instead.`,
      );
    }
    const tokens = await this.sso.complete({
      instanceId: id,
      state: input.state,
      code: input.code,
      transport: await connection.transport(),
    });
    await connection.adoptSso(tokens);
    return connection.toWire();
  }

  /** Spec 30.2.2: asks every online paired desktop to run SSO for this instance. */
  ssoDelegate(id: string): number {
    const connection = this.connection(id);
    if (connection.record.authMethod !== "sso") {
      throw new ArgoCdError("invalid_input", "This instance does not sign in with SSO.");
    }
    if (this.delegates.size === 0) {
      throw new ArgoCdError(
        "sso_no_desktop",
        "No desktop app is online. Sign in with a password or an API token instead.",
      );
    }
    const payload = {
      instanceId: id,
      displayName: connection.record.displayName,
      url: connection.record.url,
    };
    for (const delegate of this.delegates.values()) delegate.notify(payload);
    return this.delegates.size;
  }

  // ── applications ──

  async listApps(instanceId: string): Promise<ArgoCdAppSummary[]> {
    return this.call(instanceId, (connection) => listAppSummaries(connection));
  }

  async subscribeApps(instanceId: string, listener: AppsListener): Promise<ArgoCdAppSummary[]> {
    const connection = this.connection(instanceId);
    let hub = this.hubs.get(instanceId);
    if (!hub) {
      hub = new AppsHub(connection, this.options.logger);
      this.hubs.set(instanceId, hub);
    }
    try {
      return await hub.subscribe(listener);
    } catch (error) {
      throw toArgoCdError(error);
    }
  }

  unsubscribeApps(instanceId: string, listener: AppsListener): void {
    const hub = this.hubs.get(instanceId);
    if (!hub) return;
    hub.unsubscribe(listener);
    if (hub.subscriberCount === 0) this.hubs.delete(instanceId);
  }

  async getAppRaw(
    instanceId: string,
    ref: ArgoCdAppRef,
    refresh?: "normal" | "hard",
  ): Promise<unknown> {
    return this.call(instanceId, (connection) =>
      connection.request({
        method: "GET",
        path: appPath(ref),
        query: { ...appQuery(ref), ...(refresh ? { refresh } : {}) },
      }),
    );
  }

  async getApp(
    instanceId: string,
    ref: ArgoCdAppRef,
    refresh?: "normal" | "hard",
  ): Promise<ArgoCdAppDetail> {
    const raw = await this.getAppRaw(instanceId, ref, refresh);
    return this.detailFromRaw(instanceId, ref, raw);
  }

  async detailFromRaw(
    instanceId: string,
    ref: ArgoCdAppRef,
    raw: unknown,
  ): Promise<ArgoCdAppDetail> {
    const draft = toAppDetail(raw, null);
    const revision = draft.syncRevision;
    const singleSource = draft.sources.length === 1 && !draft.sources[0]?.chart;
    if (!revision || !singleSource) return draft;
    return { ...draft, revisionMetadata: await this.revisionMetadata(instanceId, ref, revision) };
  }

  async revisionMetadata(
    instanceId: string,
    ref: ArgoCdAppRef,
    revision: string,
  ): Promise<ArgoCdRevisionMetadata | null> {
    const cacheKey = `${instanceId}|${appKey(ref.name, ref.appNamespace)}|${revision}`;
    const cached = this.revisionCache.get(cacheKey);
    if (cached) return cached;
    try {
      const body = await this.connection(instanceId).request({
        method: "GET",
        path: appPath(ref, `/revisions/${encodeURIComponent(revision)}/metadata`),
        query: appQuery(ref),
      });
      const metadata = toRevisionMetadata(revision, body);
      this.revisionCache.set(cacheKey, metadata);
      return metadata;
    } catch (error) {
      this.options.logger.debug(
        { err: error, instanceId, revision },
        "Revision metadata unavailable",
      );
      return null;
    }
  }

  async tree(instanceId: string, ref: ArgoCdAppRef): Promise<ArgoCdResourceTree> {
    return this.call(instanceId, async (connection) =>
      toResourceTree(
        await connection.request({
          method: "GET",
          path: appPath(ref, "/resource-tree"),
          query: appQuery(ref),
        }),
      ),
    );
  }

  async watchApp(
    instanceId: string,
    ref: ArgoCdAppRef,
    handlers: { onApp(app: ArgoCdAppDetail | null): void; onTree(tree: ArgoCdResourceTree): void },
  ): Promise<{ app: ArgoCdAppDetail; tree: ArgoCdResourceTree; close(): void }> {
    const connection = this.connection(instanceId);
    const [app, tree] = await Promise.all([
      this.getApp(instanceId, ref),
      this.tree(instanceId, ref),
    ]);
    let lastAppJson = JSON.stringify(app);
    const watch = new AppWatch(
      connection,
      ref,
      {
        onApp: (raw) => {
          if (raw === null) {
            handlers.onApp(null);
            return;
          }
          void this.detailFromRaw(instanceId, ref, raw).then((detail) => {
            const json = JSON.stringify(detail);
            if (json !== lastAppJson) {
              lastAppJson = json;
              handlers.onApp(detail);
            }
            return undefined;
          });
        },
        onTree: handlers.onTree,
      },
      this.options.logger,
    );
    try {
      await watch.start();
    } catch (error) {
      watch.close();
      throw toArgoCdError(error);
    }
    return { app, tree, close: () => watch.close() };
  }

  async diff(instanceId: string, ref: ArgoCdAppRef): Promise<ArgoCdResourceDiff[]> {
    return this.call(instanceId, async (connection) => {
      const body = await connection.request({
        method: "GET",
        path: appPath(ref, "/managed-resources"),
        query: appQuery(ref),
      });
      return itemsOf(body).map((raw) => {
        const item = raw as Record<string, unknown>;
        const key = {
          group: typeof item.group === "string" ? item.group : "",
          kind: typeof item.kind === "string" ? item.kind : "",
          namespace: typeof item.namespace === "string" ? item.namespace : "",
          name: typeof item.name === "string" ? item.name : "",
        };
        const predicted =
          typeof item.predictedLiveState === "string" && item.predictedLiveState !== ""
            ? item.predictedLiveState
            : (item.targetState as string | undefined);
        const diff = unifiedDiff({
          before: manifestToYaml(item.normalizedLiveState as string | undefined),
          after: manifestToYaml(predicted),
          label: `${key.kind}/${key.namespace ? `${key.namespace}/` : ""}${key.name}`,
          maxBytes: DIFF_MAX_BYTES_PER_RESOURCE,
        });
        return {
          group: key.group,
          kind: key.kind,
          namespace: key.namespace,
          name: key.name,
          modified: item.modified === true,
          hook: item.hook === true,
          diff: diff.text,
          truncated: diff.truncated,
        };
      });
    });
  }

  async manifests(
    instanceId: string,
    ref: ArgoCdAppRef,
    options: { resource?: ArgoCdResourceRef; revision?: string },
  ): Promise<string[]> {
    return this.call(instanceId, async (connection) => {
      if (options.resource) {
        const body = (await connection.request({
          method: "GET",
          path: appPath(ref, "/resource"),
          query: { ...appQuery(ref), ...resourceQuery(options.resource) },
        })) as { manifest?: unknown };
        return [manifestToYaml(typeof body.manifest === "string" ? body.manifest : null)];
      }
      const body = (await connection.request({
        method: "GET",
        path: appPath(ref, "/manifests"),
        query: { ...appQuery(ref), revision: options.revision },
      })) as { manifests?: unknown };
      const manifests = Array.isArray(body.manifests) ? body.manifests : [];
      return manifests
        .filter((manifest): manifest is string => typeof manifest === "string")
        .map((manifest) => manifestToYaml(manifest));
    });
  }

  async events(
    instanceId: string,
    ref: ArgoCdAppRef,
    resource?: ArgoCdResourceKey & { uid: string },
  ): Promise<ArgoCdEvent[]> {
    return this.call(instanceId, async (connection) => {
      const body = await connection.request({
        method: "GET",
        path: appPath(ref, "/events"),
        query: {
          ...appQuery(ref),
          ...(resource
            ? {
                resourceNamespace: resource.namespace,
                resourceName: resource.name,
                resourceUID: resource.uid,
              }
            : {}),
        },
      });
      return itemsOf(body)
        .map(toEvent)
        .sort((a, b) => (b.lastTimestamp_ms ?? 0) - (a.lastTimestamp_ms ?? 0));
    });
  }

  async streamLogs(
    instanceId: string,
    ref: ArgoCdAppRef,
    options: LogStreamOptions,
    onChunk: (chunk: LogChunk) => void,
  ): Promise<ArgoCdStreamHandle> {
    return this.call(instanceId, (connection) => streamLogs(connection, ref, options, onChunk));
  }

  /** Logs without follow (agent tool): collects until Argo CD sends `last`. */
  async readLogs(
    instanceId: string,
    ref: ArgoCdAppRef,
    options: LogStreamOptions,
  ): Promise<LogChunk> {
    return new Promise((resolve, reject) => {
      const entries: LogChunk["entries"] = [];
      this.streamLogs(instanceId, ref, { ...options, follow: false }, (chunk) => {
        entries.push(...chunk.entries);
        if (chunk.last) resolve({ entries, last: true, error: chunk.error });
      }).catch(reject);
    });
  }

  async sync(
    instanceId: string,
    ref: ArgoCdAppRef,
    options: ArgoCdSyncRequestOptions,
  ): Promise<ArgoCdAppDetail> {
    const current = await this.getApp(instanceId, ref);
    const body = buildSyncBody(ref, current.project, options);
    const raw = await this.call(instanceId, (connection) =>
      connection.request({ method: "POST", path: appPath(ref, "/sync"), body }),
    );
    return this.detailFromRaw(instanceId, ref, raw);
  }

  async refresh(instanceId: string, ref: ArgoCdAppRef, hard: boolean): Promise<ArgoCdAppDetail> {
    return this.getApp(instanceId, ref, hard ? "hard" : "normal");
  }

  async rollback(
    instanceId: string,
    ref: ArgoCdAppRef,
    input: { historyId: number; prune: boolean; dryRun: boolean },
  ): Promise<ArgoCdAppDetail> {
    const current = await this.getApp(instanceId, ref);
    // Spec 30.4: refused here, before any request — Argo CD would reject it anyway
    // (FailedPrecondition "rollback cannot be initiated when auto-sync is enabled").
    if (current.autoSync) {
      throw new ArgoCdError(
        "rollback_auto_sync",
        `Rollback is not available while auto-sync is on for ${ref.name}. Turn off auto-sync first.`,
      );
    }
    if (!current.history.some((entry) => entry.id === input.historyId)) {
      throw new ArgoCdError(
        "not_found",
        `History entry ${input.historyId} does not exist on ${ref.name}.`,
      );
    }
    const raw = await this.call(instanceId, (connection) =>
      connection.request({
        method: "POST",
        path: appPath(ref, "/rollback"),
        body: {
          name: ref.name,
          ...appQuery(ref),
          project: current.project,
          id: input.historyId,
          prune: input.prune,
          dryRun: input.dryRun,
        },
      }),
    );
    return this.detailFromRaw(instanceId, ref, raw);
  }

  async terminate(instanceId: string, ref: ArgoCdAppRef): Promise<void> {
    await this.call(instanceId, (connection) =>
      connection.request({
        method: "DELETE",
        path: appPath(ref, "/operation"),
        query: appQuery(ref),
      }),
    );
  }

  async deleteApp(
    instanceId: string,
    ref: ArgoCdAppRef,
    input: {
      confirmName: string;
      cascade: boolean;
      propagationPolicy: "foreground" | "background";
    },
  ): Promise<void> {
    if (input.confirmName !== ref.name) {
      throw new ArgoCdError("invalid_input", `Type ${ref.name} to confirm deletion.`);
    }
    await this.call(instanceId, (connection) =>
      connection.request({
        method: "DELETE",
        path: appPath(ref),
        query: {
          ...appQuery(ref),
          cascade: input.cascade,
          propagationPolicy: input.propagationPolicy,
        },
      }),
    );
  }

  async setAutoSync(
    instanceId: string,
    ref: ArgoCdAppRef,
    input: { enabled: boolean; prune: boolean; selfHeal: boolean },
  ): Promise<ArgoCdAppDetail> {
    const automated = input.enabled ? { prune: input.prune, selfHeal: input.selfHeal } : null;
    return this.patchApp(instanceId, ref, { spec: { syncPolicy: { automated } } });
  }

  async confirmPruning(instanceId: string, ref: ArgoCdAppRef): Promise<void> {
    await this.patchApp(instanceId, ref, {
      metadata: {
        annotations: { "argocd.argoproj.io/deletion-approved": new Date().toISOString() },
      },
    });
  }

  async resourceActions(
    instanceId: string,
    ref: ArgoCdAppRef,
    resource: ArgoCdResourceRef,
  ): Promise<ArgoCdResourceAction[]> {
    return this.call(instanceId, async (connection) => {
      const body = (await connection.request({
        method: "GET",
        path: appPath(ref, "/resource/actions"),
        query: { ...appQuery(ref), ...resourceQuery(resource) },
      })) as { actions?: unknown };
      return (Array.isArray(body.actions) ? body.actions : []).map(toResourceAction);
    });
  }

  async runResourceAction(
    instanceId: string,
    ref: ArgoCdAppRef,
    input: {
      resource: ArgoCdResourceRef;
      action: string;
      params: Array<{ name: string; value: string }>;
    },
  ): Promise<void> {
    const connection = this.connection(instanceId);
    const version = parseVersion(connection.toWire().serverVersion ?? "");
    const hasV2 = version === null || version[0] >= 3;
    await this.call(instanceId, () => {
      if (hasV2) {
        return connection.request({
          method: "POST",
          path: appPath(ref, "/resource/actions/v2"),
          body: {
            name: ref.name,
            ...appQuery(ref),
            ...resourceQuery(input.resource),
            action: input.action,
            resourceActionParameters: input.params,
          },
        });
      }
      // COMPAT(argocd214ResourceActions): 2.14 only has the v1 endpoint, whose body is the
      // action name as a JSON string. Remove when the minimum Argo CD version is 3.0.
      return connection.request({
        method: "POST",
        path: appPath(ref, "/resource/actions"),
        query: { ...appQuery(ref), ...resourceQuery(input.resource) },
        body: input.action,
      });
    });
  }

  async deleteResource(
    instanceId: string,
    ref: ArgoCdAppRef,
    input: { resource: ArgoCdResourceRef; force: boolean; orphan: boolean },
  ): Promise<void> {
    await this.call(instanceId, (connection) =>
      connection.request({
        method: "DELETE",
        path: appPath(ref, "/resource"),
        query: {
          ...appQuery(ref),
          ...resourceQuery(input.resource),
          force: input.force,
          orphan: input.orphan,
        },
      }),
    );
  }

  async canI(
    instanceId: string,
    input: { resource: string; action: string; subresource: string },
  ): Promise<boolean> {
    return this.call(instanceId, async (connection) => {
      // The subresource keeps its `/` (UI accounts-service.ts): `<project>/<app>`.
      const subresource = input.subresource.split("/").map(encodeURIComponent).join("/");
      const body = (await connection.request({
        method: "GET",
        path: `/api/v1/account/can-i/${encodeURIComponent(input.resource)}/${encodeURIComponent(input.action)}/${subresource}`,
      })) as { value?: unknown };
      return body.value === "yes";
    });
  }

  async listAppSets(instanceId: string): Promise<ArgoCdAppSet[]> {
    return this.listOf(instanceId, "/api/v1/applicationsets", toAppSet);
  }

  async listProjects(instanceId: string): Promise<ArgoCdProject[]> {
    return this.listOf(instanceId, "/api/v1/projects", toProject);
  }

  async listRepos(instanceId: string): Promise<ArgoCdRepo[]> {
    return this.listOf(instanceId, "/api/v1/repositories", toRepo);
  }

  async listClusters(instanceId: string): Promise<ArgoCdCluster[]> {
    return this.listOf(instanceId, "/api/v1/clusters", toCluster);
  }

  // ── cluster links ──

  listLinks(instanceId?: string): ArgoCdClusterLink[] {
    return this.registry.listLinks(instanceId);
  }

  async setLink(
    instanceId: string,
    destination: string,
    clusterId: string | null,
  ): Promise<ArgoCdClusterLink | null> {
    this.connection(instanceId);
    const link: ArgoCdClusterLink | null = clusterId
      ? { instanceId, destination, clusterId, verifiedBy: "manual" }
      : null;
    await this.registry.setLink(instanceId, destination, link);
    return link;
  }

  async resolveLink(
    instanceId: string,
    ref: ArgoCdAppRef,
  ): Promise<{ link: ArgoCdClusterLink | null; clusterConnected: boolean }> {
    const clusters = this.options.clusters;
    if (!clusters) return { link: null, clusterConnected: false };
    const app = await this.getApp(instanceId, ref);
    const destination = app.destServer ?? app.destName;
    if (!destination) return { link: null, clusterConnected: false };
    const known = await clusters.list();
    const connectedOf = (clusterId: string) =>
      known.some((cluster) => cluster.clusterId === clusterId && cluster.connected);
    const existing = this.registry.findLink(instanceId, destination);
    if (existing && known.some((cluster) => cluster.clusterId === existing.clusterId)) {
      return { link: existing, clusterConnected: connectedOf(existing.clusterId) };
    }
    const server = app.destServer ?? (await this.serverForDestinationName(instanceId, destination));
    const inCluster =
      server === null || normalizeServerUrl(server) === normalizeServerUrl(IN_CLUSTER_SERVER);
    let link: ArgoCdClusterLink | null = null;
    if (!inCluster && server) {
      const match = known.find(
        (cluster) =>
          cluster.server && normalizeServerUrl(cluster.server) === normalizeServerUrl(server),
      );
      if (match) link = { instanceId, destination, clusterId: match.clusterId, verifiedBy: "url" };
    }
    if (!link) link = await this.linkByUid(instanceId, ref, destination, known);
    if (!link) return { link: null, clusterConnected: false };
    await this.registry.setLink(instanceId, destination, link);
    return { link, clusterConnected: connectedOf(link.clusterId) };
  }

  /** Destination of an app plus its JAgentDesk cluster, for tool results (reference §5.4). */
  async linkedClusterId(instanceId: string, app: ArgoCdAppSummary): Promise<string | null> {
    const destination = app.destServer ?? app.destName;
    if (!destination) return null;
    return this.registry.findLink(instanceId, destination)?.clusterId ?? null;
  }

  // ── internals ──

  private async linkByUid(
    instanceId: string,
    ref: ArgoCdAppRef,
    destination: string,
    known: Array<{ clusterId: string; connected: boolean }>,
  ): Promise<ArgoCdClusterLink | null> {
    const clusters = this.options.clusters;
    const connected = known.filter((cluster) => cluster.connected);
    if (!clusters || connected.length === 0) return null;
    const tree = await this.tree(instanceId, ref);
    const probe = tree.nodes.find(
      (node) =>
        node.uid &&
        node.namespace &&
        ["Deployment", "Service", "ConfigMap", "StatefulSet", "DaemonSet", "Pod"].includes(
          node.kind,
        ),
    );
    if (!probe) return null;
    for (const cluster of connected) {
      try {
        const uid = await clusters.resourceUid(cluster.clusterId, probe);
        if (uid === probe.uid) {
          return { instanceId, destination, clusterId: cluster.clusterId, verifiedBy: "uid" };
        }
      } catch (error) {
        this.options.logger.debug({ err: error, clusterId: cluster.clusterId }, "uid probe failed");
      }
    }
    return null;
  }

  private async serverForDestinationName(instanceId: string, name: string): Promise<string | null> {
    if (name === "in-cluster") return IN_CLUSTER_SERVER;
    const clusters = await this.listClusters(instanceId);
    return clusters.find((cluster) => cluster.name === name)?.server ?? null;
  }

  private async patchApp(
    instanceId: string,
    ref: ArgoCdAppRef,
    patch: Record<string, unknown>,
  ): Promise<ArgoCdAppDetail> {
    const raw = await this.call(instanceId, (connection) =>
      connection.request({
        method: "PATCH",
        path: appPath(ref),
        body: {
          name: ref.name,
          ...appQuery(ref),
          patch: JSON.stringify(patch),
          patchType: "merge",
        },
      }),
    );
    return this.detailFromRaw(instanceId, ref, raw);
  }

  private async listOf<T>(
    instanceId: string,
    apiPath: string,
    map: (raw: unknown) => T,
  ): Promise<T[]> {
    return this.call(instanceId, async (connection) =>
      itemsOf(await connection.request({ method: "GET", path: apiPath })).map(map),
    );
  }

  private async call<T>(
    instanceId: string,
    run: (connection: ArgoCdConnection) => Promise<T>,
  ): Promise<T> {
    const connection = this.connection(instanceId);
    try {
      return await run(connection);
    } catch (error) {
      throw toArgoCdError(error);
    }
  }

  private connection(id: string): ArgoCdConnection {
    const connection = this.connections.get(id);
    if (!connection) throw new ArgoCdError("not_found", `Unknown Argo CD instance ${id}.`);
    return connection;
  }

  private createConnection(record: StoredArgoCdInstance): ArgoCdConnection {
    const connection: ArgoCdConnection = new ArgoCdConnection(record, {
      secrets: this.secrets,
      logger: this.options.logger,
      onChange: () => {
        const wire = connection.toWire();
        for (const listener of this.instanceListeners) listener(wire);
      },
    });
    this.connections.set(record.id, connection);
    return connection;
  }

  private async saveClientCert(id: string, input: ArgoCdInstanceInput): Promise<void> {
    if (input.clientCertPem === undefined && input.clientKeyPem === undefined) return;
    if (!input.clientCertPem || !input.clientKeyPem) {
      await this.secrets.delete(secretKeys.clientCert(id));
      await this.secrets.delete(secretKeys.clientKey(id));
      return;
    }
    await this.secrets.set(secretKeys.clientCert(id), input.clientCertPem);
    await this.secrets.set(secretKeys.clientKey(id), input.clientKeyPem);
  }
}
