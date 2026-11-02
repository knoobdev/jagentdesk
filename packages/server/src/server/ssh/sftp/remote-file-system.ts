import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { FileEntry, SFTPWrapper, Stats } from "ssh2";
import type { SftpEntry } from "@jagentdesk/protocol/ssh/sftp-schemas";
import {
  SftpError,
  formatPermissions,
  kindFromMode,
  type FileSystem,
  type FsStat,
  type SftpErrorCode,
  type WriteStreamOptions,
} from "./file-system.js";

// SFTP status codes (draft-ietf-secsh-filexfer-02 §7) that ssh2 puts on `error.code`.
const SFTP_STATUS_CODES: Record<number, SftpErrorCode> = {
  2: "not_found",
  3: "permission_denied",
  6: "connection_lost",
  7: "connection_lost",
  11: "already_exists",
};

export function toRemoteSftpError(error: unknown): SftpError {
  if (error instanceof SftpError) return error;
  const err = error as { code?: unknown; message?: string };
  const message = err.message ?? String(error);
  if (typeof err.code === "number" && SFTP_STATUS_CODES[err.code]) {
    return new SftpError(SFTP_STATUS_CODES[err.code], message, { cause: error });
  }
  // ssh2 rejects in-flight requests with these when the channel or connection goes away.
  if (/no response from server|not connected|channel (?:closed|not open)/i.test(message)) {
    return new SftpError("connection_lost", message, { cause: error });
  }
  return new SftpError("failed", message, { cause: error });
}

function call<T>(operation: (done: (error: Error | null | undefined, value?: T) => void) => void) {
  return new Promise<T>((resolve, reject) => {
    operation((error, value) => {
      if (error) reject(toRemoteSftpError(error));
      else resolve(value as T);
    });
  });
}

function toFsStat(stats: Stats): FsStat {
  return {
    kind: kindFromMode(stats.mode),
    size: stats.size,
    modifiedAtMs: stats.mtime * 1000,
    mode: stats.mode & 0o7777,
  };
}

export class SftpFileSystem implements FileSystem {
  readonly paths = path.posix;

  constructor(private readonly sftp: SFTPWrapper) {}

  home(): Promise<string> {
    return call<string>((done) => this.sftp.realpath(".", done));
  }

  async stat(target: string): Promise<FsStat | null> {
    try {
      return toFsStat(await call<Stats>((done) => this.sftp.stat(target, done)));
    } catch (error) {
      if (error instanceof SftpError && error.code === "not_found") return null;
      throw error;
    }
  }

  private lstat(target: string): Promise<Stats> {
    return call<Stats>((done) => this.sftp.lstat(target, done));
  }

  async list(dir: string): Promise<SftpEntry[]> {
    const raw = await call<FileEntry[]>((done) => this.sftp.readdir(dir, done));
    return Promise.all(
      raw
        .filter((item) => item.filename !== "." && item.filename !== "..")
        .map(async (item) => {
          const entryPath = path.posix.join(dir, item.filename);
          const kind = kindFromMode(item.attrs.mode);
          const entry: SftpEntry = {
            name: item.filename,
            path: entryPath,
            kind,
            size: item.attrs.size,
            modifiedAtMs: item.attrs.mtime * 1000,
            mode: item.attrs.mode & 0o7777,
            permissions: formatPermissions(item.attrs.mode),
          };
          if (kind === "symlink") {
            const target = await this.stat(entryPath).catch(() => null);
            if (target) entry.linkTargetKind = target.kind;
          }
          return entry;
        }),
    );
  }

  async mkdir(target: string): Promise<void> {
    if (await this.stat(target)) throw new SftpError("already_exists", `${target} already exists`);
    await call<void>((done) => this.sftp.mkdir(target, done));
  }

  async rename(from: string, to: string): Promise<void> {
    if (await this.stat(to)) throw new SftpError("already_exists", `${to} already exists`);
    await call<void>((done) => this.sftp.rename(from, to, done));
  }

  async remove(target: string): Promise<void> {
    const stats = await this.lstat(target);
    if (!stats.isDirectory()) {
      await call<void>((done) => this.sftp.unlink(target, done));
      return;
    }
    for (const child of await call<FileEntry[]>((done) => this.sftp.readdir(target, done))) {
      if (child.filename === "." || child.filename === "..") continue;
      await this.remove(path.posix.join(target, child.filename));
    }
    await call<void>((done) => this.sftp.rmdir(target, done));
  }

  chmod(target: string, mode: number): Promise<void> {
    return call<void>((done) => this.sftp.chmod(target, mode, done));
  }

  async readFile(target: string, maxBytes: number): Promise<Buffer> {
    const stats = await this.stat(target);
    if (!stats) throw new SftpError("not_found", `${target} does not exist`);
    if (stats.kind !== "file") throw new SftpError("not_a_file", `${target} is not a file`);
    if (stats.size > maxBytes) {
      throw new SftpError("file_too_large", `${target} is larger than ${maxBytes} bytes`);
    }
    return call<Buffer>((done) => this.sftp.readFile(target, done));
  }

  writeFile(target: string, data: Buffer): Promise<void> {
    return call<void>((done) => this.sftp.writeFile(target, data, done));
  }

  createReadStream(target: string, offset: number): Readable {
    return this.sftp.createReadStream(target, { start: offset });
  }

  createWriteStream(target: string, options: WriteStreamOptions): Writable {
    if (options.offset > 0) {
      return this.sftp.createWriteStream(target, { flags: "r+", start: options.offset });
    }
    return this.sftp.createWriteStream(target, { flags: "w" });
  }
}
