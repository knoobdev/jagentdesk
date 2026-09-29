import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { LearnedEntrySchema, SkillExampleSchema } from "@jagentdesk/protocol/skills";
import {
  SkillDirLabelSchema,
  SkillScopeSchema,
  SkillSourceInfoSchema,
} from "@jagentdesk/protocol/native-skills";
import { writeJsonFileAtomic } from "../atomic-file.js";

/**
 * `$JAGENTDESK_HOME/skills/lock.json` — everything JAgentDesk wrote for skills
 * (ADR-0022 decision 3). Uninstall removes exactly what is listed here; a
 * disabled or removed pre-existing skill is recorded so it can be restored
 * byte-for-byte. XP / approvals of owned skills live here too (spec 22.9), never
 * in the SKILL.md frontmatter.
 */
export const TrainingStateSchema = z.object({
  xp: z.number(),
  runs: z.number(),
  approvals: z.number(),
  consecutiveApprovals: z.number(),
  status: z.enum(["training", "graduated"]),
  examples: z.array(SkillExampleSchema),
  /** Proposed lessons not yet approved (approved ones live in SKILL.md). */
  pending: z.array(LearnedEntrySchema),
});
export type TrainingState = z.infer<typeof TrainingStateSchema>;

export const LockLinkSchema = z.object({ dir: SkillDirLabelSchema, path: z.string() });

export const OwnedSkillRecordSchema = z.object({
  /** Directory name == frontmatter name. */
  name: z.string(),
  scope: SkillScopeSchema,
  projectRoot: z.string().nullable(),
  realPath: z.string(),
  links: z.array(LockLinkSchema),
  enabled: z.boolean(),
  /** Where the real directory sits while disabled. */
  disabledPath: z.string().nullable(),
  source: SkillSourceInfoSchema,
  contentHash: z.string(),
  installed_at_ms: z.number(),
  updated_at_ms: z.number(),
  legacyId: z.string().nullable(),
  displayName: z.string().nullable(),
  icon: z.string().nullable(),
  tags: z.array(z.string()),
  training: TrainingStateSchema,
});
export type OwnedSkillRecord = z.infer<typeof OwnedSkillRecordSchema>;

export const MovedEntrySchema = z.object({
  dir: SkillDirLabelSchema,
  originalPath: z.string(),
  backupPath: z.string(),
  kind: z.enum(["dir", "symlink"]),
});
export type MovedEntry = z.infer<typeof MovedEntrySchema>;

/** A pre-existing (non-owned) skill moved aside by disable or uninstall. */
export const MovedSkillRecordSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  description: z.string(),
  scope: SkillScopeSchema,
  projectRoot: z.string().nullable(),
  entries: z.array(MovedEntrySchema),
  contentHash: z.string(),
  moved_at_ms: z.number(),
});
export type MovedSkillRecord = z.infer<typeof MovedSkillRecordSchema>;

export const PluginInstallRecordSchema = z.object({
  provider: z.string(),
  plugin: z.string(),
  marketplace: z.string(),
  scope: SkillScopeSchema,
  projectRoot: z.string().nullable(),
  command: z.array(z.string()),
  ok: z.boolean(),
  installed_at_ms: z.number(),
});
export type PluginInstallRecord = z.infer<typeof PluginInstallRecordSchema>;

export const SkillsLockSchema = z.object({
  version: z.literal(1),
  skills: z.array(OwnedSkillRecordSchema),
  disabled: z.array(MovedSkillRecordSchema),
  removed: z.array(MovedSkillRecordSchema),
  plugins: z.array(PluginInstallRecordSchema),
  /** Parent directories JAgentDesk created; removed again once empty. */
  createdDirs: z.array(z.string()),
});
export type SkillsLock = z.infer<typeof SkillsLockSchema>;

export function emptyLock(): SkillsLock {
  return { version: 1, skills: [], disabled: [], removed: [], plugins: [], createdDirs: [] };
}

export function emptyTraining(): TrainingState {
  return {
    xp: 0,
    runs: 0,
    approvals: 0,
    consecutiveApprovals: 0,
    status: "training",
    examples: [],
    pending: [],
  };
}

export class SkillsLockStore {
  readonly lockPath: string;
  private readonly logger: Logger;

  constructor(skillsHome: string, logger: Logger) {
    this.lockPath = path.join(skillsHome, "lock.json");
    this.logger = logger;
  }

  async load(): Promise<SkillsLock> {
    let raw: string;
    try {
      raw = await fs.readFile(this.lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return emptyLock();
    }
    try {
      return SkillsLockSchema.parse(JSON.parse(raw));
    } catch (error) {
      // Keep the unreadable file for inspection; start empty so nothing is
      // treated as owned (and therefore nothing is ever deleted by mistake).
      const aside = `${this.lockPath}.corrupt-${Date.now()}`;
      await fs.rename(this.lockPath, aside).catch(() => undefined);
      this.logger.error({ err: error, aside }, "Unreadable skills lock.json moved aside");
      return emptyLock();
    }
  }

  async save(lock: SkillsLock): Promise<void> {
    await writeJsonFileAtomic(this.lockPath, lock);
  }
}
