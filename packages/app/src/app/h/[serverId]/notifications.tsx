import { useHostRouteServerId } from "@/navigation/host-route-context";
import { NotificationFeedScreen } from "@/notification-feed/page";

export default function HostNotificationsRoute() {
  const serverId = useHostRouteServerId();
  return serverId ? <NotificationFeedScreen serverId={serverId} /> : null;
}

export { ErrorBoundary } from "expo-router";
