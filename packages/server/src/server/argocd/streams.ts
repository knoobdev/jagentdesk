import type { Logger } from "pino";
import type {
  ArgoCdAppRef,
  ArgoCdAppSummary,
  ArgoCdLogEntry,
  ArgoCdResourceTree,
} from "@jagentdesk/protocol/argocd/rpc-schemas";
import type { ArgoCdConnection } from "./connection.js";
import { toArgoCdError } from "./errors.js";
import type { ArgoCdStreamHandle } from "./http.js";
import { appKey, toAppSummary, toLogEntry, toResourceTree } from "./dto.js";

// Live updates (spec 30.3 "Cập nhật trực tiếp", reference §6 Realtime): one
// `stream/applications` per instance with narrow `fields`, shared by every viewer; the detail
// and resource-tree streams exist only while someone views that app.

// Paths of the Application object the list needs. The forwarder dedupes events on the
// serialized selection, so a narrow selection also means fewer events.
const APP_FIELD_PATHS = [
  "metadata.name",
  "metadata.namespace",
  "metadata.labels",
  "metadata.creationTimestamp",
  "metadata.deletionTimestamp",
  "spec.project",
  "spec.source",
  "spec.sources",
  "spec.destination",
  "spec.syncPolicy",
  "status.sync.status",
  "status.sync.revision",
  "status.sync.revisions",
  "status.health",
  "status.operationState.phase",
  "status.operationState.startedAt",
  "status.operationState.finishedAt",
];

export const APP_LIST_FIELDS = [
  "metadata.resourceVersion",
  ...APP_FIELD_PATHS.map((field) => `items.${field}`),
].join(",");
export const APP_STREAM_FIELDS = [
  "result.type",
  ...APP_FIELD_PATHS.map((field) => `result.application.${field}`),
].join(",");

const NOTIFY_COALESCE_MS = 250;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface AppsChange {
  upserts: ArgoCdAppSummary[];
  deletes: ArgoCdAppRef[];
  reset: boolean;
}

export type AppsListener = (change: AppsChange) => void;

interface StreamEvent {
  type?: unknown;
  application?: unknown;
}

function appQuery(ref: ArgoCdAppRef): { appNamespace?: string } {
  return ref.appNamespace ? { appNamespace: ref.appNamespace } : {};
}

