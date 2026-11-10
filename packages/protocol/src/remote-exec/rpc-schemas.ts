import { z } from "zod";

// Wire schemas for remote execution (spec 33 / ADR-0044): jobs run on an SSH target
// (spec 25.3, direct or via tailnet) synced from a local git workspace. Envelope follows
// ssh/rpc-schemas.ts and docs/rpc-namespacing.md: requests carry `type` + `requestId`;
// responses are `{ type, payload: { requestId, error, ...data } }`. `remote_exec.job_updated`
// is an unsolicited daemon→client push: `{ type, payload: { job } }`.
//
// Secrets never reach the wire: sync excludes secret files by rule (spec 33.4), and
// `RemoteSyncSummary.excludedSecrets` / `RemoteSyncSummary.skipped` carry workspace-relative
// paths only, never file contents.

function req<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({ type: z.literal(type), requestId: z.string(), ...extra });
}
function resp<T extends string, S extends z.ZodRawShape>(type: T, extra: S) {
  return z.object({
    type: z.literal(type),
    payload: z.object({ requestId: z.string(), error: z.string().nullable(), ...extra }),
  });
}

// ── DTO schemas ─────────────────────────────────────────────────────────

export const RemoteJobStatusSchema = z.enum([
  "syncing",
  "running",
  "succeeded",
  "failed",
  "stopped",
  "timed_out",
  "lost",
]);
export type RemoteJobStatus = z.infer<typeof RemoteJobStatusSchema>;

export const RemoteExecErrorInfoSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export type RemoteExecErrorInfo = z.infer<typeof RemoteExecErrorInfoSchema>;

export const RemoteSyncSummarySchema = z.object({
  snapshotId: z.string(),
  filesTotal: z.number().int(),
  filesUploaded: z.number().int(),
  filesDeleted: z.number().int(),
  bytesUploaded: z.number().int(),
  // Workspace-relative paths left out by the secret rule (spec 33.4). Never contents.
  excludedSecrets: z.array(z.string()),
  // Workspace-relative paths skipped (submodules).
  skipped: z.array(z.string()),
});
export type RemoteSyncSummary = z.infer<typeof RemoteSyncSummarySchema>;

export const RemoteJobSourceSchema = z.object({
  // Source name = basename of the resolved source directory (spec 33.4 / ADR-0045).
  name: z.string(),
  // Absolute path of the source on the daemon (spec 33.6).
  path: z.string(),
  // Per-source sync summary; paths inside are relative to that source.
  sync: RemoteSyncSummarySchema,
});
export type RemoteJobSource = z.infer<typeof RemoteJobSourceSchema>;

