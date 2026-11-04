import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ArgoCdService } from "../../argocd/service.js";
import type { AppsListener } from "../../argocd/streams.js";
import { ArgoCdError, toArgoCdError } from "../../argocd/errors.js";

// The `argocd.*` RPC surface (spec 30.5). Every handler answers with its correlated response —
// an error response on failure, never a throw into the socket loop. Request bodies are never
// logged: login and save carry passwords, tokens and header values.

export interface ArgoCdSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ArgoCdSessionOptions {
  host: ArgoCdSessionHost;
  service: ArgoCdService | null;
  logger: pino.Logger;
  /** Unique per WebSocket session; keys the SSO delegate registration. */
  sessionKey: string;
  /** True when this client is a desktop that can run the 8085 loopback (spec 30.2.2). */
  canRunSsoLoopback(): boolean;
}

type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;
type ResponseType = Extract<SessionOutboundMessage["type"], `argocd.${string}.response`>;
type ResponseMessage<T extends ResponseType> = Extract<SessionOutboundMessage, { type: T }>;
type ResponseData<T extends ResponseType> = Omit<
  ResponseMessage<T>["payload"],
  "requestId" | "error" | "errorCode"
>;

export const ARGOCD_REQUEST_TYPES = [
  "argocd.instances.list.request",
  "argocd.instances.save.request",
  "argocd.instances.delete.request",
  "argocd.instances.login.request",
  "argocd.instances.logout.request",
  "argocd.sso.begin.request",
  "argocd.sso.complete.request",
  "argocd.sso.delegate.request",
  "argocd.apps.list.request",
  "argocd.apps.subscribe.request",
  "argocd.apps.unsubscribe.request",
  "argocd.app.get.request",
  "argocd.app.tree.subscribe.request",
  "argocd.app.tree.unsubscribe.request",
  "argocd.app.diff.request",
  "argocd.app.manifests.request",
  "argocd.app.events.request",
  "argocd.app.logs.subscribe.request",
  "argocd.app.logs.unsubscribe.request",
  "argocd.app.sync.request",
  "argocd.app.refresh.request",
  "argocd.app.rollback.request",
  "argocd.app.terminate.request",
  "argocd.app.delete.request",
  "argocd.app.set_auto_sync.request",
  "argocd.app.confirm_pruning.request",
  "argocd.app.resource_actions.list.request",
  "argocd.app.resource_action.request",
  "argocd.can_i.request",
  "argocd.appsets.list.request",
  "argocd.projects.list.request",
  "argocd.repos.list.request",
  "argocd.clusters.list.request",
  "argocd.cluster_links.list.request",
  "argocd.cluster_links.set.request",
  "argocd.cluster_links.resolve.request",
] as const satisfies readonly SessionInboundMessage["type"][];

export class ArgoCdSession {
  private readonly appsListeners = new Map<string, AppsListener>();
  private readonly appWatches = new Map<string, () => void>();
  private readonly logStreams = new Map<string, () => void>();
  private readonly unsubscribeInstances: (() => void) | null;
  private unregisterDelegate: (() => void) | null = null;

  constructor(private readonly options: ArgoCdSessionOptions) {
    const service = options.service;
    this.unsubscribeInstances = service
      ? service.onInstanceChanged((instance) =>
          this.emit({ type: "argocd.instances.changed", payload: { instance } }),
        )
      : null;
    this.syncDelegateRegistration();
  }

  /** Re-evaluated whenever the client re-sends its capabilities. */
  syncDelegateRegistration(): void {
    const service = this.options.service;
    if (!service) return;
    const wanted = this.options.canRunSsoLoopback();
    if (wanted && !this.unregisterDelegate) {
      this.unregisterDelegate = service.registerSsoDelegate(this.options.sessionKey, {
        notify: (payload) => this.emit({ type: "argocd.sso.delegate_requested", payload }),
      });
    } else if (!wanted && this.unregisterDelegate) {
      this.unregisterDelegate();
      this.unregisterDelegate = null;
    }
  }

  dispose(): void {
    const service = this.options.service;
    this.unsubscribeInstances?.();
    this.unregisterDelegate?.();
    this.unregisterDelegate = null;
    if (service) {
      for (const [instanceId, listener] of this.appsListeners) {
        service.unsubscribeApps(instanceId, listener);
      }
    }
    this.appsListeners.clear();
    for (const close of this.appWatches.values()) close();
    this.appWatches.clear();
    for (const close of this.logStreams.values()) close();
    this.logStreams.clear();
  }

