import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ArgoCdAppsScreen } from "@/argocd/apps-screen";

export default function HostArgoCdInstanceRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostArgoCdInstanceRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostArgoCdInstanceRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string; instanceId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const instanceId = typeof params.instanceId === "string" ? params.instanceId : "";
  return <ArgoCdAppsScreen key={instanceId} serverId={serverId} instanceId={instanceId} />;
}

export { ErrorBoundary } from "expo-router";
