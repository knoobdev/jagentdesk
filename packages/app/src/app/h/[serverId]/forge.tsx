import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";

export default function HostForgeRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="forge" serverId={serverId} /> : null;
}

export { ErrorBoundary } from "expo-router";
