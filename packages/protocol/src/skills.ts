import { z } from "zod";

/**
 * Skills are daemon-owned, protocol-synced trained assistants. A Skill is a
 * reusable system prompt (its `instructions`) plus presentation and training
 * progress (XP / runs / approvals / learned knowledge). The daemon on the work
 * machine is the single source of truth; every connected client (desktop and
 * mobile) reads the same skills over `skills.get` + `status:skills_changed` and
 * mutates them through `skills.mutate`, so XP and level never diverge between
 * devices.
 */
export type SkillStatus = "training" | "graduated";
export const SkillStatusSchema = z.enum(["training", "graduated"]);

export const SkillExampleSchema = z.object({
  id: z.string(),
  task: z.string(),
  rating: z.enum(["up", "down"]),
  correction: z.string().optional(),
  at: z.number(),
});
export type SkillExample = z.infer<typeof SkillExampleSchema>;

/**
 * Knowledge a skill learned from a real conversation. Sources:
 * - "approved-answer": the user 👍'd an assistant message; its content is captured.
 * - "proposed": the agent proposed a lesson after a turn; pending user approval.
 * - "correction": (legacy) a hand-typed correction — kept for migration only.
 */
export const LearnedEntrySchema = z.object({
  id: z.string(),
  source: z.enum(["approved-answer", "proposed", "correction"]),
  content: z.string(),
  approved: z.boolean(),
  messageId: z.string().optional(),
  at: z.number(),
});
export type LearnedEntry = z.infer<typeof LearnedEntrySchema>;

export const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string(),
  instructions: z.string(),
  tags: z.array(z.string()),
  status: SkillStatusSchema,
  xp: z.number(),
  runs: z.number(),
  approvals: z.number(),
  consecutiveApprovals: z.number(),
  examples: z.array(SkillExampleSchema),
  learned: z.array(LearnedEntrySchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Skill = z.infer<typeof SkillSchema>;

export interface SkillDraft {
  name: string;
  icon?: string;
  description?: string;
  instructions: string;
  tags?: string[];
}

export const SkillDraftPatchSchema = z.object({
  name: z.string().optional(),
  icon: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type SkillDraftPatch = z.infer<typeof SkillDraftPatchSchema>;

// ── Leveling (pure, shared by daemon + clients) ──────────────────────────────
export const XP_PER_LEVEL = 300;
export const MAX_LEVEL = 5;
export const XP_APPROVE = 60;
export const XP_REJECT = 15;
export const MAX_EXAMPLES = 100;
export const MAX_LEARNED = 200;
const TIER_NAMES = ["Novice", "Apprentice", "Skilled", "Proficient", "Expert"] as const;

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

// ── Mutations (client builds ids; daemon applies XP/counting authoritatively) ─
export const SkillMutationSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), skill: SkillSchema }),
  z.object({ op: z.literal("update"), id: z.string(), patch: SkillDraftPatchSchema }),
  z.object({ op: z.literal("remove"), id: z.string() }),
  z.object({
    op: z.literal("train"),
    id: z.string(),
    exampleId: z.string(),
    task: z.string(),
    rating: z.enum(["up", "down"]),
    correction: z.string().optional(),
  }),
  z.object({
    op: z.literal("learn"),
    id: z.string(),
    entryId: z.string(),
    rating: z.enum(["up", "down"]),
    content: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    op: z.literal("propose"),
    id: z.string(),
    entryId: z.string(),
    content: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    op: z.literal("resolve"),
    id: z.string(),
    entryId: z.string(),
    approve: z.boolean(),
  }),
  z.object({ op: z.literal("graduate"), id: z.string() }),
]);
export type SkillMutation = z.infer<typeof SkillMutationSchema>;

// ── RPC: skills.get / skills.mutate ──────────────────────────────────────────
export const SkillsGetRequestSchema = z.object({
  type: z.literal("skills.get.request"),
  requestId: z.string(),
});
export const SkillsGetResponseSchema = z.object({
  type: z.literal("skills.get.response"),
  payload: z.object({ requestId: z.string(), skills: z.array(SkillSchema) }),
});

export const SkillsMutateRequestSchema = z.object({
  type: z.literal("skills.mutate.request"),
  requestId: z.string(),
  mutation: SkillMutationSchema,
});
export const SkillsMutateResponseSchema = z.object({
  type: z.literal("skills.mutate.response"),
  payload: z.object({ requestId: z.string(), skills: z.array(SkillSchema) }),
});

export type SkillsGetRequest = z.infer<typeof SkillsGetRequestSchema>;
export type SkillsMutateRequest = z.infer<typeof SkillsMutateRequestSchema>;

// ── pushEvent: status:skills_changed ─────────────────────────────────────────
export const SkillsChangedStatusPayloadSchema = z.object({
  status: z.literal("skills_changed"),
  skills: z.array(SkillSchema),
});

