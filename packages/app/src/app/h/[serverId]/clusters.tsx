import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";

export default function HostClustersRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="clusters" serverId={serverId} /> : null;
}

export { ErrorBoundary } from "expo-router";
