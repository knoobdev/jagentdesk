import { useIsFocused } from "expo-router/react-navigation";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { BuiltinScreen } from "@/plugins/builtin/surfaces";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

// The screen lists every host's shares; the selected (or first) host's plugin state gates it.
export default function SharedSessionsRoute() {
  const hosts = useHosts();
  const selection = useActiveWorkspaceSelection();
  const focused = useIsFocused();
  const host = hosts.find((entry) => entry.serverId === selection?.serverId) ?? hosts[0];
  return (
    <HostRouteBootstrapBoundary>
      <BuiltinScreen segment="shared-sessions" serverId={host?.serverId ?? ""} focused={focused} />
    </HostRouteBootstrapBoundary>
  );
}