/**
 * The authoritative skill reducer, shared by the daemon (source of truth) and
 * the clients (optimistic update before the `status:skills_changed` broadcast
 * arrives). Using one function on both sides means an optimistic update can
 * never diverge from what the daemon computes. Clients build the ids (skill /
 * example / learned-entry) so their optimistic record and the broadcast one
 * carry the same id; timestamps are stamped here and reconciled to the daemon's
 * value on broadcast.
 */
export function applySkillMutation(skills: Skill[], mutation: SkillMutation): Skill[] {
  const now = Date.now();
  switch (mutation.op) {
    case "add": {
      // Trust only presentation fields; force progress to baseline so a client
      // can never inject XP by crafting the add payload.
      const s = mutation.skill;
      const skill: Skill = {
        id: s.id,
        name: s.name.trim() || "Untitled skill",
        icon: s.icon.trim() || "✦",
        description: s.description.trim(),
        instructions: s.instructions.trim(),
        tags: s.tags.filter(Boolean),
        status: "training",
        xp: 0,
        runs: 0,
        approvals: 0,
        consecutiveApprovals: 0,
        examples: [],
        learned: [],
        createdAt: s.createdAt || now,
        updatedAt: now,
      };
      return [skill, ...skills.filter((existing) => existing.id !== skill.id)];
    }
    case "update":
      return skills.map((s) =>
        s.id === mutation.id
          ? {
              ...s,
              ...(mutation.patch.name !== undefined ? { name: mutation.patch.name.trim() } : {}),
              ...(mutation.patch.icon !== undefined ? { icon: mutation.patch.icon.trim() } : {}),
              ...(mutation.patch.description !== undefined
                ? { description: mutation.patch.description }
                : {}),
              ...(mutation.patch.instructions !== undefined
                ? { instructions: mutation.patch.instructions.trim() }
                : {}),
              ...(mutation.patch.tags !== undefined
                ? { tags: mutation.patch.tags.filter(Boolean) }
                : {}),
              updatedAt: now,
            }
          : s,
      );
    case "remove":
      return skills.filter((s) => s.id !== mutation.id);
    case "train":
      return skills.map((s) => {
        if (s.id !== mutation.id) return s;
        const up = mutation.rating === "up";
        const correction = mutation.correction?.trim();
        const example: SkillExample = {
          id: mutation.exampleId,
          task: mutation.task.trim(),
          rating: mutation.rating,
          ...(correction ? { correction } : {}),
          at: now,
        };
        return {
          ...s,
          runs: s.runs + 1,
          approvals: s.approvals + (up ? 1 : 0),
          consecutiveApprovals: up ? s.consecutiveApprovals + 1 : 0,
          xp: s.xp + (up ? XP_APPROVE : XP_REJECT),
          instructions: correction
            ? `${s.instructions}\n\n- (learned) ${correction}`
            : s.instructions,
          examples: [example, ...s.examples].slice(0, MAX_EXAMPLES),
          updatedAt: now,
        };
      });
    case "learn":
      return skills.map((s) => {
        if (s.id !== mutation.id) return s;
        const up = mutation.rating === "up";
        const content = mutation.content.trim();
        const learned: LearnedEntry[] =
          up && content
            ? [
                {
                  id: mutation.entryId,
                  source: "approved-answer" as const,
                  content,
                  approved: true,
                  ...(mutation.messageId ? { messageId: mutation.messageId } : {}),
                  at: now,
                },
                ...s.learned,
              ].slice(0, MAX_LEARNED)
            : s.learned;
        return {
          ...s,
          runs: s.runs + 1,
          approvals: s.approvals + (up ? 1 : 0),
          consecutiveApprovals: up ? s.consecutiveApprovals + 1 : 0,
          xp: s.xp + (up ? XP_APPROVE : XP_REJECT),
          learned,
          updatedAt: now,
        };
      });
    case "propose":
      return skills.map((s) =>
        s.id === mutation.id
          ? {
              ...s,
              learned: [
                {
                  id: mutation.entryId,
                  source: "proposed" as const,
                  content: mutation.content.trim(),
                  approved: false,
                  ...(mutation.messageId ? { messageId: mutation.messageId } : {}),
                  at: now,
                },
                ...s.learned,
              ].slice(0, MAX_LEARNED),
              updatedAt: now,
            }
          : s,
      );
    case "resolve":
      return skills.map((s) =>
        s.id === mutation.id
          ? {
              ...s,
              learned: mutation.approve
                ? s.learned.map((l) => (l.id === mutation.entryId ? { ...l, approved: true } : l))
                : s.learned.filter((l) => l.id !== mutation.entryId),
              updatedAt: now,
            }
          : s,
      );
    case "graduate":
      return skills.map((s) =>
        s.id === mutation.id ? { ...s, status: "graduated" as const, updatedAt: now } : s,
      );
    default:
      return skills;
  }
}
