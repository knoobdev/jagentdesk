import { create } from "zustand";

/**
 * Drives the slide-in chat dock shown alongside the cluster/workloads view.
 * Chatting from a cluster opens the agent conversation in this right-side dock
 * (keyed by clusterId) instead of navigating to a full agent tab, so the k8s
 * resources the user is looking at stay on screen. The agentId is retained when
 * the dock is hidden so it can be toggled back open.
 */
/**
 * A resource question queued by "Ask AI" before the dock's agent exists. The dock
 * is the SINGLE creator of the cluster agent; Ask AI never creates its own, it just
 * parks the question here and reveals the dock. This avoids a race where Ask AI and
 * the dock each spawned an agent — the panel then showed one while the reply went to
 * the other, so the chat looked silent even though the agent had answered.
 */
export interface ClusterChatPendingAsk {
  message: string;
  kind: string;
  namespace?: string;
  name?: string;
  yaml?: string;
  logs?: string;
}

interface ClusterChatState {
  clusterId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  open: boolean;
  width: number;
  pendingAsk: ClusterChatPendingAsk | null;
  /** Open (or reveal) the dock for a freshly created cluster agent. */
  openChat: (input: { clusterId: string; agentId: string; workspaceId: string | null }) => void;
  /** Hide the dock but keep the agentId so it can be reopened. */
  hideChat: () => void;
  /** Reveal the dock (works before any agent exists — shows the entry composer). */
  showChat: () => void;
  /** Queue a resource question for the dock's agent, then the caller reveals the dock. */
  setPendingAsk: (ask: ClusterChatPendingAsk) => void;
  /** Clear the queued question once the dock has delivered it. */
  clearPendingAsk: () => void;
  /**
   * The project/workspace the user picked for cluster chats to run in (the agent's
   * cwd). null = fall back to the first available workspace. Persists across
   * clusters — a k8s project is usually the same regardless of which cluster.
   */
  pickedWorkspaceId: string | null;
  setPickedWorkspaceId: (workspaceId: string | null) => void;
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
  pendingAsk: null,
  pickedWorkspaceId: null,
  openChat: ({ clusterId, agentId, workspaceId }) =>
    set({ clusterId, agentId, workspaceId, open: true }),
  hideChat: () => set({ open: false }),
  showChat: () => set({ open: true }),
  setPendingAsk: (ask) => set({ pendingAsk: ask }),
  clearPendingAsk: () => set({ pendingAsk: null }),
  setPickedWorkspaceId: (pickedWorkspaceId) => set({ pickedWorkspaceId }),
  setOpen: (open) => set({ open }),
  resetForCluster: (clusterId, open = true) => {
    if (get().clusterId !== clusterId) {
      set({ clusterId, agentId: null, workspaceId: null, open, pendingAsk: null });
    }
  },
  setWidth: (width) =>
    set({ width: Math.max(CLUSTER_CHAT_MIN_WIDTH, Math.min(CLUSTER_CHAT_MAX_WIDTH, width)) }),
}));
