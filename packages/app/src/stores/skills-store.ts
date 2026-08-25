import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * A Skill is a reusable, named assistant: a system prompt (its "instructions")
 * plus presentation (name / icon / description / tags). "Using" a skill spawns a
 * real agent pre-loaded with those instructions — see the Skills screen. Skills
 * are stored per device for now; daemon-synced skills are a later phase.
 */
export interface Skill {
  id: string;
  name: string;
  icon: string;
  description: string;
  instructions: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export interface SkillDraft {
  name: string;
  icon?: string;
  description?: string;
  instructions: string;
  tags?: string[];
}

interface SkillsState {
  skills: Skill[];
  addSkill: (draft: SkillDraft) => Skill;
  updateSkill: (id: string, patch: Partial<SkillDraft>) => void;
  removeSkill: (id: string) => void;
}

function makeId(): string {
  // Local, per-device id; no crypto dependency needed for a client-only store.
  return `skl_${Math.abs(hashString(`${Date.now()}:${globalThis.performance?.now?.() ?? 0}`)).toString(36)}`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

const STARTER_SKILLS: Skill[] = [
  {
    id: "skl_k8s_doctor",
    name: "K8s Doctor",
    icon: "🩺",
    description: "Diagnoses pod crashes & restarts from logs and events, then proposes a fix.",
    instructions:
      "You are a Kubernetes triage expert. When asked about a pod or workload, pull its logs, events, and describe output using the available kubectl tools, then explain the likely root cause in plain language and propose a concrete fix. Prefer facts from the cluster over speculation.",
    tags: ["kubernetes", "logs", "triage"],
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "skl_pr_reviewer",
    name: "PR Reviewer",
    icon: "🔎",
    description: "Reviews a diff for bugs & simplifications and summarizes the risk.",
    instructions:
      "You are a careful code reviewer. Review the current diff for correctness bugs first, then simplification and reuse opportunities. Be concrete: cite file:line, give a one-line rationale, and state whether the change is safe to merge.",
    tags: ["review", "quality"],
    createdAt: 0,
    updatedAt: 0,
  },
];

export const useSkillsStore = create<SkillsState>()(
  persist(
    (set) => ({
      skills: STARTER_SKILLS,
      addSkill: (draft) => {
        const now = Date.now();
        const skill: Skill = {
          id: makeId(),
          name: draft.name.trim() || "Untitled skill",
          icon: draft.icon?.trim() || "✦",
          description: draft.description?.trim() ?? "",
          instructions: draft.instructions.trim(),
          tags: draft.tags?.filter(Boolean) ?? [],
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ skills: [skill, ...state.skills] }));
        return skill;
      },
      updateSkill: (id, patch) =>
        set((state) => ({
          skills: state.skills.map((s) =>
            s.id === id
              ? {
                  ...s,
                  ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
                  ...(patch.icon !== undefined ? { icon: patch.icon.trim() } : {}),
                  ...(patch.description !== undefined ? { description: patch.description } : {}),
                  ...(patch.instructions !== undefined
                    ? { instructions: patch.instructions.trim() }
                    : {}),
                  ...(patch.tags !== undefined ? { tags: patch.tags.filter(Boolean) } : {}),
                  updatedAt: Date.now(),
                }
              : s,
          ),
        })),
      removeSkill: (id) => set((state) => ({ skills: state.skills.filter((s) => s.id !== id) })),
    }),
    {
      name: "@jagentdesk:skills",
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    },
  ),
);
