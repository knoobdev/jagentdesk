import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ClusterRegistry } from "../../cluster/cluster-registry.js";
import { detectKubeContexts } from "../../cluster/kube-config-source.js";
import { GENERIC_KINDS } from "../../cluster/kube-client.js";
import {
  helmList,
  helmHistory,
  helmValues,
  helmRollback,
  helmUninstall,
} from "../../cluster/helm-client.js";

export interface ClusterSessionHost {
  emit(msg: SessionOutboundMessage): void;
}

export interface ClusterSessionOptions {
  host: ClusterSessionHost;
  clusterRegistry: ClusterRegistry;
  logger: pino.Logger;
}

export class ClusterSession {
  private readonly host: ClusterSessionHost;
  private readonly clusterRegistry: ClusterRegistry;
  private readonly logger: pino.Logger;
  private readonly logSubscriptions = new Map<string, () => void>();
  private readonly execSessions = new Map<
    string,
    { write: (d: string) => void; close: () => void }
  >();
  private readonly pfSessions = new Map<
    string,
    { write: (d: Buffer) => void; close: () => void }
  >();

  constructor(options: ClusterSessionOptions) {
    this.host = options.host;
    this.clusterRegistry = options.clusterRegistry;
    this.logger = options.logger;
  }

  dispose(): void {
    for (const stop of this.logSubscriptions.values()) {
      try {
        stop();
      } catch {
        // best-effort teardown
      }
    }
    this.logSubscriptions.clear();
    for (const exec of this.execSessions.values()) {
      try {
        exec.close();
      } catch {
        // best-effort teardown
      }
    }
    this.execSessions.clear();
    for (const pf of this.pfSessions.values()) {
      try {
        pf.close();
      } catch {
        // best-effort teardown
      }
    }
    this.pfSessions.clear();
  }

