import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { normalizeSkillIds } from "@/skills/native-skill-logic";

/**
 * Which native skills are active on which agent (spec 22.7). One agent uses
 * many skills; ids are `SkillEntry.skillId`.
 *
 * - `attached`: skill ids the user picked in the composer Skills picker.
 *   Persisted per agent so the selection sticks across reloads. Ids stored by
 *   older builds (legacy JSON skill ids) are rewritten through `migrateLegacyIds`
 *   once the catalog reports their `legacyId`.
 * - `injected`: skill ids already invoked on this agent's conversation, so the
 *   send path passes each skill only on its first turn (the daemon adds the
 *   provider invocation; the provider keeps the skill loaded afterwards).
 * - `autoLoad`: when true, each message also auto-matches relevant skills by
 *   keyword (no model call). Global toggle; cheap to flip from the picker.
 */
interface AgentSkillsState {
  autoLoad: boolean;
  attached: Record<string, string[]>;
  injected: Record<string, string[]>;
  setAutoLoad: (value: boolean) => void;
  toggleAttached: (agentId: string, skillId: string) => void;
  setAttached: (agentId: string, skillIds: string[]) => void;
  /** Swap one attached id for another (e.g. after forking a skill to train it). */
  replaceAttached: (agentId: string, fromId: string, toId: string) => void;
  markInjected: (agentId: string, skillIds: string[]) => void;
  /** Rewrite stored legacy ids (legacyId → skillId) in every agent's attachments. */
  migrateLegacyIds: (legacyMap: Readonly<Record<string, string>>) => void;
}

function addUnique(current: string[] | undefined, ids: string[]): string[] {
  return Array.from(new Set([...(current ?? []), ...ids]));
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Pure: apply a legacy-id map to a whole attachments record; returns the input when unchanged. */
export function migrateAttachmentRecord(
  record: Record<string, string[]>,
  legacyMap: Readonly<Record<string, string>>,
): Record<string, string[]> {
  let changed = false;
  const next: Record<string, string[]> = {};
  for (const [agentId, ids] of Object.entries(record)) {
    const normalized = normalizeSkillIds(ids, legacyMap);
    if (!sameIds(normalized, ids)) changed = true;
    next[agentId] = normalized;
  }
  return changed ? next : record;
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
      replaceAttached: (agentId, fromId, toId) =>
        set((state) => {
          const current = state.attached[agentId] ?? [];
          const next = Array.from(new Set(current.map((id) => (id === fromId ? toId : id))));
          const attached = current.includes(fromId) ? next : addUnique(current, [toId]);
          return { attached: { ...state.attached, [agentId]: attached } };
        }),
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
      migrateLegacyIds: (legacyMap) =>
        set((state) => {
          const attached = migrateAttachmentRecord(state.attached, legacyMap);
          const injected = migrateAttachmentRecord(state.injected, legacyMap);
          if (attached === state.attached && injected === state.injected) return state;
          return { attached, injected };
        }),
    }),
    {
      name: "@jagentdesk:agent-skills",
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
      // `injected` tracks live conversation state — do not restore it across app
      // restarts, so a reopened agent gets its attached skills invoked again.
      partialize: (state) => ({ autoLoad: state.autoLoad, attached: state.attached }),
    },
  ),
);

const EMPTY_ATTACHED: string[] = [];

/** Reactive selector: skill ids attached to one agent (stable empty default). */
export function selectAttachedSkillIds(agentId: string) {
  return (state: AgentSkillsState): string[] => state.attached[agentId] ?? EMPTY_ATTACHED;
}

/** Reactive selector: skill ids already invoked on one agent (stable empty default). */
export function selectInjectedSkillIds(agentId: string) {
  return (state: AgentSkillsState): string[] => state.injected[agentId] ?? EMPTY_ATTACHED;
}
