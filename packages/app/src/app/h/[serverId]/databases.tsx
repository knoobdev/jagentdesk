import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";

export default function HostDatabasesRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="databases" serverId={serverId} /> : null;
}

export { ErrorBoundary } from "expo-router";
