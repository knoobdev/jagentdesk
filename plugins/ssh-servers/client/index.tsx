import { Server } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { SidebarServersNav } from "./ui/sidebar-servers-nav";
import { ServersScreen } from "./screen";
export function register(app: BuiltinClientHost) {
  const destination = {
    id: "servers",
    title: "Servers",
    icon: Server,
    group: "Tools" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/servers`,
    routeSegment: "servers",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.leftPanel("servers", SidebarServersNav);
  app.screen("servers", ({ serverId }) => <ServersScreen hostServerId={serverId} />);
}
