import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ArgoCdInstancesScreen } from "@/argocd/instances-screen";

export default function HostArgoCdRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostArgoCdRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostArgoCdRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  return <ArgoCdInstancesScreen serverId={serverId} />;
}

export { ErrorBoundary } from "expo-router";
