import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureSecureDir, WriteQueue, writeSecureFileAtomic } from "../ssh/snippets/secure-file.js";
import type { RemoteJob } from "./types.js";

// Job records live in $JAGENTDESK_HOME/remote-exec/jobs.json (spec 33.6): atomic writes, 0600 file
// in a 0700 directory, newest 200 jobs kept.

export const JOBS_KEPT = 200;

interface JobStoreFile {
  version: 1;
  jobs: RemoteJob[];
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "stopped", "timed_out", "lost"]);

export function isTerminalStatus(status: RemoteJob["status"]): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class RemoteJobStore {
  private jobs: RemoteJob[] = [];
  private readonly writeQueue = new WriteQueue();
  private loadPromise: Promise<void> | null = null;

  constructor(private readonly filePath: string) {}

  /** Loads jobs.json once; later calls are no-ops. `start()` and `startJob()` both go through this. */
  async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.doLoad();
    await this.loadPromise;
  }

  private async doLoad(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      this.jobs = [];
      return;
    }
    try {
      const parsed = JSON.parse(raw) as JobStoreFile;
      this.jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      this.jobs.sort((a, b) => b.createdAtMs - a.createdAtMs);
    } catch {
      this.jobs = [];
    }
  }

  get(jobId: string): RemoteJob | null {
    return this.jobs.find((job) => job.id === jobId) ?? null;
  }

  list(filter?: { workspacePath?: string; limit?: number }): RemoteJob[] {
    const matched = filter?.workspacePath
      ? this.jobs.filter((job) => job.workspacePath === filter.workspacePath)
      : [...this.jobs];
    const limit = filter?.limit ?? matched.length;
    return matched.slice(0, limit).map((job) => Object.assign({}, job));
  }

  /** First job with the same (serverId, workspaceKey) still syncing or running, if any. */
  findActive(serverId: string, workspaceKey: string): RemoteJob | null {
    return (
      this.jobs.find(
        (job) =>
          job.serverId === serverId &&
          job.workspaceKey === workspaceKey &&
          !isTerminalStatus(job.status),
      ) ?? null
    );
  }

  async upsert(job: RemoteJob): Promise<void> {
    await this.writeQueue.run(async () => {
      const index = this.jobs.findIndex((existing) => existing.id === job.id);
      const record = { ...job };
      if (index >= 0) this.jobs[index] = record;
      else this.jobs.unshift(record);
      this.jobs.sort((a, b) => b.createdAtMs - a.createdAtMs);
      if (this.jobs.length > JOBS_KEPT) this.jobs = this.jobs.slice(0, JOBS_KEPT);
      await this.persist();
    });
  }

  private async persist(): Promise<void> {
    await ensureSecureDir(path.dirname(this.filePath));
    const payload = JSON.stringify({ version: 1, jobs: this.jobs } satisfies JobStoreFile);
    await writeSecureFileAtomic(this.filePath, payload);
  }
}
