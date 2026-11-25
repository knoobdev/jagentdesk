import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHostRouteServerId } from "@/navigation/host-route-context";

export default function HostSkillsRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <BuiltinScreen segment="skills" serverId={serverId} /> : null;
}

export { ErrorBoundary } from "expo-router";
