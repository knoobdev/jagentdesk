import { create } from "zustand";

/**
 * Shared state for the cluster resource navigation. The nav lives in the app
 * left sidebar (SidebarClusterNav) and the selected kind drives the resource
 * table shown by the workloads screen (ClusterResourceBrowser). Keyed by
 * clusterId so switching clusters resets the selection cleanly.
 */
interface ClusterNavState {
  clusterId: string | null;
  selectedKind: string | null;
  selectedNamespace: string | undefined;
  showingHelm: boolean;
  /** k8s-Lens-style cluster dashboard, shown by default when a cluster opens. */
  showingOverview: boolean;
  /** The last cluster the user had open, so the sidebar can jump straight back. */
  lastCluster: { serverId: string; clusterId: string } | null;
  selectKind: (clusterId: string, kind: string) => void;
  selectHelm: (clusterId: string) => void;
  selectOverview: (clusterId: string) => void;
  setNamespace: (namespace: string | undefined) => void;
  ensureCluster: (clusterId: string) => void;
  setLastCluster: (serverId: string, clusterId: string) => void;
  /**
   * Forget the remembered cluster when the user explicitly disconnects it, so
   * the sidebar's Clusters entry falls back to the cluster list instead of
   * jumping back into (and silently reconnecting) a cluster the user just left.
   * No-op when the disconnected cluster isn't the remembered one.
   */
  clearLastCluster: (clusterId: string) => void;
}

export const useClusterNavStore = create<ClusterNavState>((set, get) => ({
  clusterId: null,
  selectedKind: null,
  selectedNamespace: undefined,
  showingHelm: false,
  showingOverview: false,
  lastCluster: null,
  setLastCluster: (serverId, clusterId) => set({ lastCluster: { serverId, clusterId } }),
  clearLastCluster: (clusterId) =>
    set((s) => (s.lastCluster?.clusterId === clusterId ? { lastCluster: null } : {})),
  selectKind: (clusterId, kind) =>
    set({ clusterId, selectedKind: kind, showingHelm: false, showingOverview: false }),
  selectHelm: (clusterId) =>
    set({ clusterId, selectedKind: null, showingHelm: true, showingOverview: false }),
  selectOverview: (clusterId) =>
    set({ clusterId, selectedKind: null, showingHelm: false, showingOverview: true }),
  setNamespace: (namespace) => set({ selectedNamespace: namespace }),
  ensureCluster: (clusterId) => {
    if (get().clusterId !== clusterId) {
      // New cluster opened: land on the Overview dashboard (like k8s-Lens),
      // not an empty "pick a resource" prompt.
      set({
        clusterId,
        selectedKind: null,
        selectedNamespace: undefined,
        showingHelm: false,
        showingOverview: true,
      });
    }
  },
}));
