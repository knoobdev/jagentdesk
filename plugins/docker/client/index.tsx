import { Container } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { DockerSidebar } from "./sidebar";
import { DockerScreen } from "./screen";
export function register(app: BuiltinClientHost) {
  const destination = {
    id: "docker",
    title: "Docker",
    icon: Container,
    group: "Tools" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/docker`,
    routeSegment: "docker",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.leftPanel("docker", DockerSidebar);
  app.screen("docker", ({ serverId, sshDocker }) => (
    <DockerScreen hostServerId={serverId} sshDocker={sshDocker} />
  ));
}