  private emitClusterRpcError(request: { requestId: string; type: string }, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ err: error, requestType: request.type }, "Cluster request failed");
    this.host.emit({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: request.type,
        error: message,
        code: "cluster_request_failed",
      },
    });
  }

  async handleContextsRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/contexts" }>,
  ): Promise<void> {
    try {
      const contexts = await detectKubeContexts();
      this.host.emit({
        type: "cluster/contexts/response",
        payload: {
          requestId: request.requestId,
          contexts,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleImportRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/import" }>,
  ): Promise<void> {
    try {
      let clusters;
      if (request.kubeconfigYaml) {
        clusters = this.clusterRegistry.importKubeconfigString(
          request.kubeconfigYaml,
          request.displayName,
        );
      } else {
        clusters = [
          this.clusterRegistry.importContext(request.contextName ?? "default", request.displayName),
        ];
      }
      this.host.emit({
        type: "cluster/import/response",
        payload: {
          requestId: request.requestId,
          clusters,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleListRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/list" }>,
  ): Promise<void> {
    try {
      const clusters = this.clusterRegistry.list();
      this.host.emit({
        type: "cluster/list/response",
        payload: {
          requestId: request.requestId,
          clusters,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleConnectRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/connect" }>,
  ): Promise<void> {
    try {
      const cluster = await this.clusterRegistry.connect(request.id);
      this.host.emit({
        type: "cluster/connect/response",
        payload: {
          requestId: request.requestId,
          cluster,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleDisconnectRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/disconnect" }>,
  ): Promise<void> {
    try {
      await this.clusterRegistry.disconnect(request.id);
      this.host.emit({
        type: "cluster/disconnect/response",
        payload: {
          requestId: request.requestId,
          ok: true,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleResourcesRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/resources" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      let items: unknown[];
      switch (request.kind) {
        case "pods":
          items = await client.listPods(request.namespace);
          break;
        case "deployments":
          items = await client.listDeployments(request.namespace);
          break;
        case "nodes":
          items = await client.listNodes();
          break;
        case "events":
          items = await client.listEvents(request.namespace);
          break;
      }
      this.host.emit({
        type: "cluster/resources/response",
        payload: {
          requestId: request.requestId,
          kind: request.kind,
          items,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleGetRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/get" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const yaml = await client.getResourceYaml(request.kind, request.namespace, request.name);
      this.host.emit({
        type: "cluster/get/response",
        payload: {
          requestId: request.requestId,
          yaml,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleLogsRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/logs" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const logs = await client.getPodLogs(request.namespace, request.pod, request.container);
      this.host.emit({
        type: "cluster/logs/response",
        payload: {
          requestId: request.requestId,
          logs,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleLogsSubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/logs/subscribe" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const stop = await client.streamPodLogs(
        request.namespace,
        request.pod,
        request.container,
        (chunk) => {
          this.host.emit({
            type: "cluster/logs/chunk",
            subscriptionId: request.subscriptionId,
            chunk,
          } as SessionOutboundMessage);
        },
      );
      this.logSubscriptions.set(request.subscriptionId, stop);
      this.host.emit({
        type: "cluster/logs/subscribe/response",
        payload: {
          requestId: request.requestId,
          subscriptionId: request.subscriptionId,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleLogsUnsubscribeRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/logs/unsubscribe" }>,
  ): Promise<void> {
    try {
      const stop = this.logSubscriptions.get(request.subscriptionId);
      if (stop) {
        stop();
        this.logSubscriptions.delete(request.subscriptionId);
      }
      this.host.emit({
        type: "cluster/logs/unsubscribe/response",
        payload: {
          requestId: request.requestId,
          ok: true,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleWriteRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/write" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const result = await client.applyWrite({
        kind: request.kind,
        namespace: request.namespace,
        name: request.name,
        action: request.action,
        replicas: request.replicas,
        manifestYaml: request.manifestYaml,
        dryRun: request.dryRun,
      });
      this.host.emit({
        type: "cluster/write/response",
        payload: {
          requestId: request.requestId,
          result,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleClusterKinds(
    request: Extract<SessionInboundMessage, { type: "cluster/kinds" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      const crds = client ? await client.discoverCRDs() : [];
      this.host.emit({
        type: "cluster/kinds/response",
        payload: {
          requestId: request.requestId,
          kinds: [...GENERIC_KINDS, ...crds],
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleClusterResourceList(
    request: Extract<SessionInboundMessage, { type: "cluster/resource/list" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const items = await client.listGeneric(request.kind, request.namespace);
      this.host.emit({
        type: "cluster/resource/list/response",
        payload: {
          requestId: request.requestId,
          kind: request.kind,
          items,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleRevealSecretRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/reveal-secret" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const data = await client.revealSecret(request.namespace, request.name);
      this.host.emit({
        type: "cluster/reveal-secret/response",
        payload: {
          requestId: request.requestId,
          data,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleNodeOpRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/node-op" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const result = await client.cordonNode(request.name, request.op === "cordon");
      this.host.emit({
        type: "cluster/node-op/response",
        payload: {
          requestId: request.requestId,
          result,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleCronjobOpRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/cronjob-op" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      let result;
      switch (request.op) {
        case "trigger":
          result = await client.triggerCronJob(request.namespace, request.name);
          break;
        case "suspend":
          result = await client.setCronJobSuspend(request.namespace, request.name, true);
          break;
        case "resume":
          result = await client.setCronJobSuspend(request.namespace, request.name, false);
          break;
      }
      this.host.emit({
        type: "cluster/cronjob-op/response",
        payload: {
          requestId: request.requestId,
          result,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleClusterMetrics(
    request: Extract<SessionInboundMessage, { type: "cluster/metrics" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      let items: unknown[];
      if (request.scope === "nodes") {
        items = await client.getNodeMetrics();
      } else {
        items = await client.getPodMetrics(request.namespace);
      }
      this.host.emit({
        type: "cluster/metrics/response",
        payload: {
          requestId: request.requestId,
          scope: request.scope,
          items,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleHelmListRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/helm/list" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const releases = await helmList(client.context);
      this.host.emit({
        type: "cluster/helm/list/response",
        payload: {
          requestId: request.requestId,
          releases,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleHelmHistoryRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/helm/history" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const revisions = await helmHistory(client.context, request.namespace, request.name);
      this.host.emit({
        type: "cluster/helm/history/response",
        payload: {
          requestId: request.requestId,
          revisions,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleHelmValuesRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/helm/values" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const values = await helmValues(client.context, request.namespace, request.name);
      this.host.emit({
        type: "cluster/helm/values/response",
        payload: {
          requestId: request.requestId,
          values,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleHelmRollbackRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/helm/rollback" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const result = await helmRollback(
        client.context,
        request.namespace,
        request.name,
        request.revision,
      );
      this.host.emit({
        type: "cluster/helm/rollback/response",
        payload: {
          requestId: request.requestId,
          result,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleHelmUninstallRequest(
    request: Extract<SessionInboundMessage, { type: "cluster/helm/uninstall" }>,
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const result = await helmUninstall(client.context, request.namespace, request.name);
      this.host.emit({
        type: "cluster/helm/uninstall/response",
        payload: {
          requestId: request.requestId,
          result,
          error: null,
        },
      });
    } catch (error) {
      this.emitClusterRpcError(request, error);
    }
  }

  async handleExecStart(
    request: Record<string, unknown> & { type: "cluster/exec/start" },
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id as string);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const { write, close } = await client.execInPod(
        request.namespace as string,
        request.pod as string,
        request.container as string | undefined,
        (request.command as string[]) ?? [],
        (data: string) => {
          this.host.emit({
            type: "cluster/exec/data",
            execId: request.execId,
            data,
          } as unknown as SessionOutboundMessage);
        },
      );
      this.execSessions.set(request.execId as string, { write, close });
      this.host.emit({
        type: "cluster/exec/start/response",
        payload: {
          requestId: request.requestId,
          execId: request.execId,
          error: null,
        },
      } as unknown as SessionOutboundMessage);
    } catch (error) {
      this.emitClusterRpcError(
        request as unknown as Parameters<typeof this.emitClusterRpcError>[0],
        error,
      );
    }
  }

  async handleExecStdin(
    request: Record<string, unknown> & { type: "cluster/exec/stdin" },
  ): Promise<void> {
    const session = this.execSessions.get(request.execId as string);
    if (session) {
      session.write(request.data as string);
    }
  }

  async handleExecClose(
    request: Record<string, unknown> & { type: "cluster/exec/close" },
  ): Promise<void> {
    const session = this.execSessions.get(request.execId as string);
    if (session) {
      session.close();
      this.execSessions.delete(request.execId as string);
    }
    this.host.emit({
      type: "cluster/exec/close/response",
      payload: {
        requestId: request.requestId,
        ok: true,
      },
    } as unknown as SessionOutboundMessage);
  }

  async handlePfStart(
    request: Record<string, unknown> & { type: "cluster/pf/start" },
  ): Promise<void> {
    try {
      const client = this.clusterRegistry.getClient(request.id as string);
      if (!client) {
        throw new Error(`cluster not connected: ${request.id}`);
      }
      const { write, close } = await client.startPortForward(
        request.namespace as string,
        request.pod as string,
        request.podPort as number,
        (chunk: Buffer) => {
          this.host.emit({
            type: "cluster/pf/data",
            pfId: request.pfId,
            data: chunk.toString("base64"),
          } as unknown as SessionOutboundMessage);
        },
      );
      this.pfSessions.set(request.pfId as string, { write, close });
      this.host.emit({
        type: "cluster/pf/start/response",
        payload: {
          requestId: request.requestId,
          pfId: request.pfId,
          error: null,
        },
      } as unknown as SessionOutboundMessage);
    } catch (error) {
      this.emitClusterRpcError(
        request as unknown as Parameters<typeof this.emitClusterRpcError>[0],
        error,
      );
    }
  }

  async handlePfStdin(
    request: Record<string, unknown> & { type: "cluster/pf/stdin" },
  ): Promise<void> {
    const session = this.pfSessions.get(request.pfId as string);
    if (session) {
      session.write(Buffer.from(request.data as string, "base64"));
    }
  }

  async handlePfClose(
    request: Record<string, unknown> & { type: "cluster/pf/close" },
  ): Promise<void> {
    const session = this.pfSessions.get(request.pfId as string);
    if (session) {
      session.close();
      this.pfSessions.delete(request.pfId as string);
    }
    this.host.emit({
      type: "cluster/pf/close/response",
      payload: {
        requestId: request.requestId,
        ok: true,
      },
    } as unknown as SessionOutboundMessage);
  }
}
