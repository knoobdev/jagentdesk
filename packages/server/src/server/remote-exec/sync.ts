import { spawn } from "node:child_process";
import type { Client, ClientChannel } from "ssh2";
import { openExecChannel, execCollect } from "./ssh-exec.js";
import {
  buildDeleteScript,
  buildExtractScript,
  buildWriteManifestScript,
  remotePathExpr,
} from "./remote-scripts.js";
import type { SnapshotEntry, WorkspaceSnapshot } from "./snapshot.js";
import type { RemoteSyncSummary } from "./types.js";

// Incremental sync (spec 33.5): the remote manifest lists what was applied last time; only new or
// changed entries are uploaded as one gzip tar over an exec channel's stdin, paths gone from the
// snapshot are deleted inside src/, and files not in the manifest (node_modules, caches) are never
// touched.

export interface ManifestEntry {
  hash: string;
  executable: boolean;
  symlink: boolean;
}

export interface RemoteManifest {
  snapshotId: string | null;
  entries: Record<string, ManifestEntry>;
}

export function emptyRemoteManifest(): RemoteManifest {
  return { snapshotId: null, entries: {} };
}

/** Missing or invalid remote manifests count as empty (spec 33.5). */
export function parseRemoteManifest(raw: string): RemoteManifest {
  try {
    const parsed = JSON.parse(raw) as {
      snapshotId?: unknown;
      entries?: unknown;
    };
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.entries !== "object" ||
      parsed.entries === null
    ) {
      return emptyRemoteManifest();
    }
    const entries: Record<string, ManifestEntry> = {};
    for (const [manifestPath, value] of Object.entries(parsed.entries)) {
      if (
        typeof manifestPath !== "string" ||
        manifestPath.length === 0 ||
        typeof value !== "object" ||
        value === null
      ) {
        return emptyRemoteManifest();
      }
      const entry = value as { hash?: unknown; executable?: unknown; symlink?: unknown };
      if (
        typeof entry.hash !== "string" ||
        typeof entry.executable !== "boolean" ||
        typeof entry.symlink !== "boolean"
      ) {
        return emptyRemoteManifest();
      }
      entries[manifestPath] = {
        hash: entry.hash,
        executable: entry.executable,
        symlink: entry.symlink,
      };
    }
    return {
      snapshotId: typeof parsed.snapshotId === "string" ? parsed.snapshotId : null,
      entries,
    };
  } catch {
    return emptyRemoteManifest();
  }
}

export interface ManifestDiff {
  upload: SnapshotEntry[];
  deletePaths: string[];
}

/** Upload set: new entries or entries whose hash/exec-bit/symlink-ness changed. */
export function diffManifest(
  oldManifest: RemoteManifest,
  snapshot: WorkspaceSnapshot,
): ManifestDiff {
  const upload: SnapshotEntry[] = [];
  for (const file of snapshot.files) {
    const previous = oldManifest.entries[file.path];
    if (
      !previous ||
      previous.hash !== file.hash ||
      previous.executable !== file.executable ||
      previous.symlink !== file.symlink
    ) {
      upload.push(file);
    }
  }
  const currentPaths = new Set(snapshot.files.map((file) => file.path));
  const deletePaths = Object.keys(oldManifest.entries).filter((p) => !currentPaths.has(p));
  return { upload, deletePaths };
}

/** Paths must stay inside src/: relative, no `..` segments, non-empty. */
export function isSafeRelativeDeletePath(manifestPath: string): boolean {
  if (manifestPath.length === 0 || manifestPath.startsWith("/")) return false;
  return !manifestPath.split("/").includes("..");
}

function remoteDirs(workRoot: string, workspaceKey: string) {
  const base = remotePathExpr(workRoot, workspaceKey);
  return {
    base,
    src: remotePathExpr(workRoot, workspaceKey, "src"),
    manifest: remotePathExpr(workRoot, workspaceKey, "manifest.json"),
  };
}

export interface SyncOutput {
  summary: Omit<RemoteSyncSummary, "snapshotId" | "excludedSecrets" | "skipped">;
}

/** Thrown by syncWorkspace between remote steps when the caller's isCancelled callback fires. */
export class SyncCancelled extends Error {
  constructor() {
    super("workspace sync cancelled");
    this.name = "SyncCancelled";
  }
}

