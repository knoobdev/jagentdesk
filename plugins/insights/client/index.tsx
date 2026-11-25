import { BarChart3 } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { InsightsScreen } from "./screen";

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "insights",
    title: "Insights",
    icon: BarChart3,
    group: "main" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/insights`,
    routeSegment: "insights",
    before: "jira",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.screen("insights", InsightsScreen);
}
