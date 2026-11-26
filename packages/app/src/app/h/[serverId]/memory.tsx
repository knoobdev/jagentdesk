import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";

export default function HostMemoryRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="memory" serverId={serverId} /> : null;
}

export { ErrorBoundary } from "expo-router";
