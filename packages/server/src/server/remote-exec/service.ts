import path from "node:path";
import type { Client } from "ssh2";
import { SshConnectionError } from "../ssh/ssh-connection.js";
import { computeWorkspaceKey, newJobId } from "./ids.js";
import { isTerminalStatus, RemoteJobStore } from "./job-store.js";
import { OutputMirror } from "./output-mirror.js";
import {
  buildCheckTargetScript,
  buildLaunchJobScript,
  buildPollScript,
  buildStopScript,
  buildWriteCommandScript,
  remotePathExpr,
} from "./remote-scripts.js";
import { createSnapshot, type WorkspaceSnapshot } from "./snapshot.js";
import { execCollect } from "./ssh-exec.js";
import { syncWorkspace } from "./sync.js";
import {
  REMOTE_DEFAULT_WORK_ROOT,
  REMOTE_OUTPUT_READ_MAX_BYTES,
  REMOTE_OUTPUT_TAIL_BYTES,
  REMOTE_RUN_DEFAULT_TIMEOUT_MS,
  REMOTE_RUN_MAX_TIMEOUT_MS,
  REMOTE_RUN_MAX_WAIT_MS,
  RemoteExecError,
  type RemoteCheckResult,
  type RemoteExecDeps,
  type RemoteExecErrorInfo,
  type RemoteExecService,
  type RemoteJob,
  type RemoteOutputChunk,
  type RemoteRunResult,
  type RemoteSnapshotPreview,
  type RemoteSyncSummary,
  type RemoteTarget,
} from "./types.js";

const POLL_INTERVAL_MS = 1_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const EXEC_TIMEOUT_MS = 30_000;
const STOP_EXEC_TIMEOUT_MS = 20_000;
const OUTPUT_NOTIFY_INTERVAL_MS = 1_000;

interface FollowHandle {
  cancelled: boolean;
}

type NotifyKind = "status" | "output";

function toErrorInfo(error: unknown, fallbackCode: string): RemoteExecErrorInfo {
  if (error instanceof RemoteExecError) return { code: error.code, message: error.message };
  const tailnet = tailnetErrorCode(error);
  if (tailnet)
    return { code: tailnet, message: error instanceof Error ? error.message : String(error) };
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.length > 0) {
    return { code, message: error instanceof Error ? error.message : String(error) };
  }
  return { code: fallbackCode, message: error instanceof Error ? error.message : String(error) };
}

/**
 * ssh-service fails a `via: "tailnet"` target fast when the tsnet bridge has no SOCKS accessor;
 * that code is a condition of its own (spec 33.2/33.10#2), not a generic connection failure, so it
 * is preserved verbatim instead of being folded into connection_failed / sync_failed.
 */
function tailnetErrorCode(error: unknown): string | null {
  return error instanceof SshConnectionError && error.info.code === "tailnet_unavailable"
    ? "tailnet_unavailable"
    : null;
}

function workRootOf(server: { remoteExec?: { enabled: boolean; workRoot?: string } }): string {
  const configured = server.remoteExec?.workRoot?.trim();
  return configured && configured.length > 0 ? configured : REMOTE_DEFAULT_WORK_ROOT;
}

interface PollResult {
  exitCode: number | null;
  gone: boolean;
  bytes: Buffer;
}

