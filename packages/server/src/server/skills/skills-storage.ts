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
    // Seed the starter skills the first time (or backfill any that were removed
    // from an older store), matching the client's previous local seed.
    const have = new Set(this.skills.map((s) => s.id));
    const missing = STARTER_SKILLS.filter((s) => !have.has(s.id));
    if (missing.length > 0) {
      this.skills = [...this.skills, ...missing];
    }
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
