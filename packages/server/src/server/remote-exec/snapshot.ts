import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { computeSnapshotId, computeWorkspaceKey } from "./ids.js";
import { HashCache, sha256Hex } from "./hash-cache.js";
import { RemoteExecError } from "./types.js";

const execFileAsync = promisify(execFile);

export const SNAPSHOT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const SNAPSHOT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** Visited-entry cap for the non-git walk (spec 33.4); injected in tests. */
export const SNAPSHOT_MAX_VISITED_ENTRIES = 200_000;

/** Modes recorded in the snapshot: regular files keep the exec bit, symlinks stay symlinks. */
export const SNAPSHOT_MODE_SYMLINK = 0o120777;
export const SNAPSHOT_MODE_EXEC = 0o755;
export const SNAPSHOT_MODE_FILE = 0o644;

/** Directory names the non-git walk never descends into (spec 33.4 / ADR-0045). */
export const WALK_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".gradle",
  "Pods",
  "DerivedData",
  ".terraform",
]);

export interface SnapshotEntry {
  /** Path relative to the snapshotted source directory, with "/" separators. */
  path: string;
  mode: number;
  symlink: boolean;
  executable: boolean;
  /** SHA-256 of the content; for symlinks the SHA-256 of the link target string (spec 33.4). */
  hash: string;
  size: number;
}

export interface WorkspaceSnapshot {
  /** Absolute path of the snapshotted source directory. */
  workspacePath: string;
  workspaceKey: string;
  snapshotId: string;
  files: SnapshotEntry[];
  bytesTotal: number;
  excludedSecrets: string[];
  skipped: string[];
}

// Secret basename rule from spec 33.4 — exact names, `.env.*` except the example/sample/template
// keepers, key/certificate extensions and the common private-key prefixes.
const SECRET_EXACT = new Set([".env", ".npmrc", ".netrc", ".pypirc"]);
const SECRET_KEEP = new Set([".env.example", ".env.sample", ".env.template"]);

export function isSecretBasename(basename: string): boolean {
  if (SECRET_EXACT.has(basename)) return true;
  if (SECRET_KEEP.has(basename)) return false;
  if (basename.startsWith(".env.")) return true;
  if (/\.(?:pem|key|p12|pfx)$/.test(basename)) return true;
  if (
    basename.startsWith("id_rsa") ||
    basename.startsWith("id_ecdsa") ||
    basename.startsWith("id_ed25519")
  ) {
    return true;
  }
  return false;
}

async function runGit(cwd: string, args: readonly string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 256 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout;
}

