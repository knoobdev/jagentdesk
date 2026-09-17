import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { AgentForumScreen } from "@/screens/agent-forum-screen";

export default function AgentForumRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <AgentForumScreen />
    </HostRouteBootstrapBoundary>
  );
}
