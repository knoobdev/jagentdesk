import type { PluginPanelLocation, PluginWorkspacePanelContribution } from "@jagentdesk/plugin";

const DEFAULT_LOCATIONS: readonly PluginPanelLocation[] = ["workspace"];

export function getPluginPanelLocations(
  panel: PluginWorkspacePanelContribution,
): readonly PluginPanelLocation[] {
  return panel.locations ?? DEFAULT_LOCATIONS;
}

export function pluginPanelSupportsLocation(
  panel: PluginWorkspacePanelContribution,
  location: PluginPanelLocation,
): boolean {
  return getPluginPanelLocations(panel).includes(location);
}

// JAgentDesk hosts every plugin panel in the workspace pane area; it has no
// separate explorer sidebar host. We still honor the declared location set so a
// plugin that opts out of "workspace" surfaces a clear error instead of silently
// landing somewhere it did not ask for.
export function resolvePluginPanelOpenLocation(
  panel: PluginWorkspacePanelContribution,
  requested?: PluginPanelLocation,
): PluginPanelLocation {
  const locations = getPluginPanelLocations(panel);
  const location = requested ?? (locations.includes("workspace") ? "workspace" : locations[0]);
  if (!location || !locations.includes(location)) {
    throw new Error(`Workspace panel ${panel.id} does not support ${requested ?? "any"} location`);
  }
  return location;
}