export const RemoteJobSchema = z.object({
  id: z.string(), // `rjb_…`
  serverId: z.string(),
  serverLabel: z.string(),
  workspacePath: z.string(),
  workspaceKey: z.string(), // `wsk_…`
  snapshotId: z.string().nullable(),
  command: z.string(),
  status: RemoteJobStatusSchema,
  exitCode: z.number().int().nullable(),
  error: RemoteExecErrorInfoSchema.nullable(),
  agentId: z.string().nullable(),
  sync: RemoteSyncSummarySchema.nullable(),
  outputBytes: z.number().int(),
  outputTruncated: z.boolean(),
  createdAtMs: z.number(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  timeoutMs: z.number().int(),
  // Optional since ADR-0045; old records and old daemons never send them.
  // True when the job ran with sendCode:false — no code was sent (spec 33.4).
  noCode: z.boolean().optional(),
  // Present when the run selected sources via `source` (spec 33.4); absent for the
  // default (whole-cwd) source, which keeps `sync` as its summary.
  sources: z.array(RemoteJobSourceSchema).optional(),
});
export type RemoteJob = z.infer<typeof RemoteJobSchema>;

export const RemoteTargetSchema = z.object({
  serverId: z.string(),
  label: z.string(),
  address: z.string(),
  via: z.enum(["direct", "tailnet"]),
  workRoot: z.string(),
  // Live ssh.connection.state value for the server (spec 25.3).
  connectionState: z.string(),
  // ServerEnvironment (spec 25.10) when detected, else null.
  environment: z.unknown().nullable(),
});
export type RemoteTarget = z.infer<typeof RemoteTargetSchema>;

export const RemoteCheckResultSchema = z.object({
  ok: z.boolean(),
  os: z.string().nullable(),
  shell: z.string().nullable(),
  missing: z.array(z.string()),
  freeKb: z.number().nullable(),
  writable: z.boolean(),
  error: RemoteExecErrorInfoSchema.nullable(),
});
export type RemoteCheckResult = z.infer<typeof RemoteCheckResultSchema>;

export const RemoteOutputChunkSchema = z.object({
  chunk: z.string(),
  offset: z.number().int(),
  nextOffset: z.number().int(),
  totalBytes: z.number().int(),
  complete: z.boolean(),
});
export type RemoteOutputChunk = z.infer<typeof RemoteOutputChunkSchema>;

// ── RPCs ────────────────────────────────────────────────────────────────

export const RemoteExecListTargetsRequestSchema = req("remote_exec.list_targets.request", {});
export const RemoteExecListTargetsResponseSchema = resp("remote_exec.list_targets.response", {
  targets: z.array(RemoteTargetSchema),
});

// Probes the host (spec 33.3): os/shell, required binaries, free disk space, writable job root.
export const RemoteExecCheckTargetRequestSchema = req("remote_exec.check_target.request", {
  serverId: z.string(),
});
export const RemoteExecCheckTargetResponseSchema = resp("remote_exec.check_target.response", {
  result: RemoteCheckResultSchema.nullable(),
});

// Newest job first.
export const RemoteExecListJobsRequestSchema = req("remote_exec.list_jobs.request", {
  workspacePath: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
export const RemoteExecListJobsResponseSchema = resp("remote_exec.list_jobs.response", {
  jobs: z.array(RemoteJobSchema),
});

export const RemoteExecGetJobRequestSchema = req("remote_exec.get_job.request", {
  jobId: z.string(),
});
export const RemoteExecGetJobResponseSchema = resp("remote_exec.get_job.response", {
  job: RemoteJobSchema.nullable(),
});

// Reads a byte range of the job's combined output. `nextOffset` is the cursor for the next
// read; `complete` is true once `nextOffset` reached `totalBytes`.
export const RemoteExecReadJobOutputRequestSchema = req("remote_exec.read_job_output.request", {
  jobId: z.string(),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(262_144).optional(),
});
export const RemoteExecReadJobOutputResponseSchema = resp("remote_exec.read_job_output.response", {
  chunk: z.string(),
  offset: z.number().int(),
  nextOffset: z.number().int(),
  totalBytes: z.number().int(),
  complete: z.boolean(),
});

export const RemoteExecStopJobRequestSchema = req("remote_exec.stop_job.request", {
  jobId: z.string(),
});
export const RemoteExecStopJobResponseSchema = resp("remote_exec.stop_job.response", {
  job: RemoteJobSchema.nullable(),
});

// Unsolicited push: fires on every status change and at most once per second per job for
// output growth (spec 33.5). Readable with `workspace.read`.
export const RemoteExecJobUpdatedSchema = z.object({
  type: z.literal("remote_exec.job_updated"),
  payload: z.object({ job: RemoteJobSchema }),
});
export type RemoteExecJobUpdated = z.infer<typeof RemoteExecJobUpdatedSchema>;

export const RemoteExecRequestSchemas = [
  RemoteExecListTargetsRequestSchema,
  RemoteExecCheckTargetRequestSchema,
  RemoteExecListJobsRequestSchema,
  RemoteExecGetJobRequestSchema,
  RemoteExecReadJobOutputRequestSchema,
  RemoteExecStopJobRequestSchema,
] as const;

export const RemoteExecResponseSchemas = [
  RemoteExecListTargetsResponseSchema,
  RemoteExecCheckTargetResponseSchema,
  RemoteExecListJobsResponseSchema,
  RemoteExecGetJobResponseSchema,
  RemoteExecReadJobOutputResponseSchema,
  RemoteExecStopJobResponseSchema,
] as const;

export const RemoteExecPushSchemas = [RemoteExecJobUpdatedSchema] as const;
