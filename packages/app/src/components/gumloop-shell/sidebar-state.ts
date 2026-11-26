import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const GUMLOOP_SIDEBAR_WIDTH = 324;
export const GUMLOOP_INSPECTOR_WIDTH = 525;
export const GUMLOOP_INSPECTOR_HOST = "gumloop-compact-inspector";
export const GUMLOOP_PANEL_HOST = "gumloop-sidebar-panel";
/** The focused workspace portals its `⋯` actions menu into the compact header row (spec 38 §5). */
export const GUMLOOP_COMPACT_ACTIONS_HOST = "gumloop-compact-header-actions";

interface GumloopSidebarState {
  toolsCollapsed: boolean;
  projectsCollapsed: boolean;
  setToolsCollapsed: (collapsed: boolean) => void;
  toggleProjects: () => void;
}

type PersistedSidebarState = Pick<GumloopSidebarState, "toolsCollapsed" | "projectsCollapsed">;

/**
 * Version 1 opens Tools by default (spec 38 §4.2, 2026-11-26). Up to v0.10.0 Tools started folded
 * when it had more than 6 entries and users never found Docker, Data or Jira there, so a fold saved
 * by an older build is dropped once on the way to version 1. Folds saved from version 1 on stick.
 */
export const GUMLOOP_SIDEBAR_STATE_VERSION = 1;

export function migrateGumloopSidebarState(
  persisted: unknown,
  version: number,
): PersistedSidebarState {
  const saved = (persisted ?? {}) as Partial<Record<keyof PersistedSidebarState, unknown>>;
  return {
    toolsCollapsed: version >= 1 && saved.toolsCollapsed === true,
    projectsCollapsed: saved.projectsCollapsed === true,
  };
}

export const useGumloopSidebarState = create<GumloopSidebarState>()(
  persist(
    (set) => ({
      toolsCollapsed: false,
      projectsCollapsed: false,
      setToolsCollapsed: (toolsCollapsed) => set({ toolsCollapsed }),
      toggleProjects: () => set((state) => ({ projectsCollapsed: !state.projectsCollapsed })),
    }),
    {
      name: "jagentdesk:gumloop-sidebar",
      version: GUMLOOP_SIDEBAR_STATE_VERSION,
      migrate: migrateGumloopSidebarState,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state): PersistedSidebarState => ({
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
