import type {
  BuiltinSessionContribution,
  BuiltinSessionServices,
  SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { ClusterSession } from "./cluster-session.js";

export const CLUSTER_RPC_METHODS = [
  "cluster/contexts",
  "cluster/import",
  "cluster/list",
  "cluster/connect",
  "cluster/disconnect",
  "cluster/resources",
  "cluster/get",
  "cluster/logs",
  "cluster/logs/subscribe",
  "cluster/logs/unsubscribe",
  "cluster/write",
  "cluster/kinds",
  "cluster/resource/list",
  "cluster/reveal-secret",
  "cluster/node-op",
  "cluster/cronjob-op",
  "cluster/metrics",
  "cluster/helm/list",
  "cluster/helm/history",
  "cluster/helm/values",
  "cluster/helm/rollback",
  "cluster/helm/uninstall",
  "cluster/exec/start",
  "cluster/exec/stdin",
  "cluster/exec/close",
  "cluster/pf/start",
  "cluster/pf/stdin",
  "cluster/pf/close",
] as const;

type ClusterRpcMethod = (typeof CLUSTER_RPC_METHODS)[number];
// Exec and port-forward payloads predate the inbound schema union; handlers own their shapes.
type ClusterHandler = (rpc: ClusterRpc, msg: { id: string }) => Promise<void>;
const HANDLERS: Record<ClusterRpcMethod, ClusterHandler> = {
  "cluster/contexts": (rpc, msg) => rpc.session.handleContextsRequest(msg as never),
  "cluster/import": (rpc, msg) => rpc.session.handleImportRequest(msg as never),
  "cluster/list": (rpc, msg) => rpc.session.handleListRequest(msg as never),
  "cluster/connect": (rpc, msg) =>
    rpc.activateRemoteCluster(msg.id).then(() => rpc.session.handleConnectRequest(msg as never)),
  "cluster/disconnect": (rpc, msg) => rpc.session.handleDisconnectRequest(msg as never),
  "cluster/resources": (rpc, msg) => rpc.session.handleResourcesRequest(msg as never),
  "cluster/get": (rpc, msg) => rpc.session.handleGetRequest(msg as never),
  "cluster/logs": (rpc, msg) => rpc.session.handleLogsRequest(msg as never),
  "cluster/logs/subscribe": (rpc, msg) => rpc.session.handleLogsSubscribeRequest(msg as never),
  "cluster/logs/unsubscribe": (rpc, msg) => rpc.session.handleLogsUnsubscribeRequest(msg as never),
  "cluster/write": (rpc, msg) => rpc.session.handleWriteRequest(msg as never),
  "cluster/kinds": (rpc, msg) => rpc.session.handleClusterKinds(msg as never),
  "cluster/resource/list": (rpc, msg) => rpc.session.handleClusterResourceList(msg as never),
  "cluster/reveal-secret": (rpc, msg) => rpc.session.handleRevealSecretRequest(msg as never),
  "cluster/node-op": (rpc, msg) => rpc.session.handleNodeOpRequest(msg as never),
  "cluster/cronjob-op": (rpc, msg) => rpc.session.handleCronjobOpRequest(msg as never),
  "cluster/metrics": (rpc, msg) => rpc.session.handleClusterMetrics(msg as never),
  "cluster/helm/list": (rpc, msg) => rpc.session.handleHelmListRequest(msg as never),
  "cluster/helm/history": (rpc, msg) => rpc.session.handleHelmHistoryRequest(msg as never),
  "cluster/helm/values": (rpc, msg) => rpc.session.handleHelmValuesRequest(msg as never),
  "cluster/helm/rollback": (rpc, msg) => rpc.session.handleHelmRollbackRequest(msg as never),
  "cluster/helm/uninstall": (rpc, msg) => rpc.session.handleHelmUninstallRequest(msg as never),
  "cluster/exec/start": (rpc, msg) => rpc.session.handleExecStart(msg as never),
  "cluster/exec/stdin": (rpc, msg) => rpc.session.handleExecStdin(msg as never),
  "cluster/exec/close": (rpc, msg) => rpc.session.handleExecClose(msg as never),
  "cluster/pf/start": (rpc, msg) => rpc.session.handlePfStart(msg as never),
  "cluster/pf/stdin": (rpc, msg) => rpc.session.handlePfStdin(msg as never),
  "cluster/pf/close": (rpc, msg) => rpc.session.handlePfClose(msg as never),
};

/** The `cluster/*` RPC surface for one client session. */
export class ClusterRpc implements BuiltinSessionContribution {
  readonly session: ClusterSession;
  constructor(private readonly host: BuiltinSessionServices) {
    this.session = new ClusterSession({
      host: { emit: (msg) => host.push(msg) },
      clusterRegistry: host.clusters,
      logger: host.logger,
    });
  }
  /** Closes log streams, exec shells and port-forwards; the session stays reusable. */
  stop() {
    this.session.dispose();
  }
  handle(msg: SessionInboundMessage): Promise<void> | undefined {
    const handler = HANDLERS[msg.type as ClusterRpcMethod] as ClusterHandler | undefined;
    return handler?.(this, msg as unknown as { id: string });
  }

  // A cluster imported through an SSH server needs its forward + kubeconfig before KubeClient
  // connects (ssh/remote-k8s); failures surface through the normal connect response.
  async activateRemoteCluster(clusterId: string): Promise<void> {
    const k8s = this.host.remoteK8s();
    const cluster = this.host.clusters.list().find((candidate) => candidate.id === clusterId);
    if (!k8s || !cluster || !k8s.isRemoteContext(cluster.contextName)) return;
    await k8s.activate(cluster.contextName).catch((error: unknown) => {
      this.host.logger.warn({ err: error, clusterId }, "remote cluster activation failed");
    });
  }
}
