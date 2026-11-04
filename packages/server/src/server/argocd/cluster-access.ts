import { loadYaml } from "@kubernetes/client-node";
import type { ClusterRegistry } from "../cluster/cluster-registry.js";
import { detectKubeContexts } from "../cluster/kube-config-source.js";
import type { ArgoCdClusterAccess } from "./service.js";

/** The Clusters feature as seen by Argo CD link resolution (spec 30.3 "Nối Clusters"). */
export function createArgoCdClusterAccess(registry: ClusterRegistry): ArgoCdClusterAccess {
  return {
    async list() {
      const contexts = await detectKubeContexts();
      const serverByContext = new Map(contexts.map((context) => [context.name, context.server]));
      return registry.list().map((cluster) => ({
        clusterId: cluster.id,
        server: serverByContext.get(cluster.contextName) ?? null,
        connected: cluster.state === "connected" && registry.getClient(cluster.id) !== undefined,
      }));
    },
    async resourceUid(clusterId, resource) {
      const client = registry.getClient(clusterId);
      if (!client) return null;
      try {
        const yaml = await client.getGeneric(resource.kind, resource.namespace, resource.name);
        const object = loadYaml<{ metadata?: { uid?: unknown } }>(yaml);
        return typeof object.metadata?.uid === "string" ? object.metadata.uid : null;
      } catch {
        // Absent on this cluster (404) or a kind the cluster does not serve: not this cluster.
        return null;
      }
    },
  };
}
