import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";
export default function HostServersRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="servers" serverId={serverId} /> : null;
}
export { ErrorBoundary } from "expo-router";
