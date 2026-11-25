import { promises as fs } from "node:fs";
import path from "node:path";
import type { LearnedEntry, Skill } from "@jagentdesk/protocol/skills";
import { parseSkillMarkdown, readSkillMetadata, splitLessons } from "./frontmatter.js";
import type { OwnedSkillRecord, TrainingState } from "./lock-store.js";
import { ownedSkillId } from "./owned-ops.js";

/**
 * COMPAT(nativeSkills): the legacy `Skill` view (`skills.get`,
 * `status:skills_changed.skills`) of owned native skills, so an app that
 * predates spec 22 keeps working. Migrated skills keep their legacy id so the
 * app's per-agent attachments stay valid.
 */
export function compatSkillId(record: OwnedSkillRecord): string {
  return record.legacyId ?? ownedSkillId(record);
}

export interface SkillContent {
  description: string;
  instructions: string;
  lessons: string[];
}

export async function readOwnedContent(record: OwnedSkillRecord): Promise<SkillContent> {
  const dir = record.enabled ? record.realPath : (record.disabledPath ?? record.realPath);
  let raw = "";
  try {
    raw = await fs.readFile(path.join(dir, "SKILL.md"), "utf8");
  } catch {
    return { description: "", instructions: "", lessons: [] };
  }
  const parsed = parseSkillMarkdown(raw);
  const { instructions, lessons } = splitLessons(parsed.body);
  return { description: readSkillMetadata(parsed.frontmatter).description, instructions, lessons };
}

function lessonEntries(id: string, lessons: string[], at: number): LearnedEntry[] {
  // Newest first, like the legacy store.
  return lessons
    .map((content, index) => ({
      id: `${id}:lesson:${index}`,
      source: "approved-answer" as const,
      content,
      approved: true,
      at,
    }))
    .toReversed();
}

export function toLegacySkill(record: OwnedSkillRecord, content: SkillContent): Skill {
  const id = compatSkillId(record);
  const t = record.training;
  return {
    id,
    name: record.displayName ?? record.name,
    icon: record.icon ?? "✦",
    description: content.description,
    instructions: content.instructions,
    tags: record.tags,
    status: t.status,
    xp: t.xp,
    runs: t.runs,
    approvals: t.approvals,
    consecutiveApprovals: t.consecutiveApprovals,
    examples: t.examples,
    learned: [...t.pending, ...lessonEntries(id, content.lessons, record.updated_at_ms)],
    createdAt: record.installed_at_ms,
    updatedAt: record.updated_at_ms,
  };
}

/** Synthetic legacy skill used to run the shared XP reducer on lock training state. */
export function trainingAsSkill(record: OwnedSkillRecord): Skill {
  return toLegacySkill(record, { description: "", instructions: "", lessons: [] });
}

export function trainingFromSkill(skill: Skill, pending: LearnedEntry[]): TrainingState {
  return {
    xp: skill.xp,
    runs: skill.runs,
    approvals: skill.approvals,
    consecutiveApprovals: skill.consecutiveApprovals,
    status: skill.status,
    examples: skill.examples,
    pending,
  };
}
