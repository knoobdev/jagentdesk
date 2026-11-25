import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";

export default function HostSimulatorRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="simulator" serverId={serverId} /> : null;
}

export { ErrorBoundary } from "expo-router";
