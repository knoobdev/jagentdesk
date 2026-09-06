import { promises as fs } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import {
  applySkillMutation,
  SkillSchema,
  type Skill,
  type SkillMutation,
} from "@jagentdesk/protocol/skills";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";

const StoredSkillsSchema = z.array(SkillSchema);

type SkillsListener = (skills: Skill[]) => void;

/**
 * Daemon-owned store for trained skills. This is the single source of truth for
 * skill XP/level/knowledge: every connected client (desktop and mobile) reads
 * and mutates the same records through the `skills.*` RPCs, so progress can no
 * longer diverge between devices (previously each device kept its own local
 * copy in AsyncStorage). Persisted as a single JSON file, mutated through the
 * authoritative reducer below.
 */
export class SkillsStorage {
  private readonly storePath: string;
  private readonly logger: Logger;
  private skills: Skill[] = [];
  private loaded = false;
  private persistQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<SkillsListener>();

  constructor(jagentdeskHome: string, logger: Logger) {
    this.storePath = path.join(jagentdeskHome, "skills", "skills.json");
    this.logger = logger.child({ module: "skills", component: "skills-storage" });
  }

  async initialize(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.storePath, "utf8");
      this.skills = StoredSkillsSchema.parse(JSON.parse(raw));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        this.logger.error({ err: error, storePath: this.storePath }, "Failed to load skills");
      }
      this.skills = [];
    }
    // No default/starter skills: the store starts empty and only holds skills the
    // user (or an agent via create_skill) explicitly creates. Any pristine, never-
    // trained legacy starter left over from an older build is removed one time here,
    // so upgrading installs don't keep the old defaults; a starter the user actually
    // trained (has XP/runs/knowledge) is preserved.
    this.skills = this.skills.filter(
      (skill) => !(LEGACY_STARTER_SKILL_IDS.has(skill.id) && isPristineSkill(skill)),
    );
    this.loaded = true;
    await this.persist();
  }

  get(): Skill[] {
    return this.skills;
  }

  onChange(listener: SkillsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Apply a client mutation authoritatively (XP/counting/caps live here). */
  async mutate(mutation: SkillMutation): Promise<Skill[]> {
    this.skills = applySkillMutation(this.skills, mutation);
    await this.persist();
    for (const listener of this.listeners) {
      listener(this.skills);
    }
    return this.skills;
  }

  private async persist(): Promise<void> {
    const next = this.persistQueue.then(async () => {
      await writeJsonFileAtomic(this.storePath, this.skills);
      return;
    });
    this.persistQueue = next.catch(() => {});
    await next;
  }
}

// IDs of the old built-in starter skills. Kept only so an upgrading install can
// drop them one time (see initialize) — no starters are seeded anymore.
const LEGACY_STARTER_SKILL_IDS = new Set(["skl_k8s_doctor", "skl_pr_reviewer", "skl_e2e_browser"]);

// A skill the user never touched: no XP, no runs/approvals, no examples/knowledge.
// Only such pristine legacy starters are auto-removed; a trained one is preserved.
function isPristineSkill(skill: Skill): boolean {
  return (
    skill.xp === 0 &&
    skill.runs === 0 &&
    skill.approvals === 0 &&
    skill.examples.length === 0 &&
    skill.learned.length === 0
  );
}
