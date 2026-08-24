import { create } from "zustand";

/**
 * Tabs for the cluster content area (k8slens-style). The resource list is the
 * default view; opening a resource adds a detail tab in the same content pane
 * instead of a modal popup, so multiple resources can stay open and the k8s
 * view is never covered. Keyed by clusterId.
 */
export interface ClusterViewTab {
  id: string;
  kind: string;
  namespace?: string;
  name: string;
}

interface ClusterViewState {
  clusterId: string | null;
  tabs: ClusterViewTab[];
  /** null = the resource list view. */
  activeTabId: string | null;
  /** Bumped when a detail mutates a resource so the list reloads. */
  listRefreshKey: number;
  openDetail: (
    clusterId: string,
    input: { kind: string; namespace?: string; name: string },
  ) => void;
  closeTab: (id: string) => void;
  setActive: (id: string | null) => void;
  bumpRefresh: () => void;
  resetForCluster: (clusterId: string) => void;
}

const tabId = (kind: string, namespace: string | undefined, name: string) =>
  `${kind}/${namespace ?? ""}/${name}`;

export const useClusterViewStore = create<ClusterViewState>((set, get) => ({
  clusterId: null,
  tabs: [],
  activeTabId: null,
  listRefreshKey: 0,
  openDetail: (clusterId, input) => {
    const id = tabId(input.kind, input.namespace, input.name);
    const state = get();
    const exists = state.tabs.some((t) => t.id === id);
    set({
      clusterId,
      activeTabId: id,
      tabs: exists ? state.tabs : [...state.tabs, { id, ...input }],
    });
  },
  closeTab: (id) => {
    const state = get();
    const idx = state.tabs.findIndex((t) => t.id === id);
    const tabs = state.tabs.filter((t) => t.id !== id);
    let activeTabId = state.activeTabId;
    if (state.activeTabId === id) {
      // Focus the neighbour tab, or fall back to the list.
      const next = tabs[idx] ?? tabs[idx - 1] ?? null;
      activeTabId = next ? next.id : null;
    }
    set({ tabs, activeTabId });
  },
  setActive: (id) => set({ activeTabId: id }),
  bumpRefresh: () => set((s) => ({ listRefreshKey: s.listRefreshKey + 1 })),
  resetForCluster: (clusterId) => {
    if (get().clusterId !== clusterId) {
      set({ clusterId, tabs: [], activeTabId: null });
    }
  },
}));
