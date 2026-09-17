import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { SharedSessionsScreen } from "@/screens/shared-sessions-screen";

export default function SharedSessionsRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <SharedSessionsScreen />
    </HostRouteBootstrapBoundary>
  );
}