export function createRemoteExecService(deps: RemoteExecDeps): RemoteExecService {
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger;
  const store = new RemoteJobStore(path.join(deps.homeDir, "remote-exec", "jobs.json"));
  const listeners = new Set<(job: RemoteJob) => void>();
  const waiters = new Map<string, Set<() => void>>();
  const mirrors = new Map<string, OutputMirror>();
  const handles = new Map<string, FollowHandle>();
  const startLocks = new Map<string, Promise<void>>();
  const lastOutputNotifyAt = new Map<string, number>();
  let shuttingDown = false;

  function mirrorFor(job: RemoteJob): OutputMirror {
    let mirror = mirrors.get(job.id);
    if (!mirror) {
      mirror = new OutputMirror(path.join(deps.homeDir, "remote-exec", "logs", `${job.id}.log`), {
        totalBytes: job.outputBytes,
        truncated: job.outputTruncated,
      });
      mirrors.set(job.id, mirror);
    }
    return mirror;
  }

  function notifyJob(job: RemoteJob, kind: NotifyKind): void {
    const at = now();
    if (kind === "output") {
      const last = lastOutputNotifyAt.get(job.id) ?? 0;
      if (at - last < OUTPUT_NOTIFY_INTERVAL_MS) return;
    }
    lastOutputNotifyAt.set(job.id, at);
    const snapshot = { ...job };
    for (const listener of listeners) listener(snapshot);
    const jobWaiters = waiters.get(job.id);
    if (jobWaiters) {
      waiters.delete(job.id);
      for (const waiter of jobWaiters) waiter();
    }
  }

  async function persistJob(job: RemoteJob, kind: NotifyKind): Promise<void> {
    await store.upsert(job);
    notifyJob(job, kind);
  }

  function waitForUpdate(jobId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        // oxlint-disable-next-line promise/no-multiple-resolved -- the settled flag guards re-entry
        resolve();
      };
      const set = waiters.get(jobId) ?? new Set<() => void>();
      set.add(settle);
      waiters.set(jobId, set);
      timer = setTimeout(settle, Math.max(0, timeoutMs));
    });
  }

  async function applyPoll(job: RemoteJob, poll: PollResult): Promise<void> {
    if (poll.bytes.length === 0) return;
    const mirror = mirrorFor(job);
    await mirror.append(poll.bytes);
    job.outputBytes += poll.bytes.length;
    job.outputTruncated = mirror.state.truncated;
    await persistJob(job, "output");
  }

  /** One polling round against the remote job directory (markers on stderr, log bytes on stdout). */
  async function pollOnce(client: Client, job: RemoteJob, workRoot: string): Promise<PollResult> {
    const jobDirExpr = remotePathExpr(workRoot, job.workspaceKey, "jobs", job.id);
    const result = await execCollect(
      client,
      buildPollScript({ jobDirExpr, offset: job.outputBytes, cap: REMOTE_OUTPUT_READ_MAX_BYTES }),
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    let exitCode: number | null = null;
    let gone = false;
    for (const line of result.stderr.toString("utf8").split("\n")) {
      if (line.startsWith("EXIT ")) {
        const parsed = Number.parseInt(line.slice(5).trim(), 10);
        exitCode = Number.isNaN(parsed) ? null : parsed;
      } else if (line === "GONE") {
        gone = true;
      }
    }
    return { exitCode, gone, bytes: result.stdout };
  }

  function jobDirExprOf(workRoot: string, job: RemoteJob): string {
    return remotePathExpr(workRoot, job.workspaceKey, "jobs", job.id);
  }

  async function readStep(job: RemoteJob, workRoot: string): Promise<PollResult> {
    const lease = await deps.acquireClient(job.serverId);
    try {
      return await pollOnce(lease.client, job, workRoot);
    } finally {
      lease.release();
    }
  }

  function settleByExit(job: RemoteJob, exitCode: number): Promise<void> {
    job.exitCode = exitCode;
    job.status = exitCode === 0 ? "succeeded" : "failed";
    job.finishedAtMs = now();
    handles.delete(job.id);
    return persistJob(job, "status");
  }

  async function followLoop(jobId: string, handle: FollowHandle): Promise<void> {
    let backoffIndex = 0;
    // oxlint-disable-next-line no-unmodified-loop-condition -- shuttingDown flips in stop()
    while (!handle.cancelled && !shuttingDown) {
      const job = store.get(jobId);
      if (!job || isTerminalStatus(job.status)) {
        handles.delete(jobId);
        return;
      }
      const server = await deps.getServer(job.serverId);
      const workRoot = server ? workRootOf(server) : REMOTE_DEFAULT_WORK_ROOT;
      try {
        // Spec 33.6: timeoutMs elapsed -> stop procedure -> timed_out.
        if (job.startedAtMs !== null && now() - job.startedAtMs > job.timeoutMs) {
          const stopped = await stopRemoteJob(job, workRoot, "timed_out");
          if (stopped) return;
          await sleep(BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)]);
          backoffIndex += 1;
          continue;
        }
        const poll = await readStep(job, workRoot);
        backoffIndex = 0;
        await applyPoll(job, poll);
        if (poll.exitCode !== null) {
          // Drain what the capped poll could not fit; the exit code file stays put.
          while (
            !handle.cancelled &&
            // oxlint-disable-next-line no-unmodified-loop-condition -- shuttingDown flips in stop()
            !shuttingDown &&
            poll.bytes.length >= REMOTE_OUTPUT_READ_MAX_BYTES
          ) {
            const extra = await readStep(job, workRoot);
            await applyPoll(job, extra);
            poll.bytes = extra.bytes;
          }
          if (!handle.cancelled && !shuttingDown) await settleByExit(job, poll.exitCode);
          return;
        }
        if (poll.gone) {
          job.status = "lost";
          job.finishedAtMs = now();
          handles.delete(job.id);
          await persistJob(job, "status");
          return;
        }
        if (poll.bytes.length < REMOTE_OUTPUT_READ_MAX_BYTES) {
          await sleep(POLL_INTERVAL_MS);
        }
      } catch (error) {
        // Connection errors leave the job running on the target; resume from the same offset.
        // The tailnet code rides along so a down bridge is visible in the daemon log (33.2).
        logger.debug(
          { err: error, jobId, code: tailnetErrorCode(error) ?? undefined },
          "remote-exec: poll failed, backing off",
        );
        await sleep(BACKOFF_MS[Math.min(backoffIndex, BACKOFF_MS.length - 1)]);
        backoffIndex += 1;
      }
    }
  }

  /** Stop procedure (spec 33.6): SIGTERM the group, 10 s grace, SIGKILL, then the final status. */
  async function stopRemoteJob(
    job: RemoteJob,
    workRoot: string,
    finalStatus: "stopped" | "timed_out",
  ): Promise<boolean> {
    const handle = handles.get(job.id);
    if (handle) handle.cancelled = true;
    handles.delete(job.id);
    try {
      const lease = await deps.acquireClient(job.serverId);
      try {
        await execCollect(
          lease.client,
          buildStopScript({ jobDirExpr: jobDirExprOf(workRoot, job) }),
          { timeoutMs: STOP_EXEC_TIMEOUT_MS },
        );
      } finally {
        lease.release();
      }
    } catch (error) {
      logger.warn({ err: error, jobId: job.id }, "remote-exec: stop procedure failed");
      return false;
    }
    // The job may have ended on its own just before the stop landed.
    try {
      const poll = await readStep(job, workRoot);
      await applyPoll(job, poll);
      if (poll.exitCode !== null) {
        await settleByExit(job, poll.exitCode);
        return true;
      }
    } catch {
      // A final read is best effort; the stop itself already landed.
    }
    job.status = finalStatus;
    job.finishedAtMs = now();
    await persistJob(job, "status");
    return true;
  }

  async function startRemoteJob(client: Client, job: RemoteJob, workRoot: string): Promise<void> {
    const dirExpr = jobDirExprOf(workRoot, job);
    const written = await execCollect(client, buildWriteCommandScript(dirExpr), {
      stdin: Buffer.from(job.command, "utf8"),
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (written.exitCode !== 0) {
      throw new Error(`writing the job command failed on the target (exit ${written.exitCode})`);
    }
    const launched = await execCollect(
      client,
      buildLaunchJobScript({
        srcDirExpr: remotePathExpr(workRoot, job.workspaceKey, "src"),
        jobDirExpr: dirExpr,
      }),
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (launched.exitCode !== 0) {
      throw new Error(`job launcher exited with ${launched.exitCode} on the target`);
    }
  }

  async function runJob(
    job: RemoteJob,
    snapshot: WorkspaceSnapshot,
    handle: FollowHandle,
  ): Promise<void> {
    const server = await deps.getServer(job.serverId);
    const workRoot = server ? workRootOf(server) : REMOTE_DEFAULT_WORK_ROOT;
    let phase: "sync" | "start" = "sync";
    try {
      const lease = await deps.acquireClient(job.serverId);
      let sync: RemoteSyncSummary;
      try {
        const result = await syncWorkspace({
          client: lease.client,
          snapshot,
          workRoot,
          workspacePath: snapshot.workspacePath,
        });
        sync = {
          snapshotId: snapshot.snapshotId,
          excludedSecrets: snapshot.excludedSecrets,
          skipped: snapshot.skipped,
          ...result.summary,
        };
        phase = "start";
        if (handle.cancelled || isTerminalStatus(job.status)) return;
        await startRemoteJob(lease.client, job, workRoot);
      } finally {
        lease.release();
      }
      job.sync = sync;
      job.snapshotId = snapshot.snapshotId;
      job.status = "running";
      job.startedAtMs = now();
      await persistJob(job, "status");
      void followLoop(job.id, handle).catch((error: unknown) => {
        logger.error({ err: error, jobId: job.id }, "remote-exec: follow loop crashed");
      });
    } catch (error) {
      if (handle.cancelled || isTerminalStatus(job.status)) return;
      job.status = "failed";
      job.error = toErrorInfo(error, phase === "sync" ? "sync_failed" : "start_failed");
      job.finishedAtMs = now();
      handles.delete(job.id);
      await persistJob(job, "status");
    }
  }

  async function workRootForJob(job: RemoteJob): Promise<string> {
    const server = await deps.getServer(job.serverId);
    return server ? workRootOf(server) : REMOTE_DEFAULT_WORK_ROOT;
  }

  async function readOutputBytes(job: RemoteJob, offset: number, limit: number): Promise<Buffer> {
    if (limit <= 0) return Buffer.alloc(0);
    const local = await mirrorFor(job).read(offset, limit);
    if (local) return local;
    const workRoot = await workRootForJob(job);
    const logExpr = remotePathExpr(workRoot, job.workspaceKey, "jobs", job.id, "output.log");
    const lease = await deps.acquireClient(job.serverId);
    try {
      const result = await execCollect(
        lease.client,
        `tail -c +${offset + 1} ${logExpr} 2>/dev/null | head -c ${limit}`,
        { timeoutMs: EXEC_TIMEOUT_MS },
      );
      return result.stdout;
    } finally {
      lease.release();
    }
  }

  async function buildRunResult(job: RemoteJob): Promise<RemoteRunResult> {
    const total = job.outputBytes;
    const offset = Math.max(0, total - REMOTE_OUTPUT_TAIL_BYTES);
    const bytes = await readOutputBytes(job, offset, total - offset);
    return {
      job: { ...job },
      output: bytes.toString("utf8"),
      outputOffset: offset,
      outputTruncatedHead: offset > 0,
    };
  }

  const service: RemoteExecService = {
    async listTargets(): Promise<RemoteTarget[]> {
      const servers = await deps.listServers();
      return servers
        .filter((server) => server.remoteExec?.enabled === true)
        .map((server) => ({
          serverId: server.id,
          label: server.label,
          address: server.address,
          via: server.via ?? "direct",
          workRoot: workRootOf(server),
          connectionState: deps.connectionState(server.id),
          environment: deps.environment(server.id),
        }));
    },

    async checkTarget(serverId: string): Promise<RemoteCheckResult> {
      const server = await deps.getServer(serverId);
      if (!server) {
        throw new RemoteExecError("target_not_found", `Unknown server ${serverId}`);
      }
      if (server.remoteExec?.enabled !== true) {
        throw new RemoteExecError(
          "target_disabled",
          `Remote tasks are disabled for ${server.label}`,
        );
      }
      const workRoot = workRootOf(server);
      const blank: RemoteCheckResult = {
        ok: false,
        os: null,
        shell: null,
        missing: [],
        freeKb: null,
        writable: false,
        error: null,
      };
      let lease;
      try {
        lease = await deps.acquireClient(serverId);
      } catch (error) {
        return { ...blank, error: toErrorInfo(error, "connection_failed") };
      }
      try {
        // One exec channel; a reachable server never makes this throw (spec 33.3).
        const result = await execCollect(lease.client, buildCheckTargetScript(workRoot), {
          timeoutMs: EXEC_TIMEOUT_MS,
        });
        const parsed = parseCheckOutput(result.stdout.toString("utf8"));
        return { ...parsed, ok: parsed.missing.length === 0 && parsed.writable };
      } catch (error) {
        return { ...blank, error: toErrorInfo(error, "connection_failed") };
      } finally {
        lease.release();
      }
    },

    async previewSnapshot(input: { workspacePath: string }): Promise<RemoteSnapshotPreview> {
      const snapshot = await createSnapshot({
        workspacePath: input.workspacePath,
        daemonId: deps.daemonId,
        homeDir: deps.homeDir,
      });
      return {
        workspacePath: snapshot.workspacePath,
        workspaceKey: snapshot.workspaceKey,
        filesTotal: snapshot.files.length,
        bytesTotal: snapshot.bytesTotal,
        excludedSecrets: snapshot.excludedSecrets,
        skipped: snapshot.skipped,
      };
    },

    async startJob(input): Promise<RemoteJob> {
      await store.ensureLoaded();
      const server = await deps.getServer(input.serverId);
      if (!server) {
        throw new RemoteExecError("target_not_found", `Unknown server ${input.serverId}`);
      }
      if (server.remoteExec?.enabled !== true) {
        throw new RemoteExecError(
          "target_disabled",
          `Remote tasks are disabled for ${server.label}`,
        );
      }
      const workspacePath = path.resolve(input.workspacePath);
      const workspaceKey = computeWorkspaceKey(deps.daemonId, workspacePath);
      const lockKey = `${input.serverId}\0${workspaceKey}`;
      const jobRunningError = (active: RemoteJob): RemoteExecError =>
        new RemoteExecError(
          "job_running",
          `A job is already active for this workspace on ${server.label} (${active.id}). ` +
            `Wait for it with remote_job_wait or stop it with remote_job_stop.`,
          { jobId: active.id },
        );
      // Serialize concurrent starts for one (serverId, workspaceKey) so the one-running-job rule
      // cannot be raced.
      while (true) {
        const active = store.findActive(input.serverId, workspaceKey);
        if (active) {
          throw jobRunningError(active);
        }
        const prior = startLocks.get(lockKey);
        if (!prior) break;
        await prior.catch(() => undefined);
      }
      let releaseLock!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      startLocks.set(lockKey, gate);
      try {
        const active = store.findActive(input.serverId, workspaceKey);
        if (active) {
          throw jobRunningError(active);
        }
        const snapshot = await createSnapshot({
          workspacePath,
          daemonId: deps.daemonId,
          homeDir: deps.homeDir,
        });
        const job: RemoteJob = {
          id: newJobId(),
          serverId: server.id,
          serverLabel: server.label,
          workspacePath,
          workspaceKey,
          snapshotId: null,
          command: input.command,
          status: "syncing",
          exitCode: null,
          error: null,
          agentId: input.agentId,
          sync: null,
          outputBytes: 0,
          outputTruncated: false,
          createdAtMs: now(),
          startedAtMs: null,
          finishedAtMs: null,
          timeoutMs:
            input.timeoutMs > 0
              ? Math.min(input.timeoutMs, REMOTE_RUN_MAX_TIMEOUT_MS)
              : REMOTE_RUN_DEFAULT_TIMEOUT_MS,
        };
        await store.upsert(job);
        notifyJob(job, "status");
        const handle: FollowHandle = { cancelled: false };
        handles.set(job.id, handle);
        void runJob(job, snapshot, handle);
        return { ...job };
      } finally {
        startLocks.delete(lockKey);
        releaseLock();
      }
    },

    async waitForJob(jobId: string, waitMs: number): Promise<RemoteRunResult> {
      let job = store.get(jobId);
      if (!job) throw new RemoteExecError("job_not_found", `Unknown job ${jobId}`);
      const deadline = now() + Math.max(0, Math.min(waitMs, REMOTE_RUN_MAX_WAIT_MS));
      while (!isTerminalStatus(job.status) && now() < deadline) {
        await waitForUpdate(jobId, deadline - now());
        job = store.get(jobId) ?? job;
      }
      return buildRunResult(job);
    },

    async readOutput(jobId: string, offset: number, limit: number): Promise<RemoteOutputChunk> {
      const job = store.get(jobId);
      if (!job) throw new RemoteExecError("job_not_found", `Unknown job ${jobId}`);
      const total = job.outputBytes;
      const start = Math.max(0, Math.min(offset, total));
      const size = Math.max(0, Math.min(limit, REMOTE_OUTPUT_READ_MAX_BYTES));
      const bytes = await readOutputBytes(job, start, size);
      const nextOffset = start + bytes.length;
      return {
        chunk: bytes.toString("utf8"),
        offset: start,
        nextOffset,
        totalBytes: total,
        complete: nextOffset >= total,
      };
    },

    async stopJob(jobId: string): Promise<RemoteJob> {
      const job = store.get(jobId);
      if (!job) throw new RemoteExecError("job_not_found", `Unknown job ${jobId}`);
      if (isTerminalStatus(job.status)) return { ...job };
      if (job.status === "syncing") {
        const handle = handles.get(job.id);
        if (handle) handle.cancelled = true;
        handles.delete(job.id);
        job.status = "stopped";
        job.finishedAtMs = now();
        await persistJob(job, "status");
        return { ...job };
      }
      const workRoot = await workRootForJob(job);
      const stopped = await stopRemoteJob(job, workRoot, "stopped");
      if (!stopped) {
        throw new RemoteExecError(
          "connection_failed",
          `Could not reach ${job.serverLabel} to stop the job`,
        );
      }
      return { ...job };
    },

    listJobs(filter): RemoteJob[] {
      return store.list(filter);
    },

    getJob(jobId: string): RemoteJob | null {
      const job = store.get(jobId);
      return job ? { ...job } : null;
    },

    onJobUpdated(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async start(): Promise<void> {
      await store.ensureLoaded();
      for (const job of store.list()) {
        if (job.status === "syncing") {
          // Spec 33.6: a daemon restart before the job started fails it; nothing re-runs.
          job.status = "failed";
          job.error = {
            code: "daemon_restarted",
            message: "The daemon restarted before the job started",
          };
          job.finishedAtMs = now();
          await persistJob(job, "status");
        } else if (job.status === "running") {
          const handle: FollowHandle = { cancelled: false };
          handles.set(job.id, handle);
          void followLoop(job.id, handle).catch((error: unknown) => {
            logger.error({ err: error, jobId: job.id }, "remote-exec: resumed follow crashed");
          });
        }
      }
    },

    async stop(): Promise<void> {
      shuttingDown = true;
      for (const handle of handles.values()) handle.cancelled = true;
      handles.clear();
    },
  };

  return service;
}

interface ParsedCheck {
  os: string | null;
  shell: string | null;
  missing: string[];
  freeKb: number | null;
  writable: boolean;
  error: null;
}

function parseCheckOutput(stdout: string): ParsedCheck {
  let os: string | null = null;
  let shell: string | null = null;
  let freeKb: number | null = null;
  let writable = false;
  const missing: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith("SHELL ")) {
      shell = trimmed.slice(6) || null;
    } else if (trimmed.startsWith("MISSING ")) {
      missing.push(trimmed.slice(8));
    } else if (trimmed === "WRITABLE yes") {
      writable = true;
    } else if (trimmed === "WRITABLE no") {
      writable = false;
    } else if (/^\d+$/.test(trimmed)) {
      freeKb = Number.parseInt(trimmed, 10);
    } else if (os === null) {
      os = trimmed;
    }
  }
  return { os, shell, missing, freeKb, writable, error: null };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
