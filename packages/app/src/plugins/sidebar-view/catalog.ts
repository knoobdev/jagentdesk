import type { InstalledPlugin } from "../types";
import type { PluginSidebarViewContribution } from "@jagentdesk/plugin/client";

export interface SidebarViewEntry {
  id: string;
  title: string;
  plugin: InstalledPlugin;
  view: PluginSidebarViewContribution;
}

export function sidebarViews(plugins: readonly InstalledPlugin[]): SidebarViewEntry[] {
  const entries = new Map<string, SidebarViewEntry>();
  for (const plugin of plugins) {
    for (const view of plugin.sidebarViews ?? []) {
      const id = `${plugin.id}/${view.id}`;
      if (!entries.has(id)) entries.set(id, { id, title: view.title, plugin, view });
    }
  }
  return [...entries.values()];
}
