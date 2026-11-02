import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { Transform, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  SftpConflictPolicy,
  SftpEndpoint,
  SshTransfer,
} from "@jagentdesk/protocol/ssh/sftp-schemas";
import { SftpError, type FileSystem } from "./file-system.js";

export interface EndpointHandle {
  fs: FileSystem;
  release(): void;
}
export type OpenEndpoint = (endpoint: SftpEndpoint) => Promise<EndpointHandle>;

interface PlannedFile {
  relPath: string;
  size: number;
}

interface TransferPlan {
  dirs: string[];
  files: PlannedFile[];
}

interface TransferJob {
  transfer: SshTransfer;
  plan: TransferPlan | null;
  /** True once the top-level target conflict check passed (or a policy resolved it). */
  targetResolved: boolean;
  nextFile: number;
  /** The file at `nextFile` has bytes on the target from an earlier, interrupted run. */
  nextFileStarted: boolean;
  doneBytes: number;
  abort: AbortController | null;
  stopReason: "pause" | "cancel" | null;
}

export interface NewTransfer {
  source: SftpEndpoint;
  sourcePath: string;
  target: SftpEndpoint;
  targetDir: string;
  conflict?: SftpConflictPolicy;
}

export interface TransferQueueOptions {
  openEndpoint: OpenEndpoint;
  onChange(transfer: SshTransfer): void;
  concurrency?: number;
  progressIntervalMs?: number;
  now?: () => number;
}

const FINISHED = new Set<SshTransfer["status"]>(["completed", "skipped", "failed", "cancelled"]);

function isActive(transfer: SshTransfer): boolean {
  return transfer.status === "queued" || transfer.status === "running";
}

function sameEndpoint(a: SftpEndpoint, b: SftpEndpoint): boolean {
  if (a.kind === "daemon" || b.kind === "daemon") return a.kind === b.kind;
  return a.serverId === b.serverId;
}

export function keepBothName(name: string, attempt: number): string {
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  return `${stem} (${attempt})${extension}`;
}

async function uniqueTarget(fs: FileSystem, target: string): Promise<string> {
  const dir = fs.paths.dirname(target);
  const name = fs.paths.basename(target);
  for (let attempt = 1; ; attempt += 1) {
    const candidate = fs.paths.join(dir, keepBothName(name, attempt));
    if (!(await fs.stat(candidate))) return candidate;
  }
}

async function planTree(fs: FileSystem, root: string): Promise<TransferPlan> {
  const plan: TransferPlan = { dirs: [], files: [] };
  async function walk(dir: string, rel: string): Promise<void> {
    for (const entry of await fs.list(dir)) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const kind = entry.kind === "symlink" ? entry.linkTargetKind : entry.kind;
      if (kind === "directory") {
        plan.dirs.push(childRel);
        await walk(entry.path, childRel);
      } else if (kind === "file") {
        const size =
          entry.kind === "symlink" ? ((await fs.stat(entry.path))?.size ?? 0) : entry.size;
        plan.files.push({ relPath: childRel, size });
      }
    }
  }
  await walk(root, "");
  return plan;
}

