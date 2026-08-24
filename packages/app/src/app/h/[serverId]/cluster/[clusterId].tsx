import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ClusterWorkloadsScreen } from "@/screens/cluster-workloads-screen";

export default function HostClusterWorkloadsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostClusterWorkloadsRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostClusterWorkloadsRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string; clusterId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const clusterId = typeof params.clusterId === "string" ? params.clusterId : "";
  return <ClusterWorkloadsScreen serverId={serverId} clusterId={clusterId} />;
}

export { ErrorBoundary } from "expo-router";
