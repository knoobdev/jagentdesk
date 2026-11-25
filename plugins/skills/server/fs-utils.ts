import { createHash } from "node:crypto";
import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import type { SkillFile } from "@jagentdesk/protocol/native-skills";

const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".rb",
  ".pl",
  ".ps1",
  ".bat",
  ".cmd",
  ".exe",
]);
const MAX_LISTED_FILES = 2000;

export async function lstatOrNull(target: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

export async function pathExists(target: string): Promise<boolean> {
  return (await lstatOrNull(target)) !== null;
}

export async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

export function toPosix(relative: string): string {
  return relative.split(path.sep).join("/");
}

export function isScriptPath(relative: string): boolean {
  const posix = toPosix(relative);
  return posix.startsWith("scripts/") || SCRIPT_EXTENSIONS.has(path.extname(posix).toLowerCase());
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Every file of a skill directory, without following symlinks. */
export async function listSkillFiles(root: string): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readDirSafe(dir)).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= MAX_LISTED_FILES) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      const relative = toPosix(path.relative(root, absolute));
      const stats = await lstatOrNull(absolute);
      const executable = stats ? (stats.mode & 0o111) !== 0 && entry.isFile() : false;
      files.push({
        path: relative,
        size: stats?.size ?? 0,
        isScript: isScriptPath(relative) || executable,
      });
    }
  };
  await walk(root);
  // Code-point order (SKILL.md before scripts/), independent of locale.
  return files.sort((a, b) => Number(a.path > b.path) - Number(a.path < b.path));
}

export async function hasScripts(root: string): Promise<boolean> {
  const scriptsDir = await lstatOrNull(path.join(root, "scripts"));
  if (scriptsDir?.isDirectory()) return true;
  const entries = await readDirSafe(root);
  return entries.some((entry) => entry.isFile() && isScriptPath(entry.name));
}

/**
 * Content hash of a directory tree: relative paths, file bytes and symlink
 * targets. Timestamps are ignored so a move/restore keeps the same hash.
 */
export async function hashTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readDirSafe(dir)).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      const relative = toPosix(path.relative(root, absolute));
      if (entry.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${await fs.readlink(absolute)}\0`);
      } else if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await walk(absolute);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await fs.readFile(absolute));
        hash.update("\0");
      }
    }
  };
  await walk(root);
  return hash.digest("hex");
}

/** mkdir -p that reports which directories it created (outermost first). */
export async function ensureDirTracked(dir: string): Promise<string[]> {
  const missing: string[] = [];
  let current = path.resolve(dir);
  while (!(await pathExists(current))) {
    missing.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const target of missing) {
    await fs.mkdir(target);
  }
  return missing;
}

/** Remove directories that are empty now, deepest first. Returns what was removed. */
export async function removeEmptyDirs(dirs: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  const ordered = Array.from(new Set(dirs)).sort((a, b) => b.length - a.length);
  for (const dir of ordered) {
    try {
      await fs.rmdir(dir);
      removed.push(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") removed.push(dir);
    }
  }
  return removed;
}

/** Move a directory or symlink; falls back to copy+remove across filesystems. */
export async function moveEntry(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    await fs.cp(source, destination, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    });
    await fs.rm(source, { recursive: true, force: true });
  }
}

export async function copyTree(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
    filter: (src) => path.basename(src) !== ".git",
  });
}

/**
 * Directory symlink at `linkPath` pointing to `target`. Relative on POSIX so a
 * moved project keeps working; a junction (absolute) on Windows.
 */
export async function createDirSymlink(target: string, linkPath: string): Promise<void> {
  if (process.platform === "win32") {
    await fs.symlink(path.resolve(target), linkPath, "junction");
    return;
  }
  await fs.symlink(path.relative(path.dirname(linkPath), target), linkPath, "dir");
}
