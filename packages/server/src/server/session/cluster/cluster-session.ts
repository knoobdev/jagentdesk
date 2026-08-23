import type pino from "pino";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ClusterRegistry } from "../../cluster/cluster-registry.js";
import { detectKubeContexts } from "../../cluster/kube-config-source.js";
import { GENERIC_KINDS } from "../../cluster/kube-client.js";

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

  constructor(options: ClusterSessionOptions) {
    this.host = options.host;
    this.clusterRegistry = options.clusterRegistry;
    this.logger = options.logger;
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
}
