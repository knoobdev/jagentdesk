import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The pinned spec-kit copy in `packages/server/vendor/spec-kit` (ADR-0030 decision 1).
 * Orders below are the directory order of the 1.3.0 wheel's `core_pack`, which is the
 * order `specify init` records files in its manifests; keeping them makes the generated
 * manifests byte-identical to the CLI's.
 */
export const SPECKIT_VERSION = "1.3.0";
export const SPECKIT_COMMIT = "34a0d388eac671d656eb05b125ad3ed6056168ed";

export const SPECKIT_COMMANDS = [
  "analyze",
  "clarify",
  "constitution",
  "implement",
  "converge",
  "plan",
  "checklist",
  "specify",
  "tasks",
] as const;
export type SpecKitCommand = (typeof SPECKIT_COMMANDS)[number];

export type SpecKitScriptVariant = "sh" | "ps";

export const SPECKIT_SCRIPT_FILES: Record<SpecKitScriptVariant, readonly string[]> = {
  sh: [
    "common.sh",
    "setup-plan.sh",
    "setup-tasks.sh",
    "check-prerequisites.sh",
    "resolve-template.sh",
    "create-new-feature.sh",
  ],
  ps: [
    "resolve-template.ps1",
    "setup-tasks.ps1",
    "check-prerequisites.ps1",
    "common.ps1",
    "setup-plan.ps1",
    "create-new-feature.ps1",
  ],
};

export const SPECKIT_SCRIPT_DIRS: Record<SpecKitScriptVariant, string> = {
  sh: "bash",
  ps: "powershell",
};

export const SPECKIT_PAGE_TEMPLATES = [
  "constitution-template.md",
  "checklist-template.md",
  "tasks-template.md",
  "spec-template.md",
  "plan-template.md",
] as const;

/** `workflow.yml` header of the bundled `speckit` workflow, as `specify init` registers it. */
export const SPECKIT_WORKFLOW = {
  id: "speckit",
  name: "Full SDD Cycle",
  version: "1.0.1",
  description: "Runs specify → plan → tasks → implement with review gates",
} as const;

// Source layout: src/server/spec-mode/speckit → ../../../../vendor/spec-kit.
// Build layout:  dist/server/server/spec-mode/speckit → ../../../vendor/spec-kit.
const VENDOR_CANDIDATES = ["../../../../vendor/spec-kit", "../../../vendor/spec-kit"];

export class SpecKitVendorMissingError extends Error {
  constructor() {
    super("spec-kit is not bundled with this daemon (vendor/spec-kit missing)");
    this.name = "SpecKitVendorMissingError";
  }
}

export function resolveSpecKitVendorDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of VENDOR_CANDIDATES) {
    const dir = path.resolve(here, candidate);
    if (existsSync(path.join(dir, "templates", "commands", "specify.md"))) return dir;
  }
  throw new SpecKitVendorMissingError();
}

export interface SpecKitSources {
  commands: Record<SpecKitCommand, string>;
  pageTemplates: Record<string, string>;
  scripts: Record<SpecKitScriptVariant, Record<string, string>>;
  workflowYaml: string;
}

let cached: Promise<SpecKitSources> | null = null;

async function readSources(dir: string): Promise<SpecKitSources> {
  const read = (...segments: string[]) => readFile(path.join(dir, ...segments), "utf8");
  const commandEntries = await Promise.all(
    SPECKIT_COMMANDS.map(
      async (command) => [command, await read("templates", "commands", `${command}.md`)] as const,
    ),
  );
  const pageEntries = await Promise.all(
    SPECKIT_PAGE_TEMPLATES.map(async (name) => [name, await read("templates", name)] as const),
  );
  const scriptsFor = async (variant: SpecKitScriptVariant) => {
    const entries = await Promise.all(
      SPECKIT_SCRIPT_FILES[variant].map(
        async (name) => [name, await read("scripts", SPECKIT_SCRIPT_DIRS[variant], name)] as const,
      ),
    );
    return Object.fromEntries(entries);
  };
  return {
    commands: Object.fromEntries(commandEntries) as Record<SpecKitCommand, string>,
    pageTemplates: Object.fromEntries(pageEntries),
    scripts: { sh: await scriptsFor("sh"), ps: await scriptsFor("ps") },
    workflowYaml: await read("workflows", "speckit", "workflow.yml"),
  };
}

/** The vendored sources, read once per daemon. */
export function loadSpecKitSources(): Promise<SpecKitSources> {
  if (!cached) {
    cached = readSources(resolveSpecKitVendorDir()).catch((error: unknown) => {
      cached = null;
      throw error;
    });
  }
  return cached;
}
