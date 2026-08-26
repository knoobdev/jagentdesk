import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";

/**
 * A Skill is a reusable, named assistant: a system prompt (its "instructions")
 * plus presentation (name / icon / description / tags). "Using" a skill spawns a
 * real agent pre-loaded with those instructions — see the Skills screen.
 *
 * Skills are *trained*: each run you rate is worth XP and (optionally) a
 * correction that is appended to the instructions ("learned"). XP raises the
 * skill's level/tier; once the graduation checklist is met the skill can
 * "Graduate", marking it a trusted, reusable assistant. Stored per device.
 */
export type SkillStatus = "training" | "graduated";

export interface SkillExample {
  id: string;
  task: string;
  rating: "up" | "down";
  correction?: string;
  at: number;
}

/**
 * Knowledge a skill learned from a REAL conversation (redesign per
 * docs/plans/active/skills-redesign.md). Sources:
 * - "approved-answer": the user 👍'd an assistant message; its content is captured.
 * - "proposed": the agent proposed a lesson after a turn; pending user approval.
 * - "correction": (legacy) a hand-typed correction — kept for migration only.
 */
export interface LearnedEntry {
  id: string;
  source: "approved-answer" | "proposed" | "correction";
  content: string;
  /** For "proposed" entries: whether the user has approved it into the skill. */
  approved: boolean;
  /** Provider message id the lesson came from, when applicable. */
  messageId?: string;
  at: number;
}

export interface Skill {
  id: string;
  name: string;
  icon: string;
  description: string;
  instructions: string;
  tags: string[];
  status: SkillStatus;
  xp: number;
  runs: number;
  approvals: number;
  consecutiveApprovals: number;
  examples: SkillExample[];
  /** Knowledge learned from real conversations (approve / agent-proposed). */
  learned: LearnedEntry[];
  createdAt: number;
  updatedAt: number;
}

/**
 * The effective system prompt a skill contributes to an agent: the base
 * instructions plus everything it has learned (approved lessons only).
 */
export function skillEffectivePrompt(skill: Skill): string {
  const lessons = (skill.learned ?? [])
    .filter((l) => l.approved)
    .map((l) => `- (learned) ${l.content}`);
  return lessons.length > 0 ? `${skill.instructions}\n\n${lessons.join("\n")}` : skill.instructions;
}

export interface SkillDraft {
  name: string;
  icon?: string;
  description?: string;
  instructions: string;
  tags?: string[];
}

// ── Leveling ──────────────────────────────────────────────────────────────
export const XP_PER_LEVEL = 300;
export const MAX_LEVEL = 5;
const TIER_NAMES = ["Novice", "Apprentice", "Skilled", "Proficient", "Expert"] as const;
const XP_APPROVE = 60;
const XP_REJECT = 15;

export function levelForXp(xp: number): number {
  return Math.min(MAX_LEVEL, Math.floor(xp / XP_PER_LEVEL) + 1);
}

export function tierName(level: number): string {
  return TIER_NAMES[Math.min(Math.max(level, 1), MAX_LEVEL) - 1];
}

export interface LevelProgress {
  level: number;
  tier: string;
  /** XP earned within the current level. */
  inLevel: number;
  /** XP needed to fill the current level. */
  forLevel: number;
  atMax: boolean;
}

export function levelProgress(xp: number): LevelProgress {
  const level = levelForXp(xp);
  const atMax = level >= MAX_LEVEL;
  const base = (level - 1) * XP_PER_LEVEL;
  return {
    level,
    tier: tierName(level),
    inLevel: atMax ? XP_PER_LEVEL : xp - base,
    forLevel: XP_PER_LEVEL,
    atMax,
  };
}

export interface ChecklistItem {
  label: string;
  have: number;
  need: number;
  done: boolean;
}

export interface GraduationStatus {
  items: ChecklistItem[];
  canGraduate: boolean;
}

export function approvalRate(skill: Skill): number {
  return skill.runs > 0 ? skill.approvals / skill.runs : 0;
}

