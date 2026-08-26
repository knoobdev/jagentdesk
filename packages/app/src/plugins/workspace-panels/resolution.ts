import type { PluginWorkspacePanelContribution } from "@jagentdesk/plugin";
import type { PluginWorkspaceTabTarget } from "@/workspace-tabs/model";
import type { InstalledPlugin } from "../types";

export function resolvePluginWorkspacePanel(
  plugin: InstalledPlugin | null,
  target: PluginWorkspaceTabTarget,
): PluginWorkspacePanelContribution | null {
  return (
    plugin?.workspacePanels.find(
      (panel) => panel.id === target.panelId && panel.context === target.context,
    ) ?? null
  );
}
