import { Sparkles } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { SkillsScreen } from "./screen";
import { SkillsControl } from "./skills-control";
import { SkillsSyncBinder } from "./skills-sync-binder";
import { AgentSkillTrainBar } from "./train-bar";
import { prepareTurnSkills } from "./turn-skills";

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "skills",
    title: "Skills",
    icon: Sparkles,
    group: "main" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/skills`,
    routeSegment: "skills",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.screen("skills", SkillsScreen);
  app.hostMount("skills-sync", SkillsSyncBinder);
  app.agentControl("skills", SkillsControl);
  app.agentPanelAccessory("skill-train-bar", AgentSkillTrainBar);
  app.turnPreparer(prepareTurnSkills);
}
