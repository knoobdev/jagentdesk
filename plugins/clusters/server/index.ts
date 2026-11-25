import type {
  BuiltinServerHost,
  SessionInboundMessage,
} from "../../../packages/server/src/server/plugins/builtin/host-api.js";
import { CLUSTER_RPC_METHODS, ClusterRpc } from "./session.js";
import { registerKubectlTools } from "./agent-tools.js";

export function register(host: BuiltinServerHost) {
  // Port-forward requests predate the inbound schema union; keep their exact wire names.
  host.rpc(
    "cluster/",
    CLUSTER_RPC_METHODS as readonly string[] as readonly SessionInboundMessage["type"][],
    (services) => new ClusterRpc(services),
  );
  // Turning the plugin off closes every connected cluster client; data stays on disk.
  host.backgroundService((services) => ({
    start: () => {},
    stop: async () => {
      await Promise.all(
        services.clusters.list().map((entry) => services.clusters.disconnect(entry.id)),
      );
    },
  }));
  host.agentTools((registerTool, context) => registerKubectlTools(registerTool, context));
}
