import { GitPullRequest } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { ForgeHubScreen } from "./forge-hub-screen";

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "forge",
    title: "Forge",
    icon: GitPullRequest,
    group: "Tools" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/forge`,
    routeSegment: "forge",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.screen("forge", ForgeHubScreen);
}