  // oxlint-disable-next-line complexity
  handle(msg: SessionInboundMessage): Promise<void> | undefined {
    switch (msg.type) {
      case "argocd.instances.list.request":
        return this.respond(
          "argocd.instances.list.response",
          msg.requestId,
          { instances: [] },
          async (s) => ({
            instances: s.listInstances(),
          }),
        );
      case "argocd.instances.save.request":
        return this.respond(
          "argocd.instances.save.response",
          msg.requestId,
          { instance: null },
          async (s) => ({
            instance: await s.saveInstance(msg.instance),
          }),
        );
      case "argocd.instances.delete.request":
        return this.respond("argocd.instances.delete.response", msg.requestId, {}, async (s) => {
          await s.deleteInstance(msg.id);
          return {};
        });
      case "argocd.instances.login.request":
        return this.respond(
          "argocd.instances.login.response",
          msg.requestId,
          { instance: null },
          async (s) => ({
            instance: await s.login(msg.id, { password: msg.password, token: msg.token }),
          }),
        );
      case "argocd.instances.logout.request":
        return this.respond(
          "argocd.instances.logout.response",
          msg.requestId,
          { instance: null },
          async (s) => ({
            instance: await s.logout(msg.id),
          }),
        );
      case "argocd.sso.begin.request":
        return this.respond(
          "argocd.sso.begin.response",
          msg.requestId,
          { authUrl: null, state: null, redirectUri: null, expiresAt_ms: null },
          async (s) => {
            const begun = await s.ssoBegin(msg.id);
            return {
              authUrl: begun.authUrl,
              state: begun.state,
              redirectUri: begun.redirectUri,
              expiresAt_ms: begun.expiresAtMs,
            };
          },
        );
      case "argocd.sso.complete.request":
        return this.respond(
          "argocd.sso.complete.response",
          msg.requestId,
          { instance: null },
          async (s) => ({
            instance: await s.ssoComplete(msg.id, {
              state: msg.state,
              code: msg.code,
              error: msg.error,
              errorDescription: msg.errorDescription,
              errorCode: msg.errorCode,
            }),
          }),
        );
      case "argocd.sso.delegate.request":
        return this.respond(
          "argocd.sso.delegate.response",
          msg.requestId,
          { desktops: 0 },
          async (s) => ({
            desktops: s.ssoDelegate(msg.id),
          }),
        );
      case "argocd.apps.list.request":
        return this.respond(
          "argocd.apps.list.response",
          msg.requestId,
          { apps: [] },
          async (s) => ({
            apps: await s.listApps(msg.instanceId),
          }),
        );
      case "argocd.apps.subscribe.request":
        return this.subscribeApps(msg);
      case "argocd.apps.unsubscribe.request":
        return this.respond("argocd.apps.unsubscribe.response", msg.requestId, {}, async (s) => {
          const listener = this.appsListeners.get(msg.instanceId);
          if (listener) s.unsubscribeApps(msg.instanceId, listener);
          this.appsListeners.delete(msg.instanceId);
          return {};
        });
      case "argocd.app.get.request":
        return this.respond("argocd.app.get.response", msg.requestId, { app: null }, async (s) => ({
          app: await s.getApp(msg.instanceId, msg.app),
        }));
      case "argocd.app.tree.subscribe.request":
        return this.subscribeTree(msg);
      case "argocd.app.tree.unsubscribe.request":
        return this.respond("argocd.app.tree.unsubscribe.response", msg.requestId, {}, async () => {
          this.appWatches.get(msg.subscriptionId)?.();
          this.appWatches.delete(msg.subscriptionId);
          return {};
        });
      case "argocd.app.diff.request":
        return this.respond(
          "argocd.app.diff.response",
          msg.requestId,
          { items: [] },
          async (s) => ({
            items: await s.diff(msg.instanceId, msg.app),
          }),
        );
      case "argocd.app.manifests.request":
        return this.respond(
          "argocd.app.manifests.response",
          msg.requestId,
          { manifests: [] },
          async (s) => ({
            manifests: await s.manifests(msg.instanceId, msg.app, {
              resource: msg.resource,
              revision: msg.revision,
            }),
          }),
        );
      case "argocd.app.events.request":
        return this.respond(
          "argocd.app.events.response",
          msg.requestId,
          { events: [] },
          async (s) => ({
            events: await s.events(msg.instanceId, msg.app, msg.resource),
          }),
        );
      case "argocd.app.logs.subscribe.request":
        return this.subscribeLogs(msg);
      case "argocd.app.logs.unsubscribe.request":
        return this.respond("argocd.app.logs.unsubscribe.response", msg.requestId, {}, async () => {
          this.logStreams.get(msg.subscriptionId)?.();
          this.logStreams.delete(msg.subscriptionId);
          return {};
        });
      case "argocd.app.sync.request":
        return this.respond(
          "argocd.app.sync.response",
          msg.requestId,
          { app: null },
          async (s) => ({
            app: await s.sync(msg.instanceId, msg.app, msg.options),
          }),
        );
      case "argocd.app.refresh.request":
        return this.respond(
          "argocd.app.refresh.response",
          msg.requestId,
          { app: null },
          async (s) => ({
            app: await s.refresh(msg.instanceId, msg.app, msg.hard),
          }),
        );
      case "argocd.app.rollback.request":
        return this.respond(
          "argocd.app.rollback.response",
          msg.requestId,
          { app: null },
          async (s) => ({
            app: await s.rollback(msg.instanceId, msg.app, {
              historyId: msg.historyId,
              prune: msg.prune,
              dryRun: msg.dryRun,
            }),
          }),
        );
      case "argocd.app.terminate.request":
        return this.respond("argocd.app.terminate.response", msg.requestId, {}, async (s) => {
          await s.terminate(msg.instanceId, msg.app);
          return {};
        });
      case "argocd.app.delete.request":
        return this.respond("argocd.app.delete.response", msg.requestId, {}, async (s) => {
          await s.deleteApp(msg.instanceId, msg.app, {
            confirmName: msg.confirmName,
            cascade: msg.cascade,
            propagationPolicy: msg.propagationPolicy,
          });
          return {};
        });
      case "argocd.app.set_auto_sync.request":
        return this.respond(
          "argocd.app.set_auto_sync.response",
          msg.requestId,
          { app: null },
          async (s) => ({
            app: await s.setAutoSync(msg.instanceId, msg.app, {
              enabled: msg.enabled,
              prune: msg.prune,
              selfHeal: msg.selfHeal,
            }),
          }),
        );
      case "argocd.app.confirm_pruning.request":
        return this.respond("argocd.app.confirm_pruning.response", msg.requestId, {}, async (s) => {
          await s.confirmPruning(msg.instanceId, msg.app);
          return {};
        });
      case "argocd.app.resource_actions.list.request":
        return this.respond(
          "argocd.app.resource_actions.list.response",
          msg.requestId,
          { actions: [] },
          async (s) => ({
            actions: await s.resourceActions(msg.instanceId, msg.app, msg.resource),
          }),
        );
      case "argocd.app.resource_action.request":
        return this.respond("argocd.app.resource_action.response", msg.requestId, {}, async (s) => {
          await s.runResourceAction(msg.instanceId, msg.app, {
            resource: msg.resource,
            action: msg.action,
            params: msg.params,
          });
          return {};
        });
      case "argocd.can_i.request":
        return this.respond(
          "argocd.can_i.response",
          msg.requestId,
          { allowed: false },
          async (s) => ({
            allowed: await s.canI(msg.instanceId, {
              resource: msg.resource,
              action: msg.action,
              subresource: msg.subresource,
            }),
          }),
        );
      case "argocd.appsets.list.request":
        return this.respond(
          "argocd.appsets.list.response",
          msg.requestId,
          { appsets: [] },
          async (s) => ({
            appsets: await s.listAppSets(msg.instanceId),
          }),
        );
      case "argocd.projects.list.request":
        return this.respond(
          "argocd.projects.list.response",
          msg.requestId,
          { projects: [] },
          async (s) => ({
            projects: await s.listProjects(msg.instanceId),
          }),
        );
      case "argocd.repos.list.request":
        return this.respond(
          "argocd.repos.list.response",
          msg.requestId,
          { repos: [] },
          async (s) => ({
            repos: await s.listRepos(msg.instanceId),
          }),
        );
      case "argocd.clusters.list.request":
        return this.respond(
          "argocd.clusters.list.response",
          msg.requestId,
          { clusters: [] },
          async (s) => ({
            clusters: await s.listClusters(msg.instanceId),
          }),
        );
      case "argocd.cluster_links.list.request":
        return this.respond(
          "argocd.cluster_links.list.response",
          msg.requestId,
          { links: [] },
          async (s) => ({
            links: s.listLinks(msg.instanceId),
          }),
        );
      case "argocd.cluster_links.set.request":
        return this.respond(
          "argocd.cluster_links.set.response",
          msg.requestId,
          { link: null },
          async (s) => ({
            link: await s.setLink(msg.instanceId, msg.destination, msg.clusterId),
          }),
        );
      case "argocd.cluster_links.resolve.request":
        return this.respond(
          "argocd.cluster_links.resolve.response",
          msg.requestId,
          { link: null, clusterConnected: false },
          async (s) => s.resolveLink(msg.instanceId, msg.app),
        );
      default:
        return undefined;
    }
  }

