import { create } from "zustand";

// Client-side "Team mode" flag per (serverId, agentId). When on, the next chat send seeds a forum
// topic and hands the origin agent the team-lead brief instead of a normal turn (docs/plans/active/
// agent-forum.md). Kept in-memory (opt-in per session) so it never silently runs a costly team on a
// reload; the user re-arms it deliberately.
interface TeamModeState {
  enabled: Record<string, boolean>;
  toggle: (key: string) => void;
  set: (key: string, value: boolean) => void;
}

export function teamModeKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export const useTeamModeStore = create<TeamModeState>((set) => ({
  enabled: {},
  toggle: (key) => set((state) => ({ enabled: { ...state.enabled, [key]: !state.enabled[key] } })),
  set: (key, value) => set((state) => ({ enabled: { ...state.enabled, [key]: value } })),
}));

// Non-reactive read for the send path (avoids re-subscribing the whole composer to the store).
export function getTeamModeEnabled(serverId: string, agentId: string): boolean {
  return useTeamModeStore.getState().enabled[teamModeKey(serverId, agentId)] === true;
}
