import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const GUMLOOP_SIDEBAR_WIDTH = 324;
export const GUMLOOP_INSPECTOR_WIDTH = 525;
export const GUMLOOP_INSPECTOR_HOST = "gumloop-compact-inspector";
export const GUMLOOP_PANEL_HOST = "gumloop-sidebar-panel";

interface GumloopSidebarState {
  toolsCollapsed: boolean | null;
  projectsCollapsed: boolean;
  setToolsCollapsed: (collapsed: boolean) => void;
  toggleProjects: () => void;
}

export function toolsInitiallyCollapsed(count: number): boolean {
  return count > 6;
}

export const useGumloopSidebarState = create<GumloopSidebarState>()(
  persist(
    (set) => ({
      toolsCollapsed: null,
      projectsCollapsed: false,
      setToolsCollapsed: (toolsCollapsed) => set({ toolsCollapsed }),
      toggleProjects: () => set((state) => ({ projectsCollapsed: !state.projectsCollapsed })),
    }),
    {
      name: "jagentdesk:gumloop-sidebar",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        toolsCollapsed: state.toolsCollapsed,
        projectsCollapsed: state.projectsCollapsed,
      }),
    },
  ),
);

export type SidebarDrillIn =
  | { kind: "workspace"; serverId: string; workspaceId: string }
  | { kind: "settings"; title: string }
  | { kind: "destination"; serverId: string; section: string; title: string }
  | null;

const DESTINATIONS: Readonly<Record<string, string>> = {
  bots: "Bots",
  databases: "Data",
  database: "Data",
  clusters: "Clusters",
  cluster: "Clusters",
  argocd: "Argo CD",
  jira: "Jira",
  figma: "Figma",
  plugin: "Plugins",
};

export function resolveSidebarDrillIn(
  pathname: string,
  destinations: readonly { routeSegment: string; title: string }[] = [],
): SidebarDrillIn {
  if (pathname.startsWith("/settings")) return { kind: "settings", title: "Settings" };
  const match = /^\/h\/([^/]+)\/([^/]+)(?:\/([^/?]+))?/.exec(pathname);
  if (!match) return null;
  const serverId = decodeURIComponent(match[1]);
  const section = match[2];
  if (section === "workspace" && match[3]) {
    return { kind: "workspace", serverId, workspaceId: decodeURIComponent(match[3]) };
  }
  const title =
    destinations.find((destination) => destination.routeSegment === section)?.title ??
    DESTINATIONS[section];
  return title ? { kind: "destination", serverId, section, title } : null;
}
