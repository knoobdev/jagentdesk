import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";
export default function HostDockerRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="docker" serverId={serverId} /> : null;
}
export { ErrorBoundary } from "expo-router";
