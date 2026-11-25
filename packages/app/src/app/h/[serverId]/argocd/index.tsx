import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { BuiltinScreen } from "@/plugins/builtin/surfaces";

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
  return <BuiltinScreen segment="argocd" serverId={serverId} />;
}

export { ErrorBoundary } from "expo-router";
