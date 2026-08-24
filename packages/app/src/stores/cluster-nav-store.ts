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
  selectKind: (clusterId: string, kind: string) => void;
  selectHelm: (clusterId: string) => void;
  setNamespace: (namespace: string | undefined) => void;
  ensureCluster: (clusterId: string) => void;
}

export const useClusterNavStore = create<ClusterNavState>((set, get) => ({
  clusterId: null,
  selectedKind: null,
  selectedNamespace: undefined,
  showingHelm: false,
  selectKind: (clusterId, kind) => set({ clusterId, selectedKind: kind, showingHelm: false }),
  selectHelm: (clusterId) => set({ clusterId, selectedKind: null, showingHelm: true }),
  setNamespace: (namespace) => set({ selectedNamespace: namespace }),
  ensureCluster: (clusterId) => {
    if (get().clusterId !== clusterId) {
      // New cluster opened: default to Pods, reset namespace/helm.
      set({
        clusterId,
        selectedKind: "Pod",
        selectedNamespace: undefined,
        showingHelm: false,
      });
    }
  },
}));