export async function syncWorkspace(input: {
  client: Client;
  snapshot: WorkspaceSnapshot;
  workRoot: string;
  workspacePath: string;
  /** Checked between remote steps; a true return aborts the sync with SyncCancelled. */
  isCancelled?: () => boolean;
}): Promise<SyncOutput> {
  const { client, snapshot, workRoot, workspacePath } = input;
  const cancelled = (): boolean => input.isCancelled?.() === true;
  const dirs = remoteDirs(workRoot, snapshot.workspaceKey);

  if (cancelled()) throw new SyncCancelled();
  await execCollect(client, `mkdir -p ${dirs.base}`);
  if (cancelled()) throw new SyncCancelled();
  const manifestResult = await execCollect(client, `cat ${dirs.manifest} 2>/dev/null`);
  if (cancelled()) throw new SyncCancelled();
  const oldManifest =
    manifestResult.exitCode === 0
      ? parseRemoteManifest(manifestResult.stdout.toString("utf8"))
      : emptyRemoteManifest();
  const diff = diffManifest(oldManifest, snapshot);

  let filesUploaded = 0;
  let bytesUploaded = 0;
  if (diff.upload.length > 0) {
    await uploadEntries({
      client,
      upload: diff.upload,
      srcExpr: dirs.src,
      workspacePath,
    });
    filesUploaded = diff.upload.length;
    bytesUploaded = diff.upload.reduce((sum, file) => sum + file.size, 0);
  }
  if (cancelled()) throw new SyncCancelled();

  let filesDeleted = 0;
  const deletions = diff.deletePaths.filter(isSafeRelativeDeletePath);
  if (deletions.length > 0) {
    const deleted = await execCollect(client, buildDeleteScript(dirs.src), {
      stdin: Buffer.from(`${deletions.join("\0")}\0`, "utf8"),
    });
    if (deleted.exitCode !== 0) {
      // rm -f never recurses, so this is a manifest path that is now a directory on the target;
      // failing loudly beats destroying user data with a recursive delete.
      throw new Error(`deleting removed paths failed on the target (exit ${deleted.exitCode})`);
    }
    filesDeleted = deletions.length;
  }
  if (cancelled()) throw new SyncCancelled();

  const manifest = {
    snapshotId: snapshot.snapshotId,
    entries: Object.fromEntries(
      snapshot.files.map((file) => [
        file.path,
        { hash: file.hash, executable: file.executable, symlink: file.symlink },
      ]),
    ),
  };
  await execCollect(client, buildWriteManifestScript(dirs.manifest), {
    stdin: Buffer.from(JSON.stringify(manifest), "utf8"),
  });

  return {
    summary: {
      filesTotal: snapshot.files.length,
      filesUploaded,
      filesDeleted,
      bytesUploaded,
    },
  };
}

async function uploadEntries(input: {
  client: Client;
  upload: SnapshotEntry[];
  srcExpr: string;
  workspacePath: string;
}): Promise<void> {
  const { client, upload, srcExpr, workspacePath } = input;
  const channel = await openExecChannel(client, buildExtractScript(srcExpr));
  // ssh2 only emits 'close' for an exec channel once its stdout is flowing; a stdin-only pipe
  // never drains it, so the close await below would hang forever. Consume both sides (the
  // extractor writes nothing to stdout; stderr carries tar errors for the failure message).
  let stderr = "";
  channel.on("data", () => undefined);
  channel.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  let exitCode: number | null = null;
  channel.on("exit", (code: number | null) => {
    exitCode = typeof code === "number" ? code : null;
  });
  const closed = new Promise<void>((resolve, reject) => {
    channel.on("close", resolve);
    channel.on("error", reject);
  });
  try {
    await writeTarStream({ channel, upload, workspacePath });
    await closed;
  } finally {
    channel.close();
  }
  if (exitCode !== null && exitCode !== 0) {
    throw new Error(
      `tar extraction failed on the target with exit code ${exitCode}: ${stderr.trim()}`,
    );
  }
}

/**
 * Builds the tar with the system tar reading a NUL-separated path list from stdin (`--null -T -`),
 * streaming the gzip archive into the exec channel. Relative paths + cwd keep the archive rooted at
 * src/ and preserve symlinks and exec bits.
 */
async function writeTarStream(input: {
  channel: ClientChannel;
  upload: SnapshotEntry[];
  workspacePath: string;
}): Promise<void> {
  const { channel, upload, workspacePath } = input;
  const tar = spawn("tar", ["-czf", "-", "--null", "-T", "-"], {
    cwd: workspacePath,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  tar.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const tarDone = new Promise<Error | null>((resolve) => {
    tar.on("error", (error: Error) => resolve(error));
    tar.on("close", (code) =>
      resolve(code === 0 ? null : new Error(stderr.trim() || `tar exited with code ${code}`)),
    );
  });
  // The channel's stdin is the channel itself (ssh2 alias); 'finish' confirms the archive is
  // flushed into ssh2, not just read out of tar.
  const flushed = new Promise<void>((resolve, reject) => {
    channel.stdin.on("finish", () => resolve());
    channel.stdin.on("error", reject);
  });
  tar.stdout.on("error", () => undefined); // tarDone carries the failure
  tar.stdout.pipe(channel.stdin);
  tar.stdin.on("error", () => undefined);
  tar.stdin.end(Buffer.from(`${upload.map((file) => file.path).join("\0")}\0`, "utf8"));
  const [tarResult] = await Promise.all([tarDone, flushed]);
  if (tarResult) throw tarResult;
}
