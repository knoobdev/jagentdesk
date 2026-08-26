import { describe, expect, it } from "vitest";
import type { PluginWorkspacePanelContribution } from "@jagentdesk/plugin";
import {
  getPluginPanelLocations,
  pluginPanelSupportsLocation,
  resolvePluginPanelOpenLocation,
} from "./locations";

// Build the contribution as a literal so this suite exercises the pure location
// logic without importing the plugin registry (which pulls the client bundle
// evaluator and its lucide namespace import — untestable in the node harness).
function panel(
  locations: PluginWorkspacePanelContribution["locations"],
): PluginWorkspacePanelContribution {
  return {
    id: "details",
    title: "Details",
    icon: "Scan",
    context: "agent",
    locations,
    Component: () => null,
  };
}

describe("plugin workspace panel locations", () => {
  it("reports declared locations and falls back to workspace", () => {
    expect(getPluginPanelLocations(panel(["workspace", "explorer"]))).toEqual([
      "workspace",
      "explorer",
    ]);
    expect(getPluginPanelLocations(panel(undefined))).toEqual(["workspace"]);
    expect(pluginPanelSupportsLocation(panel(["explorer"]), "explorer")).toBe(true);
    expect(pluginPanelSupportsLocation(panel(["explorer"]), "workspace")).toBe(false);
  });

  it("defaults opens to workspace and validates explicit Explorer opens", () => {
    const both = panel(["workspace", "explorer"]);
    expect(resolvePluginPanelOpenLocation(both)).toBe("workspace");
    expect(resolvePluginPanelOpenLocation(both, "explorer")).toBe("explorer");

    const workspaceOnly = panel(["workspace"]);
    expect(() => resolvePluginPanelOpenLocation(workspaceOnly, "explorer")).toThrow(
      "does not support explorer location",
    );

    const explorerOnly = panel(["explorer"]);
    expect(resolvePluginPanelOpenLocation(explorerOnly)).toBe("explorer");
  });
});
