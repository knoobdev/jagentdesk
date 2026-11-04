import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { ArgoCdAppDetailScreen } from "@/argocd/app-detail-screen";

export default function HostArgoCdAppRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostArgoCdAppRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostArgoCdAppRouteContent() {
  const params = useLocalSearchParams<{
    serverId?: string;
    instanceId?: string;
    name?: string;
    ns?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const instanceId = typeof params.instanceId === "string" ? params.instanceId : "";
  const name = typeof params.name === "string" ? params.name : "";
  const appNamespace = typeof params.ns === "string" && params.ns ? params.ns : null;
  return (
    <ArgoCdAppDetailScreen
      key={`${instanceId}/${appNamespace ?? ""}/${name}`}
      serverId={serverId}
      instanceId={instanceId}
      name={name}
      appNamespace={appNamespace}
    />
  );
}

export { ErrorBoundary } from "expo-router";
