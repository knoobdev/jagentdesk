import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SKILL_DIR_SPECS } from "../skills-native/paths.js";
import {
  planCommandFiles,
  planSpecKitInit,
  specKitIntegrationFor,
  type PlannedFile,
  type SpecKitIntegration,
} from "./speckit/layout.js";
import { loadSpecKitSources, type SpecKitScriptVariant } from "./speckit/vendor.js";

/**
 * What enabling Spec mode writes into a workspace (spec 28.3 steps 2–3). Nothing is written
 * until the user confirms the listed files (step 4). An existing `.specify/` is never touched;
 * only the provider's missing command files are added, and `speckit-*` skills the user already
 * has (Skills, spec 22) are used instead of written.
 */
export interface WorkspaceSetupPlan {
  integration: SpecKitIntegration;
  script: SpecKitScriptVariant;
  /** True when the repo already had `.specify/` (spec 28.3 step 3). */
  existingSpecify: boolean;
  files: PlannedFile[];
}

export function hostScriptVariant(platform: NodeJS.Platform): SpecKitScriptVariant {
  return platform === "win32" ? "ps" : "sh";
}

async function existingScriptVariant(cwd: string): Promise<SpecKitScriptVariant | null> {
  try {
    const options: unknown = JSON.parse(
      await readFile(path.join(cwd, ".specify", "init-options.json"), "utf8"),
    );
    if (typeof options === "object" && options !== null && "script" in options) {
      const script = options.script;
      if (script === "sh" || script === "ps") return script;
    }
    return null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** A `speckit-*` skill the provider already loads from the user's or project's skill dirs. */
function hasInstalledSkill(params: {
  provider: string;
  skillName: string;
  cwd: string;
  homeDir: string;
}): boolean {
  return SKILL_DIR_SPECS.filter((spec) => spec.providers.includes(params.provider)).some(
    (spec) =>
      existsSync(path.join(params.homeDir, ...spec.global, params.skillName, "SKILL.md")) ||
      existsSync(path.join(params.cwd, ...spec.project, params.skillName, "SKILL.md")),
  );
}

function isCommandFileAlreadyPresent(params: {
  file: PlannedFile;
  integration: SpecKitIntegration;
  cwd: string;
  homeDir: string;
}): boolean {
  const { file, integration, cwd, homeDir } = params;
  if (existsSync(path.join(cwd, file.path))) return true;
  if (integration.kind !== "skills") return false;
  const skillName = path.posix.basename(path.posix.dirname(file.path));
  return hasInstalledSkill({ provider: integration.key, skillName, cwd, homeDir });
}

export async function planWorkspaceSetup(params: {
  cwd: string;
  baseProvider: string;
  platform: NodeJS.Platform;
  homeDir: string;
  now: number;
}): Promise<WorkspaceSetupPlan> {
  const sources = await loadSpecKitSources();
  const integration = specKitIntegrationFor(params.baseProvider);
  const existingSpecify = existsSync(path.join(params.cwd, ".specify"));
  const script = existingSpecify
    ? ((await existingScriptVariant(params.cwd)) ?? hostScriptVariant(params.platform))
    : hostScriptVariant(params.platform);
  const keep = (file: PlannedFile) =>
    !isCommandFileAlreadyPresent({ file, integration, cwd: params.cwd, homeDir: params.homeDir });

  if (existingSpecify) {
    const files =
      integration.kind === "prompt"
        ? []
        : planCommandFiles({ sources, integration, script }).filter(keep);
    return { integration, script, existingSpecify, files };
  }
  const files = planSpecKitInit({
    sources,
    integration,
    script,
    now: params.now,
    keepCommandFile: keep,
  });
  return { integration, script, existingSpecify, files };
}

/** True once every command the provider needs is installed (or the provider takes prompts). */
export function isWorkspaceSetUp(plan: WorkspaceSetupPlan): boolean {
  return plan.existingSpecify && plan.files.length === 0;
}

export class SpecModeSetupConflictError extends Error {
  constructor(readonly filePath: string) {
    super(`Spec mode setup would overwrite ${filePath}`);
    this.name = "SpecModeSetupConflictError";
  }
}

/** Write a confirmed plan. Refuses (before writing anything) if a planned file appeared since. */
export async function writeWorkspaceSetup(cwd: string, plan: WorkspaceSetupPlan): Promise<void> {
  for (const file of plan.files) {
    if (existsSync(path.join(cwd, file.path))) throw new SpecModeSetupConflictError(file.path);
  }
  for (const file of plan.files) {
    const target = path.join(cwd, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { encoding: "utf8", flag: "wx" });
    await chmod(target, file.mode);
  }
}
