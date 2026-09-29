import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import { SkillSchema, type Skill } from "@jagentdesk/protocol/skills";
import { SKILL_DESCRIPTION_MAX_LENGTH, type SkillEntry } from "@jagentdesk/protocol/native-skills";
import { pathExists } from "./fs-utils.js";
import { composeBody, renderSkillMarkdown, slugifySkillName } from "./frontmatter.js";
import type { TrainingState } from "./lock-store.js";
import { findAvailableName, installOwned, installTargets, type OpsContext } from "./owned-ops.js";

/**
 * Spec 22.10: turn every legacy JSON skill (`skills/skills.json`) into an owned
 * global SKILL.md skill (`~/.agents/skills/<slug>` + symlinks), move XP/history
 * into lock.json, then rename the JSON file to `skills.json.migrated.bak`.
 *
 * Idempotent: a skill whose legacy id is already in the lock is skipped, and the
 * JSON file is only renamed once every skill migrated — a failed start retries
 * the rest on the next start.
 */
const LEGACY_STARTER_SKILL_IDS = new Set(["skl_k8s_doctor", "skl_pr_reviewer", "skl_e2e_browser"]);

function isPristineStarter(skill: Skill): boolean {
  return (
    LEGACY_STARTER_SKILL_IDS.has(skill.id) &&
    skill.xp === 0 &&
    skill.runs === 0 &&
    skill.approvals === 0 &&
    skill.examples.length === 0 &&
    skill.learned.length === 0
  );
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? ""
  );
}

export function legacySkillMarkdown(skill: Skill, name: string): string {
  const approved = skill.learned
    .filter((entry) => entry.approved)
    .toReversed() // legacy list is newest-first; the lessons section reads oldest-first
    .map((entry) => entry.content.trim())
    .filter(Boolean);
  const description =
    skill.description.trim() || firstLine(skill.instructions) || skill.name.trim() || name;
  return renderSkillMarkdown({
    name,
    description: description.slice(0, SKILL_DESCRIPTION_MAX_LENGTH),
    body: composeBody(skill.instructions, approved),
  });
}

function legacyTraining(skill: Skill): TrainingState {
  return {
    xp: skill.xp,
    runs: skill.runs,
    approvals: skill.approvals,
    consecutiveApprovals: skill.consecutiveApprovals,
    status: skill.status,
    examples: skill.examples,
    pending: skill.learned.filter((entry) => !entry.approved),
  };
}

async function readLegacy(file: string, logger: Logger): Promise<Skill[] | null> {
  try {
    return z.array(SkillSchema).parse(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err: error, file }, "Legacy skills.json unreadable; not migrated");
    }
    return null;
  }
}

async function backupPath(file: string, now: number): Promise<string> {
  const base = `${file}.migrated.bak`;
  return (await pathExists(base)) ? `${base}.${now}` : base;
}

export interface MigrationInput {
  skillsHome: string;
  ctx: OpsContext;
  logger: Logger;
  existing: () => Promise<SkillEntry[]>;
  persist: () => Promise<void>;
}

/** Returns how many skills were migrated in this run. */
export async function migrateLegacySkills(input: MigrationInput): Promise<number> {
  const file = path.join(input.skillsHome, "skills.json");
  const legacy = await readLegacy(file, input.logger);
  if (!legacy) return 0;
  const { ctx } = input;
  let migrated = 0;
  let failed = 0;
  for (const skill of legacy.filter((candidate) => !isPristineStarter(candidate))) {
    if (ctx.lock.skills.some((record) => record.legacyId === skill.id)) continue;
    try {
      const name = await findAvailableName(
        ctx,
        slugifySkillName(skill.name),
        "global",
        null,
        await input.existing(),
      );
      const content = legacySkillMarkdown(skill, name);
      await installOwned(ctx, installTargets(ctx, name, "global", null), {
        name,
        scope: "global",
        projectRoot: null,
        source: { kind: "migrated", ref: skill.id, revision: null },
        legacy: {
          legacyId: skill.id,
          displayName: skill.name,
          icon: skill.icon || null,
          tags: skill.tags,
        },
        training: legacyTraining(skill),
        installedAtMs: skill.createdAt || ctx.now(),
        populate: async (realPath) => {
          await fs.mkdir(realPath, { recursive: true });
          await fs.writeFile(path.join(realPath, "SKILL.md"), content);
        },
      });
      await input.persist();
      migrated += 1;
    } catch (error) {
      failed += 1;
      input.logger.error({ err: error, skillId: skill.id }, "Failed to migrate legacy skill");
    }
  }
  if (failed === 0) {
    await fs.rename(file, await backupPath(file, ctx.now()));
  }
  return migrated;
}
