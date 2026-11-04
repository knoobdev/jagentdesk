import { router } from "expo-router";
import { useClusterNavStore } from "@/stores/cluster-nav-store";
import { useClusterViewStore } from "@/stores/cluster-view-store";
import { buildClusterWorkloadsRoute } from "@/utils/host-routes";

// "Open in Clusters" (spec 30.3, criterion 8): the linked JAgentDesk cluster opens with the
// resource's kind and namespace selected and the resource's detail tab open. Both cluster
// stores only reset for a *different* cluster, so selecting before navigating survives the
// workloads screen and the cluster sidebar mounting.
export function openResourceInClusters(input: {
  serverId: string;
  clusterId: string;
  kind: string;
  namespace: string;
  name: string;
}): void {
  const namespace = input.namespace || undefined;
  const nav = useClusterNavStore.getState();
  nav.selectKind(input.clusterId, input.kind);
  nav.setNamespace(namespace);
  useClusterViewStore
    .getState()
    .openDetail(input.clusterId, { kind: input.kind, namespace, name: input.name });
  router.push(buildClusterWorkloadsRoute(input.serverId, input.clusterId));
}
