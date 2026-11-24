import { supportsDesktopPaneSplits } from "@/constants/layout";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";
import { UnistylesRuntime } from "react-native-unistyles";
import { buildPluginSettingsRoute } from "./settings/routes";
import { router } from "expo-router";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { buildPluginSurfaceRoute } from "./routes";
import type { PluginNavigation } from "./actions";

export function createPluginNavigation(input: {
  serverId: string;
  workspaceId: string | null;
}): PluginNavigation {
  const { serverId, workspaceId } = input;
  function openPanel(target: PluginWorkspaceTabTarget, location?: "workspace" | "explorer") {
    if (!workspaceId) throw new Error("No active workspace");
    const isCompact = UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
    if (location !== "explorer" || isCompact || !supportsDesktopPaneSplits()) {
      navigateToWorkspace({ serverId, workspaceId, target });
      return;
    }
    const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
    const key = resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId });
    const workspace = key ? workspaces?.get(key) : null;
    if (!workspace?.workspaceDirectory) throw new Error("Workspace directory is unavailable");
    navigateToWorkspace({ serverId, workspaceId });
    useWorkspaceLayoutStore
      .getState()
      .openTabInExplorerPaneFocused(`${serverId}:${workspaceId}`, { target });
    usePanelStore.getState().openFileExplorerForCheckout({
      isCompact,
      checkout: {
        serverId,
        cwd: workspace.workspaceDirectory,
        isGit: workspace.projectKind === "git",
      },
    });
  }
  return {
    openSettings(pluginId, screenId) {
      router.push(buildPluginSettingsRoute(serverId, pluginId, screenId));
    },
    openSurface(pluginId, surfaceId) {
      router.push(buildPluginSurfaceRoute(serverId, pluginId, { kind: "surface", id: surfaceId }));
    },
    openWorkspacePanel(pluginId, panelId, location) {
      openPanel({ kind: "plugin", pluginId, panelId, context: "workspace" }, location);
    },
    openAgentPanel(pluginId, panelId, agentId, location) {
      openPanel({ kind: "plugin", pluginId, panelId, context: "agent", agentId }, location);
    },
  };
}