export async function listAppSummaries(connection: ArgoCdConnection): Promise<ArgoCdAppSummary[]> {
  const body = (await connection.request({
    method: "GET",
    path: "/api/v1/applications",
    query: { fields: APP_LIST_FIELDS },
  })) as { items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  return items.map(toAppSummary).sort((a, b) => a.name.localeCompare(b.name));
}

/** The one shared application stream of an instance. */
export class AppsHub {
  private readonly snapshot = new Map<string, ArgoCdAppSummary>();
  private readonly serialized = new Map<string, string>();
  private readonly listeners = new Set<AppsListener>();
  private stream: ArgoCdStreamHandle | null = null;
  private pending: AppsChange = { upserts: [], deletes: [], reset: false };
  private notifyTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs = RECONNECT_MIN_MS;
  private started = false;

  constructor(
    private readonly connection: ArgoCdConnection,
    private readonly logger: Logger,
  ) {}

  get subscriberCount(): number {
    return this.listeners.size;
  }

  async subscribe(listener: AppsListener): Promise<ArgoCdAppSummary[]> {
    this.listeners.add(listener);
    if (!this.started) {
      this.started = true;
      this.connection.startViewing();
      try {
        await this.connect(false);
      } catch (error) {
        this.unsubscribe(listener);
        throw error;
      }
    }
    return [...this.snapshot.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  unsubscribe(listener: AppsListener): void {
    if (!this.listeners.delete(listener)) return;
    if (this.listeners.size > 0) return;
    this.stop();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.connection.stopViewing();
    this.stream?.close();
    this.stream = null;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.notifyTimer = null;
    this.reconnectTimer = null;
    this.snapshot.clear();
    this.serialized.clear();
  }

  private async connect(isReconnect: boolean): Promise<void> {
    this.stream = await this.connection.stream(
      { path: "/api/v1/stream/applications", query: { fields: APP_STREAM_FIELDS } },
      {
        onMessage: (result) => this.handleEvent(result as StreamEvent),
        onClose: (error) => this.handleClose(error),
      },
    );
    const apps = await listAppSummaries(this.connection);
    const seen = new Set<string>();
    for (const app of apps) {
      const key = appKey(app.name, app.appNamespace);
      seen.add(key);
      this.snapshot.set(key, app);
      this.serialized.set(key, JSON.stringify(app));
    }
    for (const key of this.snapshot.keys()) {
      if (!seen.has(key)) {
        this.snapshot.delete(key);
        this.serialized.delete(key);
      }
    }
    this.reconnectDelayMs = RECONNECT_MIN_MS;
    if (isReconnect) {
      this.pending = { upserts: apps, deletes: [], reset: true };
      this.flush();
    }
  }

  private handleEvent(event: StreamEvent): void {
    if (!event.application) return;
    const app = toAppSummary(event.application);
    const key = appKey(app.name, app.appNamespace);
    if (event.type === "DELETED") {
      if (!this.snapshot.delete(key)) return;
      this.serialized.delete(key);
      this.pending.deletes.push({ name: app.name, appNamespace: app.appNamespace });
      this.pending.upserts = this.pending.upserts.filter(
        (entry) => appKey(entry.name, entry.appNamespace) !== key,
      );
    } else {
      const serialized = JSON.stringify(app);
      if (this.serialized.get(key) === serialized) return;
      this.snapshot.set(key, app);
      this.serialized.set(key, serialized);
      this.pending.upserts = this.pending.upserts.filter(
        (entry) => appKey(entry.name, entry.appNamespace) !== key,
      );
      this.pending.upserts.push(app);
    }
    this.scheduleNotify();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.flush();
    }, NOTIFY_COALESCE_MS);
  }

  private flush(): void {
    const change = this.pending;
    this.pending = { upserts: [], deletes: [], reset: false };
    if (!change.reset && change.upserts.length === 0 && change.deletes.length === 0) return;
    for (const listener of this.listeners) listener(change);
  }

  private handleClose(error: Error | null): void {
    this.stream = null;
    if (!this.started) return;
    const failure = error ? toArgoCdError(error) : null;
    this.logger.info(
      { instanceId: this.connection.id, err: failure?.message ?? null },
      "Argo CD application stream closed; reconnecting",
    );
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.started) return;
      void this.reconnect(failure?.code === "unauthenticated" ? failure.message : null);
    }, delay);
  }

  private async reconnect(authFailure: string | null): Promise<void> {
    try {
      if (authFailure) await this.connection.recoverFromStreamAuthFailure(authFailure);
      await this.connect(true);
    } catch (error) {
      const failure = toArgoCdError(error);
      if (failure.code === "needs_reauth" || failure.code === "unauthenticated") {
        // The instance shows `needs_reauth`; the stream restarts when a viewer subscribes again
        // after signing in.
        this.logger.warn(
          { instanceId: this.connection.id },
          "Argo CD stream stopped: sign-in needed",
        );
        return;
      }
      this.handleClose(failure);
    }
  }
}

export interface AppWatchHandlers {
  onApp(app: unknown): void;
  onTree(tree: ArgoCdResourceTree): void;
}

/** Detail + resource-tree streams of one app, alive only while one viewer has it open. */
export class AppWatch {
  private appStream: ArgoCdStreamHandle | null = null;
  private treeStream: ArgoCdStreamHandle | null = null;
  private treeTimer: NodeJS.Timeout | null = null;
  private latestTree: ArgoCdResourceTree | null = null;
  private latestTreeJson = "";
  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly connection: ArgoCdConnection,
    private readonly ref: ArgoCdAppRef,
    private readonly handlers: AppWatchHandlers,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    this.connection.startViewing();
    await this.openApp();
    await this.openTree();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connection.stopViewing();
    this.appStream?.close();
    this.treeStream?.close();
    if (this.treeTimer) clearTimeout(this.treeTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
  }

