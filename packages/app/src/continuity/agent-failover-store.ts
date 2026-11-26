import { create } from "zustand";

interface AgentFailoverSheetState {
  agentId: string | null;
  open: (agentId: string) => void;
  close: () => void;
}

/** The agent whose failover override is being edited (opened from the agent tab's ⋯ menu). */
export const useAgentFailoverSheetStore = create<AgentFailoverSheetState>((set) => ({
  agentId: null,
  open: (agentId) => set({ agentId }),
  close: () => set({ agentId: null }),
}));
