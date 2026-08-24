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
  /** Reveal a previously created agent's dock. */
  showChat: () => void;
  /** Fully reset when leaving the cluster or switching clusters. */
  resetForCluster: (clusterId: string) => void;
  setWidth: (width: number) => void;
}

export const CLUSTER_CHAT_MIN_WIDTH = 320;
export const CLUSTER_CHAT_MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;

export const useClusterChatStore = create<ClusterChatState>((set, get) => ({
  clusterId: null,
  agentId: null,
  workspaceId: null,
  open: false,
  width: DEFAULT_WIDTH,
  openChat: ({ clusterId, agentId, workspaceId }) =>
    set({ clusterId, agentId, workspaceId, open: true }),
  hideChat: () => set({ open: false }),
  showChat: () => {
    if (get().agentId) set({ open: true });
  },
  resetForCluster: (clusterId) => {
    if (get().clusterId !== clusterId) {
      set({ clusterId, agentId: null, workspaceId: null, open: false });
    }
  },
  setWidth: (width) =>
    set({ width: Math.max(CLUSTER_CHAT_MIN_WIDTH, Math.min(CLUSTER_CHAT_MAX_WIDTH, width)) }),
}));
