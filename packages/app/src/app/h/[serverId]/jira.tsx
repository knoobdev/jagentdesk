import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";
export default function HostJiraRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="jira" serverId={serverId} /> : null;
}
export { ErrorBoundary } from "expo-router";