export function graduationStatus(skill: Skill): GraduationStatus {
  const approved = skill.examples.filter((e) => e.rating === "up").length;
  const rate = approvalRate(skill);
  const items: ChecklistItem[] = [
    { label: "6+ approved examples", have: approved, need: 6, done: approved >= 6 },
    {
      label: "80%+ approval (min 5 runs)",
      have: Math.round(rate * 100),
      need: 80,
      done: skill.runs >= 5 && rate >= 0.8,
    },
    {
      label: "3 consecutive approvals",
      have: skill.consecutiveApprovals,
      need: 3,
      done: skill.consecutiveApprovals >= 3,
    },
    {
      label: "Instructions cover the workflow",
      have: skill.instructions.length,
      need: 120,
      done: skill.instructions.length >= 120,
    },
  ];
  return { items, canGraduate: items.every((i) => i.done) };
}

interface SkillsState {
  skills: Skill[];
  addSkill: (draft: SkillDraft) => Skill;
  updateSkill: (id: string, patch: Partial<SkillDraft>) => void;
  removeSkill: (id: string) => void;
  /** @deprecated legacy hand-typed training; replaced by learnFromMessage/proposeLearning. */
  recordTraining: (
    id: string,
    input: { task: string; rating: "up" | "down"; correction?: string },
  ) => void;
  /**
   * The user rated a real assistant message. 👍 captures its content as approved
   * knowledge and awards XP; 👎 records a negative run. No hand-typed text.
   */
  learnFromMessage: (
    id: string,
    input: { content: string; rating: "up" | "down"; messageId?: string },
  ) => void;
  /** The agent proposed a lesson after a turn; stored pending user approval. */
  proposeLearning: (id: string, content: string, messageId?: string) => string;
  /** Approve (keep) or reject (drop) an agent-proposed lesson. */
  resolveProposedLearning: (id: string, entryId: string, approve: boolean) => void;
  graduateSkill: (id: string) => void;
}

