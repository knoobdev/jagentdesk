import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * Which skills are active on which agent (redesign B3 + B5,
 * docs/plans/active/skills-redesign.md). One agent uses many skills.
 *
 * - `attached`: skill ids the user manually picked in the composer skill picker.
 *   Persisted per agent so the selection sticks across reloads.
 * - `injected`: skill ids already delivered to the agent's conversation (so the
 *   send path doesn't re-prepend the same skill preamble every turn).
 * - `autoLoad`: when true, each message also auto-matches relevant skills by
 *   keyword/tag (B5). Global toggle; cheap to flip from the picker.
 */
interface AgentSkillsState {
  autoLoad: boolean;
  attached: Record<string, string[]>;
  injected: Record<string, string[]>;
  setAutoLoad: (value: boolean) => void;
  toggleAttached: (agentId: string, skillId: string) => void;
  setAttached: (agentId: string, skillIds: string[]) => void;
  markInjected: (agentId: string, skillIds: string[]) => void;
}

function addUnique(current: string[] | undefined, ids: string[]): string[] {
  return Array.from(new Set([...(current ?? []), ...ids]));
}

export const useAgentSkillsStore = create<AgentSkillsState>()(
  persist(
    (set) => ({
      autoLoad: true,
      attached: {},
      injected: {},
      setAutoLoad: (value) => set({ autoLoad: value }),
      toggleAttached: (agentId, skillId) =>
        set((state) => {
          const current = state.attached[agentId] ?? [];
          const next = current.includes(skillId)
            ? current.filter((id) => id !== skillId)
            : [...current, skillId];
          return { attached: { ...state.attached, [agentId]: next } };
        }),
      setAttached: (agentId, skillIds) =>
        set((state) => ({
          attached: { ...state.attached, [agentId]: Array.from(new Set(skillIds)) },
        })),
      markInjected: (agentId, skillIds) =>
        set((state) => {
          if (skillIds.length === 0) return state;
          return {
            injected: {
              ...state.injected,
              [agentId]: addUnique(state.injected[agentId], skillIds),
            },
          };
        }),
    }),
    {
      name: "@jagentdesk:agent-skills",
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      // `injected` tracks live conversation state — do not restore it across app
      // restarts, so a reopened agent gets its attached skills re-delivered.
      partialize: (state) => ({ autoLoad: state.autoLoad, attached: state.attached }),
    },
  ),
);

const EMPTY_ATTACHED: string[] = [];

/** Reactive selector: skill ids attached to one agent (stable empty default). */
export function selectAttachedSkillIds(agentId: string) {
  return (state: AgentSkillsState): string[] => state.attached[agentId] ?? EMPTY_ATTACHED;
}
