import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { BuiltinScreen } from "@/plugins/builtin/surfaces";

export default function HostArgoCdInstanceRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostArgoCdInstanceRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostArgoCdInstanceRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  return <BuiltinScreen segment="argocd/instance" serverId={serverId} />;
}

export { ErrorBoundary } from "expo-router";
