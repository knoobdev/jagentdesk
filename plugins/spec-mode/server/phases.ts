import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  SPEC_MODE_PHASES,
  type SpecModeOptionalPhase,
  type SpecModePhase,
  type SpecModePhaseStatusMap,
} from "@jagentdesk/protocol/spec-mode";

/**
 * "Phase done" is decided from files on disk after `turn_completed`, never by a model
 * (spec 28.2, inventory §9). A phase that stops to ask the user (Specify Q1–Q3, the Implement
 * checklist gate) stays running until its condition holds.
 */

const OPTIONAL: ReadonlySet<SpecModePhase> = new Set<SpecModePhase>([
  "clarify",
  "checklist",
  "analyze",
]);

export function isPhaseEnabled(
  phase: SpecModePhase,
  optionalPhases: readonly SpecModeOptionalPhase[],
): boolean {
  return !OPTIONAL.has(phase) || optionalPhases.some((optional) => optional === phase);
}

/** The first phase still to do (pending, running or awaiting review), or null when finished. */
export function currentPhase(status: SpecModePhaseStatusMap): SpecModePhase | null {
  return (
    SPEC_MODE_PHASES.find((phase) => status[phase] !== "done" && status[phase] !== "skipped") ??
    null
  );
}

const CONSTITUTION_PATH = ".specify/memory/constitution.md";
const PLACEHOLDER_TOKEN = /\[[A-Z][A-Z0-9_]+\]/;

async function readText(cwd: string, relativePath: string): Promise<string | null> {
  try {
    return await readFile(path.join(cwd, ...relativePath.split("/")), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Constitution is done once it exists without unfilled `[ALL_CAPS]` placeholders. */
export async function isConstitutionDone(cwd: string): Promise<boolean> {
  const text = await readText(cwd, CONSTITUTION_PATH);
  return text !== null && !PLACEHOLDER_TOKEN.test(text);
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function hashTree(cwd: string, relativeDir: string, into: Record<string, string>) {
  let entries;
  try {
    entries = await readdir(path.join(cwd, ...relativeDir.split("/")), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const child = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) await hashTree(cwd, child, into);
    else if (entry.isFile())
      into[child] = sha256(await readFile(path.join(cwd, ...child.split("/"))));
  }
}

/** Hashes of the spec artefacts a phase may write: the feature (or all of `specs/`) and the constitution. */
export async function snapshotArtefacts(
  cwd: string,
  featureDirectory: string | null,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  await hashTree(cwd, featureDirectory ?? "specs", files);
  const constitution = await readText(cwd, CONSTITUTION_PATH);
  if (constitution !== null) files[CONSTITUTION_PATH] = sha256(constitution);
  return files;
}

export function changedFiles(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return Object.keys(after)
    .filter((file) => before[file] !== after[file])
    .sort();
}

/** `.specify/feature.json` → project-relative feature directory, or null. */
export async function readFeaturePointer(cwd: string): Promise<string | null> {
  const text = await readText(cwd, ".specify/feature.json");
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (typeof value !== "object" || value === null || !("feature_directory" in value)) return null;
  const directory = value.feature_directory;
  if (typeof directory !== "string" || directory.trim() === "") return null;
  const absolute = path.resolve(cwd, directory);
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join("/");
}

export type PhaseOutcome =
  | { kind: "not_done" }
  | { kind: "done"; featureDirectory: string | null }
  | { kind: "converged" }
  | { kind: "tasks_appended" };

export interface PhaseCheckInput {
  phase: SpecModePhase;
  cwd: string;
  /** Known feature directory (assigned for shared checkouts, or found after Specify). */
  featureDirectory: string | null;
  sharedCheckout: boolean;
  /** Artefact hashes taken when the phase was sent. */
  before: Record<string, string>;
  lastAssistantMessage: string | null;
}

const NOT_DONE: PhaseOutcome = { kind: "not_done" };

async function checkSpecify(input: PhaseCheckInput): Promise<PhaseOutcome> {
  const directory = input.sharedCheckout
    ? input.featureDirectory
    : await readFeaturePointer(input.cwd);
  if (!directory) return NOT_DONE;
  const specPath = `${directory}/spec.md`;
  const spec = await readText(input.cwd, specPath);
  if (spec === null || spec.includes("[NEEDS CLARIFICATION")) return NOT_DONE;
  const isThisFeature =
    directory === input.featureDirectory ||
    changedFiles(input.before, await snapshotArtefacts(input.cwd, directory)).includes(specPath);
  return isThisFeature ? { kind: "done", featureDirectory: directory } : NOT_DONE;
}

async function checkFeaturePhase(input: PhaseCheckInput, directory: string): Promise<PhaseOutcome> {
  const done = (value: boolean): PhaseOutcome =>
    value ? { kind: "done", featureDirectory: directory } : NOT_DONE;
  const read = (name: string) => readText(input.cwd, `${directory}/${name}`);
  switch (input.phase) {
    case "clarify": {
      const spec = await read("spec.md");
      const answered = spec !== null && /^## Clarifications\b/m.test(spec);
      const nothingToAsk =
        input.lastAssistantMessage?.includes("No critical ambiguities detected") ?? false;
      return done(answered || nothingToAsk);
    }
    case "plan":
      return done((await read("plan.md")) !== null && (await read("research.md")) !== null);
    case "checklist": {
      const after = await snapshotArtefacts(input.cwd, directory);
      const prefix = `${directory}/checklists/`;
      return done(changedFiles(input.before, after).some((file) => file.startsWith(prefix)));
    }
    case "tasks":
      return done(/^- \[ \] T\d{3}\b/m.test((await read("tasks.md")) ?? ""));
    case "analyze":
      return done(true);
    case "implement": {
      const tasks = await read("tasks.md");
      return done(tasks !== null && !/^\s*- \[ \]/m.test(tasks));
    }
    case "converge": {
      const tasksPath = `${directory}/tasks.md`;
      const tasks = await readText(input.cwd, tasksPath);
      if (tasks === null) return NOT_DONE;
      return input.before[tasksPath] === sha256(tasks)
        ? { kind: "converged" }
        : { kind: "tasks_appended" };
    }
    default:
      return NOT_DONE;
  }
}

export async function checkPhase(input: PhaseCheckInput): Promise<PhaseOutcome> {
  if (input.phase === "constitution") {
    return (await isConstitutionDone(input.cwd))
      ? { kind: "done", featureDirectory: input.featureDirectory }
      : NOT_DONE;
  }
  if (input.phase === "specify") return checkSpecify(input);
  if (!input.featureDirectory) return NOT_DONE;
  return checkFeaturePhase(input, input.featureDirectory);
}