function makeId(prefix = "skl"): string {
  return `${prefix}_${Math.abs(hashString(`${Date.now()}:${globalThis.performance?.now?.() ?? 0}:${Math.floor(Math.random() * 1e9)}`)).toString(36)}`;
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

// Migrate one persisted skill to v4: backfill `learned`, converting legacy
// hand-typed corrections into approved learned entries (extracted to keep the
// migrate() callback shallow).
function migrateSkillToV4(s: Partial<Skill>): Skill {
  const examples = s.examples ?? [];
  const alreadyLearned = (s.learned ?? []).length > 0;
  const fromCorrections: LearnedEntry[] = alreadyLearned
    ? []
    : examples.flatMap((e) =>
        e.correction?.trim()
          ? [
              {
                id: makeId("lrn"),
                source: "correction" as const,
                content: e.correction.trim(),
                approved: true,
                at: e.at ?? Date.now(),
              },
            ]
          : [],
      );
  return { ...baseFields(), ...s, examples, learned: s.learned ?? fromCorrections } as Skill;
}

// Approve (keep) or reject (drop) a proposed learned entry by id.
function resolveLearned(
  learned: LearnedEntry[],
  entryId: string,
  approve: boolean,
): LearnedEntry[] {
  if (!approve) return learned.filter((l) => l.id !== entryId);
  return learned.map((l) => (l.id === entryId ? { ...l, approved: true } : l));
}

function baseFields(): Pick<
  Skill,
  "status" | "xp" | "runs" | "approvals" | "consecutiveApprovals" | "examples" | "learned"
> {
  return {
    status: "training",
    xp: 0,
    runs: 0,
    approvals: 0,
    consecutiveApprovals: 0,
    examples: [],
    learned: [],
  };
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
    ...baseFields(),
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
    ...baseFields(),
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "skl_e2e_browser",
    name: "E2E Browser Tester",
    icon: "🧪",
    description:
      "Verifies a web app end-to-end by driving the built-in agentic browser instead of writing Playwright.",
    instructions:
      "You are an end-to-end tester. When asked to verify a web flow, DO NOT write or run Playwright — drive the built-in agentic browser directly with the browser tools (browser_navigate, browser_snapshot, browser_click, browser_fill, browser_type, browser_screenshot, browser_wait). For each check: navigate to the URL, snapshot the page to find the target by its accessible name/role, act, then assert the observable result (URL, visible text, element state) and capture a screenshot as evidence. Report each step as pass/fail with the concrete observed value, and finish with a short summary and any flaky steps. Prefer real page facts over assumptions; if the browser is unavailable (browser_no_host / disabled), say so explicitly instead of guessing.",
    tags: ["e2e", "browser", "testing"],
    ...baseFields(),
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
          ...baseFields(),
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
      recordTraining: (id, input) =>
        set((state) => ({
          skills: state.skills.map((s) => {
            if (s.id !== id) return s;
            const up = input.rating === "up";
            const correction = input.correction?.trim();
            const example: SkillExample = {
              id: makeId("ex"),
              task: input.task.trim(),
              rating: input.rating,
              correction: correction || undefined,
              at: Date.now(),
            };
            return {
              ...s,
              runs: s.runs + 1,
              approvals: s.approvals + (up ? 1 : 0),
              consecutiveApprovals: up ? s.consecutiveApprovals + 1 : 0,
              xp: s.xp + (up ? XP_APPROVE : XP_REJECT),
              // A correction teaches the skill: append it to the instructions so
              // the next run behaves better (the "← learned" markers in the mock).
              instructions: correction
                ? `${s.instructions}\n\n- (learned) ${correction}`
                : s.instructions,
              examples: [example, ...s.examples].slice(0, 100),
              updatedAt: Date.now(),
            };
          }),
        })),
      learnFromMessage: (id, input) =>
        set((state) => ({
          skills: state.skills.map((s) => {
            if (s.id !== id) return s;
            const up = input.rating === "up";
            const content = input.content.trim();
            const learned: LearnedEntry[] =
              up && content
                ? [
                    {
                      id: makeId("lrn"),
                      source: "approved-answer" as const,
                      content,
                      approved: true,
                      messageId: input.messageId,
                      at: Date.now(),
                    },
                    ...s.learned,
                  ].slice(0, 200)
                : s.learned;
            return {
              ...s,
              runs: s.runs + 1,
              approvals: s.approvals + (up ? 1 : 0),
              consecutiveApprovals: up ? s.consecutiveApprovals + 1 : 0,
              xp: s.xp + (up ? XP_APPROVE : XP_REJECT),
              learned,
              updatedAt: Date.now(),
            };
          }),
        })),
      proposeLearning: (id, content, messageId) => {
        const entryId = makeId("lrn");
        set((state) => ({
          skills: state.skills.map((s) =>
            s.id === id
              ? {
                  ...s,
                  learned: [
                    {
                      id: entryId,
                      source: "proposed" as const,
                      content: content.trim(),
                      approved: false,
                      messageId,
                      at: Date.now(),
                    },
                    ...s.learned,
                  ].slice(0, 200),
                  updatedAt: Date.now(),
                }
              : s,
          ),
        }));
        return entryId;
      },
      resolveProposedLearning: (id, entryId, approve) =>
        set((state) => ({
          skills: state.skills.map((s) =>
            s.id === id
              ? {
                  ...s,
                  learned: resolveLearned(s.learned, entryId, approve),
                  updatedAt: Date.now(),
                }
              : s,
          ),
        })),
      graduateSkill: (id) =>
        set((state) => ({
          skills: state.skills.map((s) =>
            s.id === id ? { ...s, status: "graduated" as const, updatedAt: Date.now() } : s,
          ),
        })),
    }),
    {
      name: "@jagentdesk:skills",
      storage: createJSONStorage(() => AsyncStorage),
      version: 4,
      // v2→v3 added training/leveling fields. v3→v4 adds `learned` (knowledge from
      // real conversations) — backfill it, and migrate any legacy hand-typed
      // corrections in `examples` into approved learned entries so nothing is lost.
      migrate: (persisted) => {
        const state = (persisted as { skills?: Partial<Skill>[] } | undefined) ?? { skills: [] };
        const existing = (state.skills ?? []).map(migrateSkillToV4);
        const have = new Set(existing.map((s) => s.id));
        const missing = STARTER_SKILLS.filter((s) => !have.has(s.id));
        return { ...state, skills: [...existing, ...missing] };
      },
    },
  ),
);
