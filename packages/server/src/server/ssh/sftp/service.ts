import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import type {
  SftpConflictPolicy,
  SftpEndpoint,
  SftpEntry,
  SftpFileVersion,
  SftpOpenedFile,
  SftpWriteResult,
  SshTransfer,
  SshTransferProgress,
} from "@jagentdesk/protocol/ssh/sftp-schemas";
import type { AcquireSshClient } from "../ssh-client-lease.js";
import { ensurePrivateDirectory } from "../../private-files.js";
import { SftpChannelPool } from "./channel-pool.js";
import {
  LocalFileSystem,
  SftpError,
  formatPermissions,
  parseOctalMode,
  sortEntries,
  type FileSystem,
} from "./file-system.js";
import { TransferQueue, type EndpointHandle } from "./transfer-queue.js";

export const EDITOR_MAX_BYTES = 5 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export interface SftpListing {
  path: string;
  parentPath: string | null;
  entries: SftpEntry[];
}

export interface SftpDownload {
  transfer: SshTransfer;
  cwd: string;
  path: string;
}

export interface SftpServiceOptions {
  acquire: AcquireSshClient;
  /** `$JAGENTDESK_HOME/ssh` — device downloads are staged in `downloads/` below it. */
  sshDir: string;
  channelIdleMs?: number;
}

