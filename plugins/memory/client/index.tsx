import { Brain } from "lucide-react-native";
import type { BuiltinClientHost } from "../../../packages/app/src/plugins/builtin/host-api";
import { MEMORY_REMEMBERED_ITEM_KIND, MEMORY_USED_ITEM_KIND } from "../shared/types";
import { MemoryInspectorTab } from "./inspector-tab";
import { RememberThisAction } from "./remember-action";
import { RememberedRow } from "./remembered-card";
import { MemoryScreen } from "./screen";
import { MemorySettingsSection } from "./settings-section";
import { MemoryUsedChip } from "./used-chip";

export function register(app: BuiltinClientHost) {
  const destination = {
    id: "memory",
    title: "Memory",
    icon: Brain,
    group: "main" as const,
    route: (serverId: string) => `/h/${encodeURIComponent(serverId)}/memory`,
    routeSegment: "memory",
  };
  app.sidebarDestination(destination);
  app.mobileDrawerEntry(destination);
  app.screen("memory", MemoryScreen);
  app.timelineRenderer(MEMORY_USED_ITEM_KIND, MemoryUsedChip);
  app.timelineRenderer(MEMORY_REMEMBERED_ITEM_KIND, RememberedRow);
  app.messageAction("remember-this", RememberThisAction);
  app.settingsSection("memory", MemorySettingsSection);
  app.inspectorTab({ id: "memory", title: "Memory", icon: Brain, component: MemoryInspectorTab });
}
