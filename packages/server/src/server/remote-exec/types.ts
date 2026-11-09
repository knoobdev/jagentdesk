// packages/server/src/server/remote-exec/types.ts — shared CONTRACT for spec 33 / ADR-0044.
// Copied verbatim by several coders; do NOT edit. Propose changes in your report instead.
import type { Client } from "ssh2";
import type pino from "pino";

export type RemoteJobStatus =
  | "syncing"
  | "running"
  | "succeeded"
  | "failed"
  | "stopped"
  | "timed_out"
  | "lost";

export type RemoteExecErrorCode =
  | "not_git_workspace"
  | "snapshot_too_large"
  | "job_running"
  | "target_not_found"
  | "target_disabled"
  | "job_not_found"
  | "tailnet_unavailable"
  | "connection_failed"
  | "sync_failed"
  | "start_failed"
  | "daemon_restarted";

export class RemoteExecError extends Error {
  constructor(
    readonly code: RemoteExecErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RemoteExecError";
  }
}

export interface RemoteExecErrorInfo {
  code: string;
  message: string;
}

export interface RemoteSyncSummary {
  snapshotId: string;
  filesTotal: number;
  filesUploaded: number;
  filesDeleted: number;
  bytesUploaded: number;
  /** Workspace-relative paths left out by the secret rule (spec 33.4). Never contents. */
  excludedSecrets: string[];
  /** Workspace-relative paths skipped (submodules). */
  skipped: string[];
}

export interface RemoteJob {
  id: string; // rjb_<12 hex>
  serverId: string;
  serverLabel: string;
  workspacePath: string;
  workspaceKey: string; // wsk_<12 hex>
  snapshotId: string | null;
  command: string;
  status: RemoteJobStatus;
  exitCode: number | null;
  error: RemoteExecErrorInfo | null;
  agentId: string | null;
  sync: RemoteSyncSummary | null;
  outputBytes: number;
  outputTruncated: boolean;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  timeoutMs: number;
}

export interface RemoteSnapshotPreview {
  workspacePath: string;
  workspaceKey: string;
  filesTotal: number;
  bytesTotal: number;
  excludedSecrets: string[];
  skipped: string[];
}

export interface RemoteTarget {
  serverId: string;
  label: string;
  address: string;
  via: "direct" | "tailnet";
  workRoot: string;
  connectionState: string;
  /** ServerEnvironment (spec 25.10) when detected, else null. */
  environment: unknown | null;
}

export interface RemoteCheckResult {
  ok: boolean;
  os: string | null;
  shell: string | null;
  missing: string[];
  freeKb: number | null;
  writable: boolean;
  error: RemoteExecErrorInfo | null;
}

export interface RemoteOutputChunk {
  chunk: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  complete: boolean;
}

export interface RemoteRunResult {
  job: RemoteJob;
  /** At most the last 65536 bytes of output at return time. */
  output: string;
  /** Byte offset of `output` in the full output. */
  outputOffset: number;
  /** True when `output` does not start at byte 0. */
  outputTruncatedHead: boolean;
}

export interface RemoteExecServerConfig {
  id: string;
  label: string;
  address: string;
  via?: "direct" | "tailnet";
  remoteExec?: { enabled: boolean; workRoot?: string };
}

export interface RemoteExecDeps {
  /** $JAGENTDESK_HOME */
  homeDir: string;
  daemonId: string;
  getServer(serverId: string): Promise<RemoteExecServerConfig | null>;
  listServers(): Promise<RemoteExecServerConfig[]>;
  /** Connected + authenticated client for the server (spec 25.3, incl. via:"tailnet"). Throws on failure. */
  acquireClient(serverId: string): Promise<{ client: Client; release(): void }>;
  connectionState(serverId: string): string;
  environment(serverId: string): unknown | null;
  logger: pino.Logger;
  now?(): number;
}

export const REMOTE_RUN_DEFAULT_TIMEOUT_MS = 7_200_000;
export const REMOTE_RUN_MAX_TIMEOUT_MS = 86_400_000;
export const REMOTE_RUN_DEFAULT_WAIT_MS = 120_000;
export const REMOTE_RUN_MAX_WAIT_MS = 1_800_000;
export const REMOTE_OUTPUT_TAIL_BYTES = 65_536;
export const REMOTE_OUTPUT_READ_MAX_BYTES = 262_144;
export const REMOTE_DEFAULT_WORK_ROOT = "~/.jagentdesk/remote-exec";

export interface RemoteExecService {
  listTargets(): Promise<RemoteTarget[]>;
  checkTarget(serverId: string): Promise<RemoteCheckResult>;
  /** Snapshot stats for the approval card; uploads nothing. */
  previewSnapshot(input: { workspacePath: string }): Promise<RemoteSnapshotPreview>;
  /**
   * Validates target + workspace + the one-running-job rule (throws RemoteExecError job_running with
   * details.jobId), records the job as `syncing`, then syncs and starts it in the background. Returns
   * the job record as soon as it exists.
   */
  startJob(input: {
    serverId: string;
    workspacePath: string;
    command: string;
    timeoutMs: number;
    agentId: string | null;
  }): Promise<RemoteJob>;
  /** Resolves when the job is terminal or waitMs elapses (job still running). */
  waitForJob(jobId: string, waitMs: number): Promise<RemoteRunResult>;
  readOutput(jobId: string, offset: number, limit: number): Promise<RemoteOutputChunk>;
  stopJob(jobId: string): Promise<RemoteJob>;
  listJobs(filter: { workspacePath?: string; limit?: number }): RemoteJob[];
  getJob(jobId: string): RemoteJob | null;
  /** Fires on every status change and at most once per second per job for output growth. */
  onJobUpdated(listener: (job: RemoteJob) => void): () => void;
  /** Loads jobs.json, marks `syncing` jobs failed (daemon_restarted), resumes following `running` jobs. */
  start(): Promise<void>;
  stop(): Promise<void>;
}
