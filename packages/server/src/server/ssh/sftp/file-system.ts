import { createReadStream, createWriteStream, promises as fs, type Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { SftpEntry, SftpEntryKind } from "@jagentdesk/protocol/ssh/sftp-schemas";

// One pane of the SFTP browser: the daemon's own disk or a server's SFTP channel. Two real
// implementations (LocalFileSystem here, SftpFileSystem in remote-file-system.ts) let the
// transfer queue copy daemon↔server and server↔server with one code path.

export type SftpErrorCode =
  | "not_found"
  | "permission_denied"
  | "already_exists"
  | "not_a_file"
  | "not_text"
  | "file_too_large"
  | "invalid_target"
  | "connection_lost"
  | "failed";

export class SftpError extends Error {
  constructor(
    readonly code: SftpErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SftpError";
  }
}

export interface FsStat {
  kind: SftpEntryKind;
  size: number;
  modifiedAtMs: number;
  mode: number;
}

export interface WriteStreamOptions {
  /** Byte offset to continue writing at; 0 truncates or creates the file. */
  offset: number;
}

export interface FileSystem {
  /** Path flavour of this endpoint (`path.posix` for servers). */
  readonly paths: path.PlatformPath;
  home(): Promise<string>;
  /** Follows symlinks. Null when nothing exists at `target`. */
  stat(target: string): Promise<FsStat | null>;
  list(dir: string): Promise<SftpEntry[]>;
  mkdir(target: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file, or a directory with everything in it. */
  remove(target: string): Promise<void>;
  chmod(target: string, mode: number): Promise<void>;
  readFile(target: string, maxBytes: number): Promise<Buffer>;
  writeFile(target: string, data: Buffer): Promise<void>;
  createReadStream(target: string, offset: number): Readable;
  createWriteStream(target: string, options: WriteStreamOptions): Writable;
}

const PERMISSION_CHARS = ["r", "w", "x"] as const;

export function formatPermissions(mode: number): string {
  let out = "";
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (mode >> shift) & 0o7;
    PERMISSION_CHARS.forEach((char, index) => {
      out += bits & (0o4 >> index) ? char : "-";
    });
  }
  return out;
}

export function parseOctalMode(mode: string): number {
  return Number.parseInt(mode, 8) & 0o7777;
}

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

export function kindFromMode(mode: number): SftpEntryKind {
  const type = mode & S_IFMT;
  if (type === S_IFDIR) return "directory";
  if (type === S_IFREG) return "file";
  if (type === S_IFLNK) return "symlink";
  return "other";
}

export function sortEntries(entries: SftpEntry[]): SftpEntry[] {
  const rank = (entry: SftpEntry) =>
    entry.kind === "directory" || entry.linkTargetKind === "directory" ? 0 : 1;
  return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function toFsStat(stats: Stats): FsStat {
  return {
    kind: kindFromMode(stats.mode),
    size: stats.size,
    modifiedAtMs: Math.round(stats.mtimeMs),
    mode: stats.mode & 0o7777,
  };
}

const LOCAL_ERROR_CODES: Record<string, SftpErrorCode> = {
  ENOENT: "not_found",
  ENOTDIR: "not_found",
  EACCES: "permission_denied",
  EPERM: "permission_denied",
  EEXIST: "already_exists",
  ENOTEMPTY: "already_exists",
  EISDIR: "not_a_file",
};

export function toLocalSftpError(error: unknown): SftpError {
  if (error instanceof SftpError) return error;
  const errno = error as NodeJS.ErrnoException;
  const code = (errno.code ? LOCAL_ERROR_CODES[errno.code] : undefined) ?? "failed";
  return new SftpError(code, errno.message ?? String(error), { cause: error });
}

async function local<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toLocalSftpError(error);
  }
}

export class LocalFileSystem implements FileSystem {
  readonly paths = path;

  async home(): Promise<string> {
    return os.homedir();
  }

  async stat(target: string): Promise<FsStat | null> {
    try {
      return toFsStat(await fs.stat(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw toLocalSftpError(error);
    }
  }

  list(dir: string): Promise<SftpEntry[]> {
    return local(async () => {
      const names = await fs.readdir(dir);
      const entries = await Promise.all(names.map((name) => this.describe(dir, name)));
      return entries.filter((entry): entry is SftpEntry => entry !== null);
    });
  }

  private async describe(dir: string, name: string): Promise<SftpEntry | null> {
    const entryPath = path.join(dir, name);
    let stats: Stats;
    try {
      stats = await fs.lstat(entryPath);
    } catch {
      // Raced with a delete between readdir and lstat.
      return null;
    }
    const base = toFsStat(stats);
    const entry: SftpEntry = {
      name,
      path: entryPath,
      kind: base.kind,
      size: base.size,
      modifiedAtMs: base.modifiedAtMs,
      mode: base.mode,
      permissions: formatPermissions(base.mode),
    };
    if (base.kind === "symlink") {
      const target = await this.stat(entryPath).catch(() => null);
      if (target) entry.linkTargetKind = target.kind;
    }
    return entry;
  }

  mkdir(target: string): Promise<void> {
    return local(() => fs.mkdir(target));
  }

  rename(from: string, to: string): Promise<void> {
    return local(async () => {
      if (await this.stat(to)) {
        throw new SftpError("already_exists", `${to} already exists`);
      }
      await fs.rename(from, to);
    });
  }

  remove(target: string): Promise<void> {
    return local(async () => {
      await fs.lstat(target);
      await fs.rm(target, { recursive: true, force: false });
    });
  }

  chmod(target: string, mode: number): Promise<void> {
    return local(() => fs.chmod(target, mode));
  }

  readFile(target: string, maxBytes: number): Promise<Buffer> {
    return local(async () => {
      const stats = await this.stat(target);
      if (!stats) throw new SftpError("not_found", `${target} does not exist`);
      if (stats.kind !== "file") throw new SftpError("not_a_file", `${target} is not a file`);
      if (stats.size > maxBytes) {
        throw new SftpError("file_too_large", `${target} is larger than ${maxBytes} bytes`);
      }
      return fs.readFile(target);
    });
  }

  writeFile(target: string, data: Buffer): Promise<void> {
    return local(() => fs.writeFile(target, data));
  }

  createReadStream(target: string, offset: number): Readable {
    return createReadStream(target, { start: offset });
  }

  createWriteStream(target: string, options: WriteStreamOptions): Writable {
    if (options.offset > 0) {
      return createWriteStream(target, { flags: "r+", start: options.offset });
    }
    return createWriteStream(target, { flags: "w" });
  }
}
