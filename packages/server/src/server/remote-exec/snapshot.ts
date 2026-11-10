import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
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

/** One candidate file of a source listing: lstat facts only — no file content is read (spec 33.4). */
export interface SourceFileEntry {
  /** Path relative to the source directory, with "/" separators. */
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
  executable: boolean;
  symlink: boolean;
  /** Link target string for symlinks, else null. */
  linkTarget: string | null;
}

/** Phase one of a source snapshot: the tree listed and lstat'ed, nothing hashed yet. */
export interface SourceListing {
  workspacePath: string;
  workspaceKey: string;
  cacheFile: string;
  files: SourceFileEntry[];
  bytesTotal: number;
  excludedSecrets: string[];
  skipped: string[];
}

/**
 * Phase one of a source snapshot (spec 33.4): lists the source tree and lstats every candidate —
 * no file content is read, so the run-wide size limits can fire before anything is hashed. Same
 * collection rules as before: git work trees via `git ls-files`, non-git via the pruned walk,
 * secrets excluded, gitlinks (submodules) skipped.
 */
export async function listSourceEntries(input: {
  workspacePath: string;
  daemonId: string;
  /** Overrides the key derived from the source path (explicit sources pass the run's key). */
  workspaceKey?: string;
  cacheFile?: string;
  maxVisitedEntries?: number;
}): Promise<SourceListing> {
  const sourcePath = path.resolve(input.workspacePath);
  const workspaceKey = input.workspaceKey ?? computeWorkspaceKey(input.daemonId, sourcePath);
  const cacheFile = input.cacheFile ?? `${workspaceKey}.json`;
  const maxVisitedEntries = input.maxVisitedEntries ?? SNAPSHOT_MAX_VISITED_ENTRIES;
  const inGit = await isGitWorkTree(sourcePath);
  const listed: WalkResult = inGit
    ? { files: await listGitFiles(sourcePath), gitlinks: await listGitlinks(sourcePath) }
    : await listWalkFiles(sourcePath, maxVisitedEntries);

  const files: SourceFileEntry[] = [];
  const excludedSecrets: string[] = [];
  const skipped: string[] = [];

  for (const relativePath of listed.files) {
    if (listed.gitlinks.has(relativePath)) {
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
      // Symlinks (including directory symlinks) travel as symlinks and are never followed.
      files.push({
        path: relativePath,
        size: 0,
        mtimeMs: stats.mtimeMs,
        ino: stats.ino,
        executable: false,
        symlink: true,
        linkTarget: await fs.readlink(absolutePath),
      });
      continue;
    }
    if (!stats.isFile()) continue;
    files.push({
      path: relativePath,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      ino: stats.ino,
      executable: (stats.mode & 0o111) !== 0,
      symlink: false,
      linkTarget: null,
    });
  }

  return {
    workspacePath: sourcePath,
    workspaceKey,
    cacheFile,
    files,
    bytesTotal: files.reduce((sum, file) => sum + file.size, 0),
    excludedSecrets,
    skipped,
  };
}

/** Streams the file through the sha256 in chunks — no whole file in memory (spec 33.4). */
function hashFileContent(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk: string | Buffer) => {
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Phase two: hashes the listing's entries — file contents via streaming reads, symlinks via their
 * link-target string — through the (path, size, mtimeMs, ino) cache, and assembles the
 * WorkspaceSnapshot.
 */
export async function hashSourceEntries(input: {
  listing: SourceListing;
  homeDir: string;
  /** Injected by tests; defaults to a streaming content hash. */
  hasher?: (absolutePath: string) => Promise<string>;
}): Promise<WorkspaceSnapshot> {
  const { listing } = input;
  const cache = new HashCache(
    path.join(input.homeDir, "remote-exec", "hash-cache", listing.cacheFile),
  );
  const hasher = input.hasher ?? hashFileContent;
  const files: SnapshotEntry[] = [];

  for (const entry of listing.files) {
    if (entry.symlink) {
      files.push({
        path: entry.path,
        mode: SNAPSHOT_MODE_SYMLINK,
        symlink: true,
        executable: false,
        hash: sha256Hex(entry.linkTarget ?? ""),
        size: 0,
      });
      continue;
    }
    const cached = cache.get(entry.path, entry);
    const hash = cached ?? (await hasher(path.join(listing.workspacePath, entry.path)));
    if (cached === null) cache.set(entry.path, entry, hash);
    files.push({
      path: entry.path,
      mode: entry.executable ? SNAPSHOT_MODE_EXEC : SNAPSHOT_MODE_FILE,
      symlink: false,
      executable: entry.executable,
      hash,
      size: entry.size,
    });
  }

  await cache.save(new Set(files.map((file) => file.path)));

  return {
    workspacePath: listing.workspacePath,
    workspaceKey: listing.workspaceKey,
    snapshotId: computeSnapshotId(
      files.map((file) => ({ path: file.path, mode: file.mode, hash: file.hash })),
    ),
    files,
    bytesTotal: listing.bytesTotal,
    excludedSecrets: listing.excludedSecrets,
    skipped: listing.skipped,
  };
}

/**
 * Convenience over both phases (spec 33.4): list + lstat, then hash. Callers that enforce the
 * run-wide size limits across several sources use the two phases separately instead — hashing
 * must not start before every source is within limits.
 */
export async function createSourceSnapshot(input: {
  /** Absolute path of the source directory to snapshot. */
  workspacePath: string;
  daemonId: string;
  homeDir: string;
  workspaceKey?: string;
  cacheFile?: string;
  maxVisitedEntries?: number;
  /** Injected by tests; defaults to a streaming content hash. */
  hasher?: (absolutePath: string) => Promise<string>;
}): Promise<WorkspaceSnapshot> {
  const listing = await listSourceEntries(input);
  return hashSourceEntries({ listing, homeDir: input.homeDir, hasher: input.hasher });
}
