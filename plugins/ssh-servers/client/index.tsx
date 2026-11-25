import { Server } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { SidebarServersNav } from "./ui/sidebar-servers-nav";
import { ServersScreen } from "./screen";
import { SshRunCard } from "./ssh-run/ssh-run-card";
import { readSshRunToolResult, type SshRunToolResult } from "./ssh-run/ssh-run-detection";
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
  // ADR-0045 §7: an ssh_run result renders as its own card in the chat.
  app.toolCallRenderer<SshRunToolResult>("ssh-run", {
    placements: ["inline"],
    match: readSshRunToolResult,
    Card: ({ client, match }) => <SshRunCard client={client} result={match} />,
  });
}
