import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  SkillDirLabel,
  SkillEntry,
  SkillScope,
  SkillSourceInfo,
} from "@jagentdesk/protocol/native-skills";
import { NativeSkillsError } from "./errors.js";
import {
  createDirSymlink,
  ensureDirTracked,
  hashTree,
  lstatOrNull,
  moveEntry,
  pathExists,
  removeEmptyDirs,
} from "./fs-utils.js";
import {
  emptyTraining,
  type MovedEntry,
  type MovedSkillRecord,
  type OwnedSkillRecord,
  type SkillsLock,
} from "./lock-store.js";
import {
  buildSkillId,
  INSTALL_LINK_DIRS,
  INSTALL_REAL_DIR,
  isWithin,
  skillDirPath,
} from "./paths.js";

/**
 * Filesystem side of owned skills: install (one real copy + symlinks), remove
 * exactly what the lock lists, and move skills aside for disable / backup.
 * Every path is checked against the allowed roots (home, the workspace, and
 * `$JAGENTDESK_HOME/skills`) before anything is written (ADR-0022 decision 3).
 */
export interface OpsContext {
  homeDir: string;
  skillsHome: string;
  lock: SkillsLock;
  now: () => number;
}

export function assertWritable(ctx: OpsContext, target: string, projectRoot: string | null): void {
  const roots = [ctx.homeDir, ctx.skillsHome, ...(projectRoot ? [projectRoot] : [])];
  if (!roots.some((root) => isWithin(root, target))) {
    throw new NativeSkillsError(
      "path_not_allowed",
      `Refusing to write outside the home directory and workspace: ${target}`,
    );
  }
}

export function scopeRoot(ctx: OpsContext, scope: SkillScope, projectRoot: string | null): string {
  if (scope === "global") return ctx.homeDir;
  if (!projectRoot) {
    throw new NativeSkillsError("invalid_request", "A project-scope skill needs the workspace cwd");
  }
  return projectRoot;
}

export interface InstallTargets {
  realPath: string;
  links: Array<{ dir: SkillDirLabel; path: string }>;
}

export function installTargets(
  ctx: OpsContext,
  name: string,
  scope: SkillScope,
  projectRoot: string | null,
): InstallTargets {
  const root = scopeRoot(ctx, scope, projectRoot);
  return {
    realPath: path.join(skillDirPath(INSTALL_REAL_DIR, scope, root), name),
    links: INSTALL_LINK_DIRS.map((dir) => ({
      dir,
      path: path.join(skillDirPath(dir, scope, root), name),
    })),
  };
}

/** Existing paths / same-scope skills that block installing `name` (spec 22.11 #4). */
export async function findConflicts(
  targets: InstallTargets,
  name: string,
  scope: SkillScope,
  existing: readonly SkillEntry[],
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const candidate of [targets.realPath, ...targets.links.map((link) => link.path)]) {
    if (await pathExists(candidate)) conflicts.push(candidate);
  }
  for (const entry of existing) {
    if (entry.scope !== scope) continue;
    const dirName = entry.skillId.split(":").slice(2).join(":");
    if (entry.name === name || dirName === name) conflicts.push(entry.realPath);
  }
  return Array.from(new Set(conflicts));
}

const MAX_SUFFIX_ATTEMPTS = 50;

function nameSuffix(attempt: number): string {
  if (attempt === 0) return "";
  if (attempt === 1) return "-jagentdesk";
  return `-jagentdesk-${attempt}`;
}

/**
 * First free name among `base`, `base-jagentdesk`, `base-jagentdesk-2`… — the
 * suffix rule of spec 22.10, reused for fork defaults and legacy adds.
 */
