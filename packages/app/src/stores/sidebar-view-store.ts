import type { WorkspaceSort } from "@/projects/workspace-structure";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";

export type SidebarGroupMode = "project" | "status";

const SIDEBAR_VIEW_STORAGE_KEY = "sidebar-view";
const LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY = "sidebar-group-mode";
const SIDEBAR_VIEW_STORE_VERSION = 4;

interface SidebarViewStoreState {
  workspaceSort: WorkspaceSort;
  setWorkspaceSort: (workspaceSort: WorkspaceSort) => void;
  groupMode: SidebarGroupMode;
  showBackground: boolean;
  // Empty means "all hosts". A non-empty list pins the sidebar to those hosts.
  hostFilters: string[];
  toggleBackground: () => void;
  setGroupMode: (mode: SidebarGroupMode) => void;
  toggleHostFilter: (serverId: string) => void;
  clearHostFilters: () => void;
  focusHost: (serverId: string) => void;
  reconcileHostFilters: (serverIds: readonly string[]) => void;
}

interface SidebarViewPersistedState {
  workspaceSort?: WorkspaceSort;
  groupMode: SidebarGroupMode;
  showBackground: boolean;
  hostFilters: string[];
}

function isSidebarGroupMode(value: unknown): value is SidebarGroupMode {
  return value === "project" || value === "status";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readLegacyGroupMode(persistedState: Record<string, unknown>): SidebarGroupMode | null {
  const groupModeByServerId = persistedState.groupModeByServerId;
  if (!isRecord(groupModeByServerId)) {
    return null;
  }

  const modes = Object.values(groupModeByServerId).filter(isSidebarGroupMode);
  if (modes.length === 0) return null;
  return modes.includes("status") ? "status" : "project";
}

// Reads the host filter from any persisted shape: the current `hostFilters` array, or the
// pre-v2 single `hostFilter` string (null/absent meant "all hosts").
function readHostFilters(persistedState: Record<string, unknown>): string[] {
  const hostFilters = persistedState.hostFilters;
  if (Array.isArray(hostFilters)) {
    return hostFilters.filter((value): value is string => typeof value === "string");
  }
  // COMPAT(sidebarHostFilters): added in v0.1.102, remove after 2026-12-30 once pre-v2 persisted
  // sidebar state (a single `hostFilter` string) has aged out.
  const legacyHostFilter = persistedState.hostFilter;
  return typeof legacyHostFilter === "string" ? [legacyHostFilter] : [];
}

export function migrateSidebarViewState(persistedState: unknown): SidebarViewPersistedState {
  if (!isRecord(persistedState)) {
    return { groupMode: "project", hostFilters: [], showBackground: false };
  }

  const legacyGroupMode = readLegacyGroupMode(persistedState);
  if (legacyGroupMode) {
    return {
      workspaceSort: "created",
      groupMode: legacyGroupMode,
      hostFilters: [],
      showBackground: false,
    };
  }

  return {
    workspaceSort:
      persistedState.workspaceSort === "manual" || persistedState.workspaceSort === "lastPrompt"
        ? persistedState.workspaceSort
        : "created",
    showBackground: persistedState.showBackground === true,
    groupMode: isSidebarGroupMode(persistedState.groupMode) ? persistedState.groupMode : "project",
    hostFilters: readHostFilters(persistedState),
  };
}

export function createSidebarViewStorage(
  backingStorage: StateStorage = AsyncStorage,
): StateStorage {
  return {
    getItem: async (name) => {
      const value = await backingStorage.getItem(name);
      if (value !== null || name !== SIDEBAR_VIEW_STORAGE_KEY) {
        return value;
      }
      return backingStorage.getItem(LEGACY_SIDEBAR_GROUP_MODE_STORAGE_KEY);
    },
    setItem: (name, value) => backingStorage.setItem(name, value),
    removeItem: (name) => backingStorage.removeItem(name),
  };
}

export const useSidebarViewStore = create<SidebarViewStoreState>()(
  persist(
    (set) => ({
      workspaceSort: "created",
      setWorkspaceSort: (workspaceSort) => set({ workspaceSort }),
      groupMode: "project",
      showBackground: false,
      toggleBackground: () => set((state) => ({ showBackground: !state.showBackground })),
      hostFilters: [],
      setGroupMode: (mode) => set({ groupMode: mode }),
      toggleHostFilter: (serverId) =>
        set((state) => ({
          hostFilters: state.hostFilters.includes(serverId)
            ? state.hostFilters.filter((id) => id !== serverId)
            : [...state.hostFilters, serverId],
        })),
      clearHostFilters: () => set({ hostFilters: [] }),
      focusHost: (serverId) => set({ hostFilters: [serverId] }),
      reconcileHostFilters: (serverIds) =>
        set((state) => {
          if (state.hostFilters.length === 0) {
            return state;
          }
          const allowed = new Set(serverIds);
          const next = state.hostFilters.filter((id) => allowed.has(id));
          if (next.length === state.hostFilters.length) {
            return state;
          }
          return { hostFilters: next };
        }),
    }),
    {
      name: SIDEBAR_VIEW_STORAGE_KEY,
      version: SIDEBAR_VIEW_STORE_VERSION,
      storage: createJSONStorage(createSidebarViewStorage),
      partialize: (state) => ({
        workspaceSort: state.workspaceSort,
        groupMode: state.groupMode,
        showBackground: state.showBackground,
        hostFilters: state.hostFilters,
      }),
      migrate: migrateSidebarViewState,
    },
  ),
);