  private subscribeApps(msg: Inbound<"argocd.apps.subscribe.request">): Promise<void> {
    return this.respond(
      "argocd.apps.subscribe.response",
      msg.requestId,
      { apps: [] },
      async (s) => {
        const previous = this.appsListeners.get(msg.instanceId);
        if (previous) s.unsubscribeApps(msg.instanceId, previous);
        const listener: AppsListener = (change) =>
          this.emit({
            type: "argocd.apps.changed",
            payload: { instanceId: msg.instanceId, ...change },
          });
        this.appsListeners.set(msg.instanceId, listener);
        try {
          return { apps: await s.subscribeApps(msg.instanceId, listener) };
        } catch (error) {
          this.appsListeners.delete(msg.instanceId);
          throw error;
        }
      },
    );
  }

  private subscribeTree(msg: Inbound<"argocd.app.tree.subscribe.request">): Promise<void> {
    return this.respond(
      "argocd.app.tree.subscribe.response",
      msg.requestId,
      { subscriptionId: msg.subscriptionId, app: null, tree: null },
      async (s) => {
        this.appWatches.get(msg.subscriptionId)?.();
        const subscriptionId = msg.subscriptionId;
        const watch = await s.watchApp(msg.instanceId, msg.app, {
          onApp: (app) =>
            this.emit({ type: "argocd.app.changed", payload: { subscriptionId, app } }),
          onTree: (tree) =>
            this.emit({ type: "argocd.app.tree.changed", payload: { subscriptionId, tree } }),
        });
        this.appWatches.set(subscriptionId, watch.close);
        return { subscriptionId, app: watch.app, tree: watch.tree };
      },
    );
  }