  private async openApp(): Promise<void> {
    this.appStream = await this.connection.stream(
      {
        path: "/api/v1/stream/applications",
        query: { name: this.ref.name, ...appQuery(this.ref) },
      },
      {
        onMessage: (result) => {
          const event = result as StreamEvent;
          if (event.type === "DELETED") this.handlers.onApp(null);
          else if (event.application) this.handlers.onApp(event.application);
        },
        onClose: (error) => this.retry("app", error),
      },
    );
  }

  private async openTree(): Promise<void> {
    this.treeStream = await this.connection.stream(
      {
        path: `/api/v1/stream/applications/${encodeURIComponent(this.ref.name)}/resource-tree`,
        query: appQuery(this.ref),
      },
      {
        onMessage: (result) => {
          const tree = toResourceTree(result);
          const json = JSON.stringify(tree);
          if (json === this.latestTreeJson) return;
          this.latestTreeJson = json;
          this.latestTree = tree;
          if (this.treeTimer) return;
          this.treeTimer = setTimeout(() => {
            this.treeTimer = null;
            if (this.latestTree && !this.closed) this.handlers.onTree(this.latestTree);
          }, NOTIFY_COALESCE_MS);
        },
        onClose: (error) => this.retry("tree", error),
      },
    );
  }

  private retry(which: "app" | "tree", error: Error | null): void {
    if (this.closed) return;
    this.logger.debug(
      { instanceId: this.connection.id, app: this.ref.name, which, err: error?.message ?? null },
      "Argo CD app stream closed; reopening",
    );
    this.retryTimer = setTimeout(() => {
      if (this.closed) return;
      const reopen = which === "app" ? this.openApp() : this.openTree();
      reopen.catch((failure: unknown) => this.retry(which, toArgoCdError(failure)));
    }, RECONNECT_MIN_MS * 2);
  }
}

export interface LogStreamOptions {
  podName?: string;
  resource?: { group: string; kind: string; name: string };
  namespace: string;
  container?: string;
  tailLines?: number;
  sinceSeconds?: number;
  follow: boolean;
  filter?: string;
  previous: boolean;
}

export interface LogChunk {
  entries: ArgoCdLogEntry[];
  last: boolean;
  error: string | null;
}

export function logsPath(ref: ArgoCdAppRef, podName: string | undefined): string {
  const app = encodeURIComponent(ref.name);
  return podName
    ? `/api/v1/applications/${app}/pods/${encodeURIComponent(podName)}/logs`
    : `/api/v1/applications/${app}/logs`;
}

export function logsQuery(ref: ArgoCdAppRef, options: LogStreamOptions) {
  return {
    ...appQuery(ref),
    namespace: options.namespace,
    container: options.container,
    tailLines: options.tailLines,
    sinceSeconds: options.sinceSeconds,
    follow: options.follow,
    filter: options.filter,
    previous: options.previous,
    ...(options.resource
      ? {
          kind: options.resource.kind,
          group: options.resource.group,
          resourceName: options.resource.name,
        }
      : {}),
  };
}

const LOG_FLUSH_MS = 200;

/** Pod / resource logs as batched chunks; ends on `last`, close, or error. */
export async function streamLogs(
  connection: ArgoCdConnection,
  ref: ArgoCdAppRef,
  options: LogStreamOptions,
  onChunk: (chunk: LogChunk) => void,
): Promise<ArgoCdStreamHandle> {
  let buffer: ArgoCdLogEntry[] = [];
  let timer: NodeJS.Timeout | null = null;
  let done = false;
  function flush(last: boolean, error: string | null): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (done) return;
    if (last) done = true;
    if (buffer.length === 0 && !last) return;
    const entries = buffer;
    buffer = [];
    onChunk({ entries, last, error });
  }
  return connection.stream(
    {
      path: logsPath(ref, options.podName),
      query: logsQuery(ref, options),
      idleTimeoutMs: 120_000,
    },
    {
      onMessage: (result) => {
        const { last, ...entry } = toLogEntry(result);
        if (last) {
          flush(true, null);
          return;
        }
        buffer.push(entry);
        if (!timer) timer = setTimeout(() => flush(false, null), LOG_FLUSH_MS);
      },
      onClose: (error) => flush(true, error ? toArgoCdError(error).message : null),
    },
  );
}
