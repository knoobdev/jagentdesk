import { create } from "zustand";

/**
 * Drives the slide-in chat dock shown alongside the cluster/workloads view.
 * Chatting from a cluster opens the agent conversation in this right-side dock
 * (keyed by clusterId) instead of navigating to a full agent tab, so the k8s
 * resources the user is looking at stay on screen. The agentId is retained when
 * the dock is hidden so it can be toggled back open.
 */
interface ClusterChatState {
  clusterId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  open: boolean;
  width: number;
  /** Open (or reveal) the dock for a freshly created cluster agent. */
  openChat: (input: { clusterId: string; agentId: string; workspaceId: string | null }) => void;
  /** Hide the dock but keep the agentId so it can be reopened. */
  hideChat: () => void;
  /** Reveal the dock (works before any agent exists — shows the entry composer). */
  showChat: () => void;
  /** Open/collapse the dock. */
  setOpen: (open: boolean) => void;
  /**
   * Fully reset when leaving the cluster or switching clusters. `open` controls
   * whether the dock starts revealed — true on desktop (side panel), false on
   * phones where the dock is a full-screen overlay that would otherwise bury the
   * k8s resource view.
   */
  resetForCluster: (clusterId: string, open?: boolean) => void;
  setWidth: (width: number) => void;
}

export const CLUSTER_CHAT_MIN_WIDTH = 320;
export const CLUSTER_CHAT_MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;

export const useClusterChatStore = create<ClusterChatState>((set, get) => ({
  clusterId: null,
  agentId: null,
  workspaceId: null,
  // Start CLOSED. resetForCluster (called when the workloads screen mounts) sets
  // the real initial state per form factor: open on desktop, closed on phones.
  // Keeping the default closed also stops the dock's eager agent-creation effect
  // (gated on `open`) from firing during the first render — before resetForCluster
  // runs — which used to set clusterId and defeat resetForCluster's own guard.
  open: false,
  width: DEFAULT_WIDTH,
  openChat: ({ clusterId, agentId, workspaceId }) =>
    set({ clusterId, agentId, workspaceId, open: true }),
  hideChat: () => set({ open: false }),
  showChat: () => set({ open: true }),
  setOpen: (open) => set({ open }),
  resetForCluster: (clusterId, open = true) => {
    if (get().clusterId !== clusterId) {
      set({ clusterId, agentId: null, workspaceId: null, open });
    }
  },
  setWidth: (width) =>
    set({ width: Math.max(CLUSTER_CHAT_MIN_WIDTH, Math.min(CLUSTER_CHAT_MAX_WIDTH, width)) }),
}));