  private subscribeLogs(msg: Inbound<"argocd.app.logs.subscribe.request">): Promise<void> {
    return this.respond(
      "argocd.app.logs.subscribe.response",
      msg.requestId,
      { subscriptionId: msg.subscriptionId },
      async (s) => {
        this.logStreams.get(msg.subscriptionId)?.();
        const subscriptionId = msg.subscriptionId;
        const handle = await s.streamLogs(
          msg.instanceId,
          msg.app,
          {
            podName: msg.podName,
            resource: msg.resource,
            namespace: msg.namespace,
            container: msg.container,
            tailLines: msg.tailLines,
            sinceSeconds: msg.sinceSeconds,
            follow: msg.follow,
            filter: msg.filter,
            previous: msg.previous,
          },
          (chunk) => {
            this.emit({ type: "argocd.app.logs.chunk", payload: { subscriptionId, ...chunk } });
            if (chunk.last) this.logStreams.delete(subscriptionId);
          },
        );
        this.logStreams.set(subscriptionId, () => handle.close());
        return { subscriptionId };
      },
    );
  }

  private async respond<T extends ResponseType>(
    type: T,
    requestId: string,
    empty: ResponseData<T>,
    work: (service: ArgoCdService) => Promise<ResponseData<T>>,
  ): Promise<void> {
    let data = empty;
    let failure: ArgoCdError | null = null;
    try {
      const service = this.options.service;
      if (!service) throw new ArgoCdError("argocd_error", "Argo CD is not available on this host.");
      data = await work(service);
    } catch (error) {
      failure = toArgoCdError(error);
      this.options.logger.warn(
        { type, code: failure.code, err: failure.message },
        "Argo CD request failed",
      );
    }
    // The generic payload is assembled from the response's own data type; TypeScript cannot
    // correlate a generic `T` with its union member, so the message is asserted once here.
    this.emit({
      type,
      payload: {
        requestId,
        error: failure?.message ?? null,
        errorCode: failure?.code ?? null,
        ...data,
      },
    } as ResponseMessage<T>);
  }

  private emit(msg: SessionOutboundMessage): void {
    this.options.host.emit(msg);
  }
}