function revisionOf(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

// ssh.sftp.* and ssh.transfer.* (spec 25.5). Push events go to every subscriber; the owner
// broadcasts them to all connected clients.
export class SftpService {
  private readonly pool: SftpChannelPool;
  private readonly local = new LocalFileSystem();
  private readonly queue: TransferQueue;
  private readonly listeners = new Set<(event: SshTransferProgress) => void>();
  private readonly downloadsDir: string;

  constructor(options: SftpServiceOptions) {
    this.pool = new SftpChannelPool(options.acquire, options.channelIdleMs);
    this.downloadsDir = path.join(options.sshDir, "downloads");
    this.queue = new TransferQueue({
      openEndpoint: (endpoint) => this.open(endpoint),
      onChange: (transfer) => {
        for (const listener of this.listeners)
          listener({ type: "ssh.transfer.progress", transfer });
      },
    });
  }

  subscribe(listener: (event: SshTransferProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async open(endpoint: SftpEndpoint): Promise<EndpointHandle> {
    if (endpoint.kind === "daemon") return { fs: this.local, release: () => undefined };
    return this.pool.open(endpoint.serverId);
  }

  private async withFs<T>(endpoint: SftpEndpoint, run: (fs: FileSystem) => Promise<T>): Promise<T> {
    const handle = await this.open(endpoint);
    try {
      return await run(handle.fs);
    } finally {
      handle.release();
    }
  }

  list(input: { endpoint: SftpEndpoint; path: string; showHidden: boolean }): Promise<SftpListing> {
    return this.withFs(input.endpoint, async (fs) => {
      const dir = input.path === "" ? await fs.home() : fs.paths.resolve(input.path);
      const entries = await fs.list(dir);
      const visible = input.showHidden ? entries : entries.filter((e) => !e.name.startsWith("."));
      const parent = fs.paths.dirname(dir);
      return {
        path: dir,
        parentPath: parent === dir ? null : parent,
        entries: sortEntries(visible),
      };
    });
  }

  stat(endpoint: SftpEndpoint, target: string): Promise<SftpEntry | null> {
    return this.withFs(endpoint, async (fs) => {
      const stats = await fs.stat(target);
      if (!stats) return null;
      return {
        name: fs.paths.basename(target),
        path: target,
        kind: stats.kind,
        size: stats.size,
        modifiedAtMs: stats.modifiedAtMs,
        mode: stats.mode,
        permissions: formatPermissions(stats.mode),
      };
    });
  }

  mkdir(endpoint: SftpEndpoint, target: string): Promise<void> {
    return this.withFs(endpoint, (fs) => fs.mkdir(target));
  }

  rename(endpoint: SftpEndpoint, fromPath: string, toPath: string): Promise<void> {
    return this.withFs(endpoint, (fs) => fs.rename(fromPath, toPath));
  }

  delete(endpoint: SftpEndpoint, target: string): Promise<void> {
    return this.withFs(endpoint, async (fs) => {
      if (fs.paths.dirname(target) === target) {
        throw new SftpError("invalid_target", "Refusing to delete the root directory");
      }
      await fs.remove(target);
    });
  }

  chmod(endpoint: SftpEndpoint, target: string, mode: string): Promise<void> {
    return this.withFs(endpoint, (fs) => fs.chmod(target, parseOctalMode(mode)));
  }

  read(endpoint: SftpEndpoint, target: string): Promise<SftpOpenedFile> {
    return this.withFs(endpoint, async (fs) => {
      const data = await fs.readFile(target, EDITOR_MAX_BYTES);
      if (looksBinary(data)) throw new SftpError("not_text", `${target} is not a text file`);
      const hasBom = data.subarray(0, 3).equals(UTF8_BOM);
      const body = hasBom ? data.subarray(3) : data;
      return {
        content: body.toString("utf8"),
        hasBom,
        version: await this.versionOf(fs, target, data),
      };
    });
  }

  write(input: {
    endpoint: SftpEndpoint;
    path: string;
    content: string;
    hasBom: boolean;
    expectedRevision?: string;
  }): Promise<SftpWriteResult> {
    return this.withFs(input.endpoint, async (fs) => {
      if (input.expectedRevision) {
        const current = await this.currentVersion(fs, input.path);
        if (!current || current.revision !== input.expectedRevision) {
          return { status: "conflict", current };
        }
      }
      const body = Buffer.from(input.content, "utf8");
      const data = input.hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
      await fs.writeFile(input.path, data);
      return { status: "written", version: await this.versionOf(fs, input.path, data) };
    });
  }

  private async currentVersion(fs: FileSystem, target: string): Promise<SftpFileVersion | null> {
    const stats = await fs.stat(target);
    if (!stats || stats.kind !== "file") return null;
    return this.versionOf(fs, target, await fs.readFile(target, EDITOR_MAX_BYTES));
  }

  private async versionOf(fs: FileSystem, target: string, data: Buffer): Promise<SftpFileVersion> {
    const stats = await fs.stat(target);
    return {
      path: target,
      size: data.length,
      modifiedAtMs: stats?.modifiedAtMs ?? 0,
      revision: revisionOf(data),
    };
  }

  async copy(input: {
    source: SftpEndpoint;
    sourcePaths: string[];
    target: SftpEndpoint;
    targetDir: string;
    conflict?: SftpConflictPolicy;
  }): Promise<SshTransfer[]> {
    const transfers: SshTransfer[] = [];
    for (const sourcePath of input.sourcePaths) {
      transfers.push(
        await this.queue.enqueue({
          source: input.source,
          sourcePath,
          target: input.target,
          targetDir: input.targetDir,
          conflict: input.conflict,
        }),
      );
    }
    return transfers;
  }

  async download(endpoint: SftpEndpoint, target: string): Promise<SftpDownload> {
    const stats = await this.withFs(endpoint, (fs) => fs.stat(target));
    if (!stats) throw new SftpError("not_found", `${target} does not exist`);
    if (stats.kind !== "file") {
      throw new SftpError("not_a_file", "Only files can be downloaded to the device");
    }
    const stagingDir = path.join(this.downloadsDir, randomBytes(6).toString("hex"));
    ensurePrivateDirectory(this.downloadsDir);
    ensurePrivateDirectory(stagingDir);
    const transfer = await this.queue.enqueue({
      source: endpoint,
      sourcePath: target,
      target: { kind: "daemon" },
      targetDir: stagingDir,
      conflict: "replace",
    });
    return { transfer, cwd: stagingDir, path: path.basename(transfer.targetPath) };
  }

  listTransfers(): SshTransfer[] {
    return this.queue.list();
  }

  startTransfer(transferId: string, conflict?: SftpConflictPolicy): SshTransfer {
    return this.queue.start(transferId, conflict);
  }

  pauseTransfer(transferId: string): SshTransfer {
    return this.queue.pause(transferId);
  }

  resumeTransfer(transferId: string): SshTransfer {
    return this.queue.resume(transferId);
  }

  cancelTransfer(transferId: string): SshTransfer {
    return this.queue.cancel(transferId);
  }

  async dismissTransfer(transferId: string): Promise<void> {
    const transfer = this.queue.dismiss(transferId);
    const staged = path.dirname(transfer.targetPath);
    if (transfer.target.kind === "daemon" && path.dirname(staged) === this.downloadsDir) {
      await rm(staged, { recursive: true, force: true });
    }
  }

  settled(transferId: string): Promise<SshTransfer> {
    return this.queue.settled(transferId);
  }

  dispose(): void {
    this.queue.dispose();
    this.pool.dispose();
  }
}
