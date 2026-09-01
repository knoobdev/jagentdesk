import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { DatabaseBrowseScreen } from "@/screens/database-browse-screen";

export default function HostDatabaseBrowseRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostDatabaseBrowseRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function HostDatabaseBrowseRouteContent() {
  const params = useLocalSearchParams<{ serverId?: string; databaseId?: string }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const databaseId = typeof params.databaseId === "string" ? params.databaseId : "";
  return <DatabaseBrowseScreen serverId={serverId} databaseId={databaseId} />;
}

export { ErrorBoundary } from "expo-router";
