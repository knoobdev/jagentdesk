import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";

export function createPluginNavigation(owner: {
  serverId: string;
  workspaceId: string | null;
}): PluginNavigation {
  const { serverId, workspaceId } = owner;
  // The fork's workspace has no explorer-pane placement, so every location opens the
  // panel as a workspace tab (the "explorer" hint is accepted and ignored).
  return {
    openScreen(pluginId, input) {
      const query = new URLSearchParams(
        Object.entries(input.params ?? {}).map(([key, value]) => [`pluginParam.${key}`, value]),
      );
      const path = buildPluginSurfaceRoute(serverId, pluginId, {
        kind: "surface",
        id: input.screenId,
      });
      router.push(query.size ? `${path}?${query}` : path);
    },
    openSettings(pluginId, screenId) {
      router.push(buildPluginSettingsRoute(serverId, pluginId, screenId));
    },
    openSurface(pluginId, surfaceId) {
      router.push(buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }));
    },
    openWorkspacePanel(pluginId, panelId, _location) {
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "workspace" },
      });
    },
    openAgentPanel(pluginId, panelId, agentId, _location) {
      if (!workspaceId) throw new Error("No active workspace");
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "plugin", pluginId, panelId, context: "agent", agentId },
      });
    },
  };
}
