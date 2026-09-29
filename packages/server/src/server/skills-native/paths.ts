import path from "node:path";
import {
  SKILL_PROVIDER_ORDER,
  type SkillDirLabel,
  type SkillScope,
} from "@jagentdesk/protocol/native-skills";

interface SkillDirSpec {
  label: SkillDirLabel;
  /** Path segments below the user's home directory. */
  global: readonly string[];
  /** Path segments below the project root. */
  project: readonly string[];
  /** Providers that read this directory (spec 22.3). */
  providers: readonly string[];
}

/** Spec 22.3: every directory the daemon scans (read-only unless it installs there). */
export const SKILL_DIR_SPECS: readonly SkillDirSpec[] = [
  {
    label: "agents",
    global: [".agents", "skills"],
    project: [".agents", "skills"],
    providers: ["codex", "opencode", "cursor", "copilot", "pi", "omp", "kimi"],
  },
  {
    label: "claude",
    global: [".claude", "skills"],
    project: [".claude", "skills"],
    providers: ["claude", "opencode", "cursor", "kimi", "omp"],
  },
  { label: "kiro", global: [".kiro", "skills"], project: [".kiro", "skills"], providers: ["kiro"] },
  {
    label: "codex",
    global: [".codex", "skills"],
    project: [".codex", "skills"],
    providers: ["codex"],
  },
  {
    label: "opencode",
    global: [".config", "opencode", "skills"],
    project: [".opencode", "skills"],
    providers: ["opencode"],
  },
  {
    label: "copilot",
    global: [".copilot", "skills"],
    project: [".github", "skills"],
    providers: ["copilot"],
  },
  {
    label: "cursor",
    global: [".cursor", "skills"],
    project: [".cursor", "skills"],
    providers: ["cursor"],
  },
  {
    label: "pi",
    global: [".pi", "agent", "skills"],
    project: [".pi", "skills"],
    providers: ["pi"],
  },
  {
    label: "omp",
    global: [".omp", "agent", "skills"],
    project: [".omp", "skills"],
    providers: ["omp"],
  },
  { label: "kimi", global: [".kimi", "skills"], project: [".kimi", "skills"], providers: ["kimi"] },
];

/** ADR-0022 decision 2: one real copy here, symlinked into {@link INSTALL_LINK_DIRS}. */
export const INSTALL_REAL_DIR: SkillDirLabel = "agents";
export const INSTALL_LINK_DIRS: readonly SkillDirLabel[] = ["claude", "kiro"];

function specFor(label: SkillDirLabel): SkillDirSpec {
  const spec = SKILL_DIR_SPECS.find((candidate) => candidate.label === label);
  if (!spec) {
    throw new Error(`Unknown skill directory label: ${label}`);
  }
  return spec;
}

export function skillDirPath(label: SkillDirLabel, scope: SkillScope, root: string): string {
  const spec = specFor(label);
  return path.join(root, ...(scope === "global" ? spec.global : spec.project));
}

export function providersForDir(label: SkillDirLabel): readonly string[] {
  return specFor(label).providers;
}

/** Providers that see a skill present in the given directories, in display order. */
export function visibleToFor(labels: Iterable<SkillDirLabel>): string[] {
  const providers = new Set<string>();
  for (const label of labels) {
    for (const provider of providersForDir(label)) {
      providers.add(provider);
    }
  }
  return SKILL_PROVIDER_ORDER.filter((provider) => providers.has(provider));
}

export function isWithin(root: string, target: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function buildSkillId(scope: SkillScope, label: SkillDirLabel, dirName: string): string {
  return `${scope}:${label}:${dirName}`;
}

export interface ParsedSkillId {
  scope: SkillScope;
  label: SkillDirLabel;
  dirName: string;
}

export function parseSkillId(skillId: string): ParsedSkillId | null {
  const [scope, label, ...rest] = skillId.split(":");
  const dirName = rest.join(":");
  if (scope !== "global" && scope !== "project") return null;
  if (!SKILL_DIR_SPECS.some((spec) => spec.label === label)) return null;
  if (!dirName || dirName.includes("/") || dirName.includes("\\") || dirName.startsWith(".")) {
    return null;
  }
  return { scope, label: label as SkillDirLabel, dirName };
}
