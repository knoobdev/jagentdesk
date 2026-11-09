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

/** Modes recorded in the snapshot: regular files keep the exec bit, symlinks stay symlinks. */
export const SNAPSHOT_MODE_SYMLINK = 0o120777;
export const SNAPSHOT_MODE_EXEC = 0o755;
export const SNAPSHOT_MODE_FILE = 0o644;

export interface SnapshotEntry {
  /** Workspace-relative path with "/" separators. */
  path: string;
  mode: number;
  symlink: boolean;
  executable: boolean;
  /** SHA-256 of the content; for symlinks the SHA-256 of the link target string (spec 33.4). */
  hash: string;
  size: number;
}

export interface WorkspaceSnapshot {
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

/** Paths of tracked-and-untracked-but-not-ignored files under cwd, relative to cwd (spec 33.4). */
async function listWorkspaceFiles(workspacePath: string): Promise<string[]> {
  const stdout = await runGit(workspacePath, [
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
async function listGitlinks(workspacePath: string): Promise<Set<string>> {
  const stdout = await runGit(workspacePath, ["ls-files", "-z", "-s", "--cached"]);
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

async function resolveWorkTreeRoot(workspacePath: string): Promise<void> {
  try {
    await runGit(workspacePath, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new RemoteExecError(
      "not_git_workspace",
      `${workspacePath} is not inside a git work tree`,
    );
  }
}

export async function createSnapshot(input: {
  workspacePath: string;
  daemonId: string;
  homeDir: string;
}): Promise<WorkspaceSnapshot> {
  const workspacePath = path.resolve(input.workspacePath);
  await resolveWorkTreeRoot(workspacePath);
  const workspaceKey = computeWorkspaceKey(input.daemonId, workspacePath);

  const [paths, gitlinks] = await Promise.all([
    listWorkspaceFiles(workspacePath),
    listGitlinks(workspacePath),
  ]);

  const cache = new HashCache(
    path.join(input.homeDir, "remote-exec", "hash-cache", `${workspaceKey}.json`),
  );
  const files: SnapshotEntry[] = [];
  const excludedSecrets: string[] = [];
  const skipped: string[] = [];
  const oversized: { path: string; size: number }[] = [];

  for (const relativePath of paths) {
    if (gitlinks.has(relativePath)) {
      skipped.push(relativePath);
      continue;
    }
    if (isSecretBasename(path.posix.basename(relativePath))) {
      excludedSecrets.push(relativePath);
      continue;
    }
    const absolutePath = path.join(workspacePath, relativePath);
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
    if (stats.size > SNAPSHOT_MAX_FILE_BYTES)
      oversized.push({ path: relativePath, size: stats.size });
  }

  const bytesTotal = files.reduce((sum, file) => sum + file.size, 0);
  if (oversized.length > 0 || bytesTotal > SNAPSHOT_MAX_TOTAL_BYTES) {
    const largest = [...files]
      .toSorted((a, b) => b.size - a.size)
      .slice(0, 10)
      .map((file) => ({ path: file.path, bytes: file.size }));
    throw new RemoteExecError("snapshot_too_large", "Snapshot exceeds the size limits", {
      largest,
    });
  }

  await cache.save(new Set(files.map((file) => file.path)));

  return {
    workspacePath,
    workspaceKey,
    snapshotId: computeSnapshotId(
      files.map((file) => ({ path: file.path, mode: file.mode, hash: file.hash })),
    ),
    files,
    bytesTotal,
    excludedSecrets,
    skipped,
  };
}
