import { create } from "zustand";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import {
  applySkillMutation,
  type Skill,
  type SkillDraft,
  type SkillMutation,
} from "@jagentdesk/protocol/skills";

/**
 * Skills are daemon-owned and protocol-synced (see packages/protocol/src/skills.ts
 * and the server SkillsStorage). This store is a thin, reactive CACHE of the
 * active host's skills: it hydrates from `skills.get`, stays live via the
 * `status:skills_changed` broadcast, and every mutation is sent to the daemon
 * through `skills.mutate`. The daemon is authoritative, so a skill's XP/level is
 * identical on desktop and mobile (previously each device kept its own local
 * copy in AsyncStorage, which is exactly why progress diverged).
 *
 * Optimistic updates use the SAME reducer the daemon runs (`applySkillMutation`),
 * so the pre-broadcast state can never drift from the authoritative result.
 */

// Re-export the shared types + pure helpers so existing consumers keep importing
// them from this module unchanged.
export {
  levelForXp,
  tierName,
  levelProgress,
  approvalRate,
  graduationStatus,
  skillEffectivePrompt,
  XP_PER_LEVEL,
  MAX_LEVEL,
} from "@jagentdesk/protocol/skills";
export type {
  Skill,
  SkillDraft,
  SkillExample,
  SkillStatus,
  LearnedEntry,
  LevelProgress,
  ChecklistItem,
  GraduationStatus,
} from "@jagentdesk/protocol/skills";

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
   * knowledge and awards XP; 👎 records a negative run.
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

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

function makeId(prefix = "skl"): string {
  return `${prefix}_${Math.abs(
    hashString(
      `${Date.now()}:${globalThis.performance?.now?.() ?? 0}:${Math.floor(Math.random() * 1e9)}`,
    ),
  ).toString(36)}`;
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

// ── Daemon sync binding ──────────────────────────────────────────────────────
let boundClient: DaemonClient | null = null;
let boundServerId: string | null = null;
let unsubscribeStatus: (() => void) | null = null;

/**
 * Point the store at a host's daemon: hydrate the cache and keep it live via the
 * `status:skills_changed` broadcast. Idempotent per (client, serverId).
 */
export function bindSkillsSync(client: DaemonClient, serverId: string): void {
  if (boundClient === client && boundServerId === serverId) {
    return;
  }
  unbindSkillsSync();
  boundClient = client;
  boundServerId = serverId;
  unsubscribeStatus = client.on("status", (message) => {
    const payload = message.payload as { status?: string; skills?: Skill[] };
    if (payload.status === "skills_changed" && Array.isArray(payload.skills)) {
      useSkillsStore.setState({ skills: payload.skills });
    }
  });
  void (async () => {
    try {
      const { skills } = await client.getSkills();
      if (boundClient === client) {
        useSkillsStore.setState({ skills });
      }
    } catch (error) {
      console.error("[skills] failed to load skills from daemon", error);
    }
  })();
}

export function unbindSkillsSync(): void {
  unsubscribeStatus?.();
  unsubscribeStatus = null;
  boundClient = null;
  boundServerId = null;
}

/** Apply optimistically (shared reducer) and send to the daemon (authoritative). */
function sendMutation(mutation: SkillMutation): void {
  useSkillsStore.setState((state) => ({ skills: applySkillMutation(state.skills, mutation) }));
  const client = boundClient;
  if (!client) {
    return;
  }
  void (async () => {
    try {
      const { skills } = await client.mutateSkills(mutation);
      useSkillsStore.setState({ skills });
    } catch (error) {
      console.error("[skills] mutate failed", error);
    }
  })();
}

export const useSkillsStore = create<SkillsState>()((_set) => ({
  skills: [],
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
    sendMutation({ op: "add", skill });
    return skill;
  },
  updateSkill: (id, patch) => sendMutation({ op: "update", id, patch }),
  removeSkill: (id) => sendMutation({ op: "remove", id }),
  recordTraining: (id, input) =>
    sendMutation({
      op: "train",
      id,
      exampleId: makeId("ex"),
      task: input.task,
      rating: input.rating,
      ...(input.correction !== undefined ? { correction: input.correction } : {}),
    }),
  learnFromMessage: (id, input) =>
    sendMutation({
      op: "learn",
      id,
      entryId: makeId("lrn"),
      rating: input.rating,
      content: input.content,
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    }),
  proposeLearning: (id, content, messageId) => {
    const entryId = makeId("lrn");
    sendMutation({
      op: "propose",
      id,
      entryId,
      content,
      ...(messageId !== undefined ? { messageId } : {}),
    });
    return entryId;
  },
  resolveProposedLearning: (id, entryId, approve) =>
    sendMutation({ op: "resolve", id, entryId, approve }),
  graduateSkill: (id) => sendMutation({ op: "graduate", id }),
}));
