import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SharedSessionsScreen } from "@/screens/shared-sessions-screen";
import { BuiltinPluginScreenBoundary } from "@/plugins/builtin/route-boundary";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";

export default function SharedSessionsRoute() {
  const hosts = useHosts();
  const selection = useActiveWorkspaceSelection();
  const host = hosts.find((entry) => entry.serverId === selection?.serverId) ?? hosts[0];
  const screen = <SharedSessionsScreen />;
  return (
    <HostRouteBootstrapBoundary>
      {host ? (
        <BuiltinPluginScreenBoundary serverId={host.serverId} id="session-share">
          {screen}
        </BuiltinPluginScreenBoundary>
      ) : (
        screen
      )}
    </HostRouteBootstrapBoundary>
  );
}
