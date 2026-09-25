import { create } from "zustand";

/**
 * Drives the chat dock beside the SimFleet screen: the agent conversation that drives the host's
 * iOS simulators through the sim_* tools. Mirrors database-chat-store, keyed by host (one fleet per
 * daemon) instead of by database.
 */
interface SimChatState {
  serverId: string | null;
  agentId: string | null;
  workspaceId: string | null;
  open: boolean;
  width: number;
  /** True when the user explicitly asked for a fresh chat (blank composer). */
  draft: boolean;
  /** The project the user picked for fleet chats to run in (the agent cwd). */
  pickedWorkspaceId: string | null;
  /** Set once the form-factor default (open on desktop, closed on phones) has been applied. */
  defaultApplied: boolean;
  applyDefaultOpen: (open: boolean) => void;
  openChat: (input: { serverId: string; agentId: string; workspaceId: string | null }) => void;
  hideChat: () => void;
  showChat: () => void;
  startNewChat: () => void;
  setPickedWorkspaceId: (workspaceId: string | null) => void;
  resetForServer: (serverId: string) => void;
  setWidth: (width: number) => void;
}

export const SIM_CHAT_MIN_WIDTH = 320;
export const SIM_CHAT_MAX_WIDTH = 720;
const DEFAULT_WIDTH = 380;

export const useSimChatStore = create<SimChatState>((set, get) => ({
  serverId: null,
  agentId: null,
  workspaceId: null,
  open: false,
  width: DEFAULT_WIDTH,
  draft: false,
  pickedWorkspaceId: null,
  defaultApplied: false,
  applyDefaultOpen: (open) => {
    if (!get().defaultApplied) set({ open, defaultApplied: true });
  },
  openChat: ({ serverId, agentId, workspaceId }) =>
    set({ serverId, agentId, workspaceId, open: true, draft: false }),
  hideChat: () => set({ open: false }),
  showChat: () => set({ open: true }),
  startNewChat: () => set({ agentId: null, workspaceId: null, open: true, draft: true }),
  setPickedWorkspaceId: (pickedWorkspaceId) => set({ pickedWorkspaceId }),
  resetForServer: (serverId) => {
    if (get().serverId !== serverId) {
      set({ serverId, agentId: null, workspaceId: null, draft: false });
    }
  },
  setWidth: (width) =>
    set({ width: Math.max(SIM_CHAT_MIN_WIDTH, Math.min(SIM_CHAT_MAX_WIDTH, width)) }),
}));
