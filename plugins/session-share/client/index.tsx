import { Share2 } from "lucide-react-native";
import {
  useGumloopDesktopShell,
  useHostFeature,
  useSessionStore,
  type BuiltinAgentProps,
  type BuiltinClientHost,
  type BuiltinClientProps,
} from "../../../packages/app/src/plugins/builtin/host-api";
import { SharedSessionsScreen } from "./screen";
import { SessionShareOptInCard } from "./settings-card";
import { SessionShareControl } from "./share-control";

// The agent chat header carries the share control except in the Gumloop desktop shell, where the
// workspace header shows it for the focused agent.
function AgentHeaderShare(props: BuiltinAgentProps) {
  const gumloop = useGumloopDesktopShell(true);
  return gumloop ? null : <SessionShareControl {...props} />;
}

function GumloopHeaderShare({ serverId }: BuiltinClientProps) {
  const gumloop = useGumloopDesktopShell(true);
  const agentId = useSessionStore((state) => state.sessions[serverId]?.focusedAgentId);
  if (!gumloop || !agentId) return null;
  return <SessionShareControl serverId={serverId} agentId={agentId} />;
}

// The opt-in card serves daemons older than built-in plugin state; newer hosts turn the
// feature on in Settings → Plugins.
// COMPAT(builtinPlugins): added in v0.9.59; remove after 2027-05-24 once daemon floor supports feature gates.
function LegacySessionShareOptInCard({ serverId }: BuiltinClientProps) {
  return useHostFeature(serverId, "builtinPlugins") ? null : (
    <SessionShareOptInCard serverId={serverId} />
  );
}

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "shared-sessions",
    title: "Shared sessions",
    shortTitle: "Shared",
    icon: Share2,
    // Not a primary destination: the Gumloop sidebar lists it under Tools, as before.
    group: "Tools" as const,
    route: () => "/shared-sessions",
    routeSegment: "shared-sessions",
    before: "skills",
    sidebarTestID: "sidebar-shared-sessions",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.screen("shared-sessions", ({ focused }) => <SharedSessionsScreen focused={focused} />);
  app.agentHeaderControl("session-share", AgentHeaderShare);
  app.workspaceHeaderControl("session-share", GumloopHeaderShare);
  app.agentSettingsCard("session-share-opt-in", LegacySessionShareOptInCard, 30);
}