function resolveRel(fs: FileSystem, root: string, relPath: string): string {
  return relPath ? fs.paths.join(root, ...relPath.split("/")) : root;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function closed(stream: Writable): Promise<void> {
  if (stream.closed) return;
  await once(stream, "close").catch(() => undefined);
}

// The transfer queue behind ssh.sftp.copy / ssh.transfer.* (spec 25.5): progress, pause, resume
// at the byte offset already on the target, retry, and per-transfer conflict policy. Jobs live in
// memory for the daemon's lifetime; a daemon restart drops the queue.
export class TransferQueue {
  private readonly jobs = new Map<string, TransferJob>();
  private readonly running = new Set<string>();
  private readonly lastEmit = new Map<string, number>();
  private readonly waiters = new Map<string, Array<(transfer: SshTransfer) => void>>();
  private readonly concurrency: number;
  private readonly progressIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TransferQueueOptions) {
    this.concurrency = options.concurrency ?? 2;
    this.progressIntervalMs = options.progressIntervalMs ?? 250;
    this.now = options.now ?? Date.now;
  }

  list(): SshTransfer[] {
    return Array.from(this.jobs.values(), (job) => ({ ...job.transfer }));
  }

  get(transferId: string): SshTransfer | null {
    const job = this.jobs.get(transferId);
    return job ? { ...job.transfer } : null;
  }

  async enqueue(input: NewTransfer): Promise<SshTransfer> {
    const source = await this.options.openEndpoint(input.source);
    let kind: SshTransfer["kind"];
    let targetPath: string;
    try {
      const stats = await source.fs.stat(input.sourcePath);
      if (!stats) throw new SftpError("not_found", `${input.sourcePath} does not exist`);
      if (stats.kind !== "file" && stats.kind !== "directory") {
        throw new SftpError("not_a_file", `${input.sourcePath} is not a file or directory`);
      }
      kind = stats.kind;
      const target = await this.options.openEndpoint(input.target);
      try {
        const targetDir = input.targetDir === "" ? await target.fs.home() : input.targetDir;
        targetPath = target.fs.paths.join(targetDir, source.fs.paths.basename(input.sourcePath));
        if (sameEndpoint(input.source, input.target) && kind === "directory") {
          const inside = targetPath.startsWith(`${input.sourcePath}${source.fs.paths.sep}`);
          if (inside) {
            throw new SftpError("invalid_target", "Cannot copy a folder into itself");
          }
        }
      } finally {
        target.release();
      }
    } finally {
      source.release();
    }
    const nowMs = this.now();
    const transfer: SshTransfer = {
      id: `xfr_${randomBytes(6).toString("hex")}`,
      source: input.source,
      sourcePath: input.sourcePath,
      target: input.target,
      targetPath,
      kind,
      status: "queued",
      ...(input.conflict ? { conflict: input.conflict } : {}),
      bytesTotal: 0,
      bytesTransferred: 0,
      filesTotal: 0,
      filesDone: 0,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.jobs.set(transfer.id, {
      transfer,
      plan: null,
      targetResolved: false,
      nextFile: 0,
      nextFileStarted: false,
      doneBytes: 0,
      abort: null,
      stopReason: null,
    });
    this.changed(transfer.id, true);
    this.pump();
    return { ...transfer };
  }

  /** Restarts a transfer stopped in conflict/failed/cancelled, optionally setting the policy. */
  start(transferId: string, conflict?: SftpConflictPolicy): SshTransfer {
    const job = this.require(transferId);
    const { status } = job.transfer;
    if (status !== "conflict" && status !== "failed" && status !== "cancelled") {
      throw new SftpError("failed", `Transfer is ${status}`);
    }
    if (conflict) job.transfer.conflict = conflict;
    delete job.transfer.error;
    job.transfer.status = "queued";
    this.changed(transferId, true);
    this.pump();
    return { ...job.transfer };
  }

  pause(transferId: string): SshTransfer {
    const job = this.require(transferId);
    if (job.transfer.status === "queued") {
      job.transfer.status = "paused";
      this.changed(transferId, true);
    } else if (job.transfer.status === "running") {
      job.stopReason = "pause";
      job.abort?.abort();
    } else {
      throw new SftpError("failed", `Transfer is ${job.transfer.status}`);
    }
    return { ...job.transfer };
  }

  resume(transferId: string): SshTransfer {
    const job = this.require(transferId);
    if (job.transfer.status !== "paused") {
      throw new SftpError("failed", `Transfer is ${job.transfer.status}`);
    }
    job.transfer.status = "queued";
    this.changed(transferId, true);
    this.pump();
    return { ...job.transfer };
  }

  cancel(transferId: string): SshTransfer {
    const job = this.require(transferId);
    if (FINISHED.has(job.transfer.status)) {
      throw new SftpError("failed", `Transfer is ${job.transfer.status}`);
    }
    if (job.transfer.status === "running") {
      job.stopReason = "cancel";
      job.abort?.abort();
    } else {
      job.transfer.status = "cancelled";
      this.changed(transferId, true);
    }
    return { ...job.transfer };
  }

  dismiss(transferId: string): SshTransfer {
    const job = this.require(transferId);
    if (!FINISHED.has(job.transfer.status)) {
      throw new SftpError("failed", "Only finished transfers can be dismissed");
    }
    this.jobs.delete(transferId);
    this.lastEmit.delete(transferId);
    return job.transfer;
  }

  /** Resolves when the transfer leaves queued/running (used by tests and callers that wait). */
  settled(transferId: string): Promise<SshTransfer> {
    const job = this.require(transferId);
    if (!isActive(job.transfer)) return Promise.resolve({ ...job.transfer });
    return new Promise((resolve) => {
      const waiters = this.waiters.get(transferId) ?? [];
      waiters.push(resolve);
      this.waiters.set(transferId, waiters);
    });
  }

  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.transfer.status === "running") {
        job.stopReason = "pause";
        job.abort?.abort();
      }
    }
  }

  private require(transferId: string): TransferJob {
    const job = this.jobs.get(transferId);
    if (!job) throw new SftpError("not_found", `Unknown transfer ${transferId}`);
    return job;
  }

  private changed(transferId: string, force: boolean): void {
    const job = this.jobs.get(transferId);
    if (!job) return;
    const nowMs = this.now();
    job.transfer.updatedAtMs = nowMs;
    if (!isActive(job.transfer)) {
      for (const resolve of this.waiters.get(transferId) ?? []) resolve({ ...job.transfer });
      this.waiters.delete(transferId);
    }
    const last = this.lastEmit.get(transferId) ?? 0;
    if (!force && nowMs - last < this.progressIntervalMs) return;
    this.lastEmit.set(transferId, nowMs);
    this.options.onChange({ ...job.transfer });
  }

  private pump(): void {
    for (const job of this.jobs.values()) {
      if (this.running.size >= this.concurrency) return;
      if (job.transfer.status !== "queued" || this.running.has(job.transfer.id)) continue;
      this.running.add(job.transfer.id);
      void this.run(job).finally(() => {
        this.running.delete(job.transfer.id);
        this.pump();
      });
    }
  }

  private async run(job: TransferJob): Promise<void> {
    const { transfer } = job;
    transfer.status = "running";
    job.abort = new AbortController();
    job.stopReason = null;
    this.changed(transfer.id, true);
    let source: EndpointHandle | null = null;
    let target: EndpointHandle | null = null;
    try {
      source = await this.options.openEndpoint(transfer.source);
      target = await this.options.openEndpoint(transfer.target);
      const outcome = await this.copy(job, source.fs, target.fs, job.abort.signal);
      transfer.status = outcome;
    } catch (error) {
      if (isAbort(error) || job.stopReason) {
        transfer.status = job.stopReason === "cancel" ? "cancelled" : "paused";
        if (job.stopReason === "cancel" && target) {
          await this.discardPartial(job, target.fs);
        }
      } else {
        const failure = error instanceof SftpError ? error : new SftpError("failed", String(error));
        transfer.status = "failed";
        transfer.error = { code: failure.code, message: failure.message };
      }
    } finally {
      source?.release();
      target?.release();
      job.abort = null;
      job.stopReason = null;
    }
    this.changed(transfer.id, true);
  }

  private async copy(
    job: TransferJob,
    sourceFs: FileSystem,
    targetFs: FileSystem,
    signal: AbortSignal,
  ): Promise<SshTransfer["status"]> {
    const { transfer } = job;
    if (!job.plan) {
      job.plan =
        transfer.kind === "file"
          ? {
              dirs: [],
              files: [{ relPath: "", size: (await sourceFs.stat(transfer.sourcePath))?.size ?? 0 }],
            }
          : await planTree(sourceFs, transfer.sourcePath);
      transfer.bytesTotal = job.plan.files.reduce((sum, file) => sum + file.size, 0);
      transfer.filesTotal = job.plan.files.length;
    }
    if (!job.targetResolved) {
      const existing = await targetFs.stat(transfer.targetPath);
      if (existing) {
        if (!transfer.conflict) return "conflict";
        if (transfer.conflict === "skip") return "skipped";
        if (transfer.conflict === "keep-both") {
          transfer.targetPath = await uniqueTarget(targetFs, transfer.targetPath);
        } else if (existing.kind !== transfer.kind) {
          await targetFs.remove(transfer.targetPath);
        }
      }
      job.targetResolved = true;
    }
    if (transfer.kind === "directory") {
      await this.ensureDir(targetFs, transfer.targetPath);
      for (const dir of job.plan.dirs) {
        await this.ensureDir(targetFs, resolveRel(targetFs, transfer.targetPath, dir));
      }
    }
    while (job.nextFile < job.plan.files.length) {
      signal.throwIfAborted();
      const file = job.plan.files[job.nextFile];
      const from = resolveRel(sourceFs, transfer.sourcePath, file.relPath);
      const to = resolveRel(targetFs, transfer.targetPath, file.relPath);
      const already = job.nextFileStarted ? ((await targetFs.stat(to))?.size ?? 0) : 0;
      const offset = Math.min(already, file.size);
      transfer.bytesTransferred = job.doneBytes + offset;
      job.nextFileStarted = true;
      if (offset < file.size || file.size === 0) {
        await this.copyFile({ sourceFs, targetFs, from, to, offset, job, signal });
      }
      job.doneBytes += file.size;
      job.nextFile += 1;
      job.nextFileStarted = false;
      transfer.filesDone = job.nextFile;
      transfer.bytesTransferred = job.doneBytes;
      this.changed(transfer.id, false);
    }
    return "completed";
  }

  private async ensureDir(fs: FileSystem, dir: string): Promise<void> {
    const existing = await fs.stat(dir);
    if (existing?.kind === "directory") return;
    await fs.mkdir(dir);
  }

  private async copyFile(input: {
    sourceFs: FileSystem;
    targetFs: FileSystem;
    from: string;
    to: string;
    offset: number;
    job: TransferJob;
    signal: AbortSignal;
  }): Promise<void> {
    const { job } = input;
    const base = job.doneBytes + input.offset;
    let moved = 0;
    const reader = input.sourceFs.createReadStream(input.from, input.offset);
    const writer = input.targetFs.createWriteStream(input.to, { offset: input.offset });
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        moved += chunk.length;
        job.transfer.bytesTransferred = base + moved;
        this.changed(job.transfer.id, false);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(reader, counter, writer, { signal: input.signal });
    } finally {
      // The next resume stats the target; wait until the handle is closed so its size is final.
      await closed(writer);
    }
  }

  private async discardPartial(job: TransferJob, targetFs: FileSystem): Promise<void> {
    if (!job.plan || !job.nextFileStarted) return;
    const file = job.plan.files[job.nextFile];
    if (!file) return;
    await targetFs
      .remove(resolveRel(targetFs, job.transfer.targetPath, file.relPath))
      .catch(() => undefined);
    job.nextFileStarted = false;
    job.transfer.bytesTransferred = job.doneBytes;
  }
}
