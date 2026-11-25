import { Radar } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { ProxyScreen } from "./proxy-screen";

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "workbench",
    title: "Workbench",
    shortTitle: "WB",
    icon: Radar,
    group: "Tools" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/proxy`,
    routeSegment: "proxy",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.screen("proxy", ProxyScreen);
}