export async function findAvailableName(
  ctx: OpsContext,
  base: string,
  scope: SkillScope,
  projectRoot: string | null,
  existing: readonly SkillEntry[],
): Promise<string> {
  for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt += 1) {
    const suffix = nameSuffix(attempt);
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/, "")}${suffix}`;
    const targets = installTargets(ctx, candidate, scope, projectRoot);
    if ((await findConflicts(targets, candidate, scope, existing)).length === 0) return candidate;
  }
  throw conflictError(base, []);
}

export function conflictError(name: string, conflicts: readonly string[]): NativeSkillsError {
  return new NativeSkillsError(
    "skill_name_conflict",
    `A skill named "${name}" already exists (${conflicts.join(", ")}). Choose another name or cancel.`,
  );
}

export interface InstallOwnedInput {
  name: string;
  scope: SkillScope;
  projectRoot: string | null;
  source: SkillSourceInfo;
  /** Writes the skill files into the (not yet existing) real directory. */
  populate: (realPath: string) => Promise<void>;
  legacy?: Partial<Pick<OwnedSkillRecord, "legacyId" | "displayName" | "icon" | "tags">>;
  training?: OwnedSkillRecord["training"];
  installedAtMs?: number;
}

async function rollbackInstall(targets: InstallTargets, created: string[]): Promise<void> {
  for (const link of targets.links) {
    const stats = await lstatOrNull(link.path);
    if (stats?.isSymbolicLink()) await fs.unlink(link.path);
  }
  await fs.rm(targets.realPath, { recursive: true, force: true });
  await removeEmptyDirs(created);
}

/** Install a new owned skill. The caller has already checked for conflicts. */
export async function installOwned(
  ctx: OpsContext,
  targets: InstallTargets,
  input: InstallOwnedInput,
): Promise<OwnedSkillRecord> {
  for (const candidate of [targets.realPath, ...targets.links.map((link) => link.path)]) {
    assertWritable(ctx, candidate, input.projectRoot);
  }
  const created: string[] = [];
  try {
    created.push(...(await ensureDirTracked(path.dirname(targets.realPath))));
    await input.populate(targets.realPath);
    for (const link of targets.links) {
      created.push(...(await ensureDirTracked(path.dirname(link.path))));
      await createDirSymlink(targets.realPath, link.path);
    }
  } catch (error) {
    await rollbackInstall(targets, created);
    throw error;
  }
  const now = ctx.now();
  const record: OwnedSkillRecord = {
    name: input.name,
    scope: input.scope,
    projectRoot: input.scope === "project" ? input.projectRoot : null,
    realPath: targets.realPath,
    links: targets.links,
    enabled: true,
    disabledPath: null,
    source: input.source,
    contentHash: await hashTree(targets.realPath),
    installed_at_ms: input.installedAtMs ?? now,
    updated_at_ms: now,
    legacyId: input.legacy?.legacyId ?? null,
    displayName: input.legacy?.displayName ?? null,
    icon: input.legacy?.icon ?? null,
    tags: input.legacy?.tags ?? [],
    training: input.training ?? emptyTraining(),
  };
  ctx.lock.skills.push(record);
  ctx.lock.createdDirs = Array.from(new Set([...ctx.lock.createdDirs, ...created]));
  return record;
}

/** Remove parent directories JAgentDesk created that are empty again. */
export async function pruneCreatedDirs(ctx: OpsContext): Promise<string[]> {
  const removed = await removeEmptyDirs(ctx.lock.createdDirs);
  ctx.lock.createdDirs = ctx.lock.createdDirs.filter((dir) => !removed.includes(dir));
  return removed;
}

/** Uninstall an owned skill: remove exactly the paths the lock lists. */
export async function removeOwned(ctx: OpsContext, record: OwnedSkillRecord): Promise<string[]> {
  const removed: string[] = [];
  if (record.enabled) {
    for (const link of record.links) {
      const stats = await lstatOrNull(link.path);
      // Only our symlink; a real directory that replaced it is not ours to delete.
      if (!stats?.isSymbolicLink()) continue;
      assertWritable(ctx, link.path, record.projectRoot);
      await fs.unlink(link.path);
      removed.push(link.path);
    }
  }
  const realDir = record.enabled ? record.realPath : record.disabledPath;
  if (realDir && (await pathExists(realDir))) {
    assertWritable(ctx, realDir, record.projectRoot);
    await fs.rm(realDir, { recursive: true, force: true });
    removed.push(realDir);
  }
  ctx.lock.skills = ctx.lock.skills.filter((candidate) => candidate !== record);
  removed.push(...(await pruneCreatedDirs(ctx)));
  return removed;
}

export function scopeKey(scope: SkillScope, projectRoot: string | null): string {
  if (scope === "global" || !projectRoot) return "global";
  return `project-${createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 12)}`;
}

async function uniqueBackupPath(base: string, now: number): Promise<string> {
  if (!(await pathExists(base))) return base;
  return `${base}-${now}`;
}

/** Disable an owned skill: move the real dir aside and drop the symlinks. */
export async function disableOwned(ctx: OpsContext, record: OwnedSkillRecord): Promise<void> {
  const backup = await uniqueBackupPath(
    path.join(
      ctx.skillsHome,
      "disabled",
      "owned",
      scopeKey(record.scope, record.projectRoot),
      record.name,
    ),
    ctx.now(),
  );
  for (const link of record.links) {
    const stats = await lstatOrNull(link.path);
    if (stats?.isSymbolicLink()) {
      assertWritable(ctx, link.path, record.projectRoot);
      await fs.unlink(link.path);
    }
  }
  assertWritable(ctx, record.realPath, record.projectRoot);
  await moveEntry(record.realPath, backup);
  record.enabled = false;
  record.disabledPath = backup;
  record.updated_at_ms = ctx.now();
}

export async function enableOwned(ctx: OpsContext, record: OwnedSkillRecord): Promise<void> {
  if (!record.disabledPath) return;
  const blocked: string[] = [];
  for (const candidate of [record.realPath, ...record.links.map((link) => link.path)]) {
    if (await pathExists(candidate)) blocked.push(candidate);
  }
  if (blocked.length > 0) throw conflictError(record.name, blocked);
  assertWritable(ctx, record.realPath, record.projectRoot);
  const created = await ensureDirTracked(path.dirname(record.realPath));
  await moveEntry(record.disabledPath, record.realPath);
  for (const link of record.links) {
    assertWritable(ctx, link.path, record.projectRoot);
    created.push(...(await ensureDirTracked(path.dirname(link.path))));
    await createDirSymlink(record.realPath, link.path);
  }
  ctx.lock.createdDirs = Array.from(new Set([...ctx.lock.createdDirs, ...created]));
  record.enabled = true;
  record.disabledPath = null;
  record.updated_at_ms = ctx.now();
}

/** The directory entries (real dir + symlinks) a scanned skill occupies. */
export function entryLocations(
  ctx: OpsContext,
  entry: SkillEntry,
): Array<{ dir: SkillDirLabel; path: string }> {
  if (!entry.dir) return [];
  const root = scopeRoot(ctx, entry.scope, entry.projectRoot);
  const dirName = entry.skillId.split(":").slice(2).join(":");
  const primary = {
    dir: entry.dir,
    path: path.join(skillDirPath(entry.dir, entry.scope, root), dirName),
  };
  return [primary, ...entry.links];
}

/**
 * Move a pre-existing skill aside into `<area>/<scope>/<dir label>/<name>` so it
 * can be restored exactly (disable, or uninstall-with-backup).
 */
export async function moveForeignAside(
  ctx: OpsContext,
  entry: SkillEntry,
  area: "disabled" | "removed",
): Promise<MovedSkillRecord> {
  const contentHash = await hashTree(entry.realPath);
  const now = ctx.now();
  const moved: MovedEntry[] = [];
  const dirName = entry.skillId.split(":").slice(2).join(":");
  for (const location of entryLocations(ctx, entry)) {
    const stats = await lstatOrNull(location.path);
    if (!stats) continue;
    assertWritable(ctx, location.path, entry.projectRoot);
    const backup = await uniqueBackupPath(
      path.join(
        ctx.skillsHome,
        area,
        scopeKey(entry.scope, entry.projectRoot),
        location.dir,
        dirName,
      ),
      now,
    );
    await moveEntry(location.path, backup);
    moved.push({
      dir: location.dir,
      originalPath: location.path,
      backupPath: backup,
      kind: stats.isSymbolicLink() ? "symlink" : "dir",
    });
  }
  return {
    skillId: entry.skillId,
    name: entry.name,
    description: entry.description,
    scope: entry.scope,
    projectRoot: entry.projectRoot,
    entries: moved,
    contentHash,
    moved_at_ms: now,
  };
}

/** Put a moved-aside skill back where it was. Returns the content hash after restore. */
export async function restoreForeign(ctx: OpsContext, record: MovedSkillRecord): Promise<string> {
  const blocked: string[] = [];
  for (const entry of record.entries) {
    if (await pathExists(entry.originalPath)) blocked.push(entry.originalPath);
  }
  if (blocked.length > 0) throw conflictError(record.name, blocked);
  for (const entry of record.entries) {
    assertWritable(ctx, entry.originalPath, record.projectRoot);
    await moveEntry(entry.backupPath, entry.originalPath);
  }
  const primary = record.entries.find((entry) => entry.kind === "dir") ?? record.entries[0];
  return primary ? hashTree(await fs.realpath(primary.originalPath)) : "";
}

export function ownedSkillId(record: OwnedSkillRecord): string {
  return buildSkillId(record.scope, INSTALL_REAL_DIR, record.name);
}
