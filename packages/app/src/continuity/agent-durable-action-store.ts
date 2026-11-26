import { create } from "zustand";

export type AgentDurableAction = "rollover" | "captureLessons";

interface AgentDurableActionState {
  request: { agentId: string; action: AgentDurableAction } | null;
  open: (agentId: string, action: AgentDurableAction) => void;
  close: () => void;
}

/** Rollover / Capture lessons picked from the agent tab's ⋯ menu (spec 42 §6–§7). */
export const useAgentDurableActionStore = create<AgentDurableActionState>((set) => ({
  request: null,
  open: (agentId, action) => set({ request: { agentId, action } }),
  close: () => set({ request: null }),
}));
