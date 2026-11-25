import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { BuiltinScreen } from "@/plugins/builtin/surfaces";

export default function HostClusterWorkloadsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostClusterWorkloadsRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostClusterWorkloadsRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  return <BuiltinScreen segment="cluster" serverId={serverId} />;
}

export { ErrorBoundary } from "expo-router";