/** Paths of tracked-and-untracked-but-not-ignored files under dir, relative to dir (spec 33.4). */
async function listGitFiles(dir: string): Promise<string[]> {
  const stdout = await runGit(dir, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  return stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

/** Submodule (gitlink) paths: `ls-files -s` stages with mode 160000. */
async function listGitlinks(dir: string): Promise<Set<string>> {
  const stdout = await runGit(dir, ["ls-files", "-z", "-s", "--cached"]);
  const gitlinks = new Set<string>();
  for (const record of stdout.toString("utf8").split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const meta = record.slice(0, tab);
    const mode = Number.parseInt(meta.slice(0, meta.indexOf(" ")), 8);
    if (mode === 0o160000) gitlinks.add(record.slice(tab + 1));
  }
  return gitlinks;
}

/** True when dir is inside (or at the root of) a git work tree. */
async function isGitWorkTree(dir: string): Promise<boolean> {
  try {
    await runGit(dir, ["rev-parse", "--show-toplevel"]);
    return true;
  } catch {
    return false;
  }
}

/** True when dir contains a `.git` entry — the root of some git work tree, even a linked one. */
async function isGitRoot(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

interface WalkResult {
  files: string[];
  /** Gitlink paths of nested repos, prefixed with their path under the source root. */
  gitlinks: Set<string>;
}

/**
 * Walks a non-git source tree without following directory symlinks (spec 33.4): skipped directory
 * names are pruned, every nested git work tree root is listed via `git ls-files` (its .gitignore
 * respected) instead of walked raw, sockets/FIFOs/devices are skipped. Throws snapshot_too_large
 * once more than maxVisitedEntries entries have been examined.
 */
async function listWalkFiles(sourcePath: string, maxVisitedEntries: number): Promise<WalkResult> {
  const files: string[] = [];
  const gitlinks = new Set<string>();
  let visited = 0;
  async function collectNestedRepo(repoRoot: string, prefix: string): Promise<void> {
    const [repoFiles, repoGitlinks] = await Promise.all([
      listGitFiles(repoRoot),
      listGitlinks(repoRoot),
    ]);
    for (const relative of repoFiles) {
      if (repoGitlinks.has(relative)) {
        gitlinks.add(`${prefix}/${relative}`);
        continue;
      }
      files.push(`${prefix}/${relative}`);
    }
  }
  async function walk(dir: string, relative: string): Promise<void> {
    for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
      visited += 1;
      if (visited > maxVisitedEntries) {
        throw new RemoteExecError(
          "snapshot_too_large",
          `The workspace has more than ${maxVisitedEntries} entries`,
        );
      }
      const childRelative = relative.length === 0 ? dirent.name : `${relative}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (WALK_SKIP_DIRS.has(dirent.name)) continue;
        const childAbsolute = path.join(dir, dirent.name);
        if (await isGitRoot(childAbsolute)) {
          try {
            await collectNestedRepo(childAbsolute, childRelative);
          } catch {
            // Broken .git: fall back to walking the directory (.git itself is skipped by name).
            await walk(childAbsolute, childRelative);
          }
        } else {
          await walk(childAbsolute, childRelative);
        }
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        // Symlinks (including directory symlinks) travel as symlinks and are never followed.
        files.push(childRelative);
      }
      // Sockets, FIFOs and devices are skipped (spec 33.4).
    }
  }
  await walk(sourcePath, "");
  return { files, gitlinks };
}

/**
 * Snapshots one source directory (spec 33.4): a git work tree is listed via `git ls-files` scoped
 * to the directory; anything else is walked. Size limits are enforced run-wide by the caller —
 * this function only collects. The hash cache lives at
 * `remote-exec/hash-cache/<cacheFile>`; the default source keeps `<workspaceKey>.json`, explicit
 * sources pass their own file so they never evict the default source's cache.
 */
export async function createSourceSnapshot(input: {
  /** Absolute path of the source directory to snapshot. */
  workspacePath: string;
  daemonId: string;
  homeDir: string;
  /** Overrides the key derived from the source path (explicit sources pass the run's key). */
  workspaceKey?: string;
  cacheFile?: string;
  maxVisitedEntries?: number;
}): Promise<WorkspaceSnapshot> {
  const sourcePath = path.resolve(input.workspacePath);
  const workspaceKey = input.workspaceKey ?? computeWorkspaceKey(input.daemonId, sourcePath);
  const cacheFile = input.cacheFile ?? `${workspaceKey}.json`;
  const maxVisitedEntries = input.maxVisitedEntries ?? SNAPSHOT_MAX_VISITED_ENTRIES;
  const inGit = await isGitWorkTree(sourcePath);
  const listed: WalkResult = inGit
    ? { files: await listGitFiles(sourcePath), gitlinks: await listGitlinks(sourcePath) }
    : await listWalkFiles(sourcePath, maxVisitedEntries);
  const { files: paths, gitlinks } = listed;

  const cache = new HashCache(path.join(input.homeDir, "remote-exec", "hash-cache", cacheFile));
  const files: SnapshotEntry[] = [];
  const excludedSecrets: string[] = [];
  const skipped: string[] = [];

  for (const relativePath of paths) {
    if (gitlinks.has(relativePath)) {
      skipped.push(relativePath);
      continue;
    }
    if (isSecretBasename(path.posix.basename(relativePath))) {
      excludedSecrets.push(relativePath);
      continue;
    }
    const absolutePath = path.join(sourcePath, relativePath);
    let stats;
    try {
      stats = await fs.lstat(absolutePath);
    } catch {
      continue; // tracked file deleted from disk has no place in the snapshot (spec 33.4)
    }
    if (stats.isSymbolicLink()) {
      const target = await fs.readlink(absolutePath);
      files.push({
        path: relativePath,
        mode: SNAPSHOT_MODE_SYMLINK,
        symlink: true,
        executable: false,
        hash: sha256Hex(target),
        size: 0,
      });
      continue;
    }
    if (!stats.isFile()) continue;
    const cached = cache.get(relativePath, stats);
    const hash = cached ?? sha256Hex(await fs.readFile(absolutePath));
    if (cached === null) cache.set(relativePath, stats, hash);
    const executable = (stats.mode & 0o111) !== 0;
    files.push({
      path: relativePath,
      mode: executable ? SNAPSHOT_MODE_EXEC : SNAPSHOT_MODE_FILE,
      symlink: false,
      executable,
      hash,
      size: stats.size,
    });
  }

  await cache.save(new Set(files.map((file) => file.path)));

  return {
    workspacePath: sourcePath,
    workspaceKey,
    snapshotId: computeSnapshotId(
      files.map((file) => ({ path: file.path, mode: file.mode, hash: file.hash })),
    ),
    files,
    bytesTotal: files.reduce((sum, file) => sum + file.size, 0),
    excludedSecrets,
    skipped,
  };
}
