// Session entry point for `remote_exec.*` (spec 33.8). One handler per request, every request
// answered (also on error): RemoteExecError maps to `"<code>: <message>"` (the ssh.* error-string
// convention), anything else to `"internal: <message>"`. Error responses still carry the other
// payload fields with neutral values so the C0 response schemas parse.
import type { z } from "zod";
import {
  RemoteExecCheckTargetRequestSchema,
  RemoteExecCheckTargetResponseSchema,
  RemoteExecGetJobRequestSchema,
  RemoteExecGetJobResponseSchema,
  RemoteExecListJobsRequestSchema,
  RemoteExecListJobsResponseSchema,
  RemoteExecListTargetsRequestSchema,
  RemoteExecListTargetsResponseSchema,
  RemoteExecReadJobOutputRequestSchema,
  RemoteExecReadJobOutputResponseSchema,
  RemoteExecStopJobRequestSchema,
  RemoteExecStopJobResponseSchema,
  type RemoteExecJobUpdated,
  type RemoteJob,
} from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import { REMOTE_OUTPUT_READ_MAX_BYTES, RemoteExecError, type RemoteExecService } from "./types.js";

// The protocol exports response schemas, not response type aliases (C0's rpc-schemas.ts).
type RemoteExecListTargetsResponse = z.infer<typeof RemoteExecListTargetsResponseSchema>;
type RemoteExecCheckTargetResponse = z.infer<typeof RemoteExecCheckTargetResponseSchema>;
type RemoteExecListJobsResponse = z.infer<typeof RemoteExecListJobsResponseSchema>;
type RemoteExecGetJobResponse = z.infer<typeof RemoteExecGetJobResponseSchema>;
type RemoteExecReadJobOutputResponse = z.infer<typeof RemoteExecReadJobOutputResponseSchema>;
type RemoteExecStopJobResponse = z.infer<typeof RemoteExecStopJobResponseSchema>;

export type RemoteExecOutboundMessage =
  | RemoteExecListTargetsResponse
  | RemoteExecCheckTargetResponse
  | RemoteExecListJobsResponse
  | RemoteExecGetJobResponse
  | RemoteExecReadJobOutputResponse
  | RemoteExecStopJobResponse
  | RemoteExecJobUpdated;

interface InboundMessage {
  type: string;
}

type Emit = (message: RemoteExecOutboundMessage) => void;

const UNAVAILABLE = "internal: remote-exec is unavailable";

export function formatRemoteExecError(error: unknown): string {
  if (error instanceof RemoteExecError) {
    return `${error.code}: ${error.message}`;
  }
  const text = error instanceof Error ? error.message : String(error);
  return `internal: ${text}`;
}

export function remoteExecJobUpdated(job: RemoteJob): RemoteExecJobUpdated {
  return { type: "remote_exec.job_updated", payload: { job } };
}

/**
 * Answers one request: the service's payload on success, otherwise the neutral payload plus the
 * mapped error string. `service` is null while the remote-exec engine is unavailable; requests
 * then get the UNAVAILABLE error instead of timing out silently.
 */
async function answer(
  emit: Emit,
  type: RemoteExecOutboundMessage["type"],
  requestId: string,
  service: RemoteExecService | null,
  neutralPayload: () => Record<string, unknown>,
  run: (service: RemoteExecService) => Promise<Record<string, unknown>>,
): Promise<void> {
  if (!service) {
    emit({
      type,
      payload: { requestId, error: UNAVAILABLE, ...neutralPayload() },
    } as RemoteExecOutboundMessage);
    return;
  }
  try {
    const payload = await run(service);
    emit({
      type,
      payload: { requestId, error: null, ...payload },
    } as RemoteExecOutboundMessage);
  } catch (error) {
    emit({
      type,
      payload: { requestId, error: formatRemoteExecError(error), ...neutralPayload() },
    } as RemoteExecOutboundMessage);
  }
}

/**
 * Handles one inbound session message. Returns false when the message is not a
 * `remote_exec.*` request (the session then tries its other dispatchers). A `remote_exec.*`
 * type with no handler also claims nothing.
 */
export async function handleRemoteExecMessage(
  service: RemoteExecService | null,
  message: InboundMessage,
  emit: Emit,
): Promise<boolean> {
  if (!message.type.startsWith("remote_exec.")) return false;
  switch (message.type) {
    case "remote_exec.list_targets.request": {
      const request = RemoteExecListTargetsRequestSchema.parse(message);
      await answer(
        emit,
        "remote_exec.list_targets.response",
        request.requestId,
        service,
        () => ({ targets: [] }),
        (remote) => remote.listTargets().then((targets) => ({ targets })),
      );
      return true;
    }
    case "remote_exec.check_target.request": {
      const request = RemoteExecCheckTargetRequestSchema.parse(message);
      await answer(
        emit,
        "remote_exec.check_target.response",
        request.requestId,
        service,
        () => ({ result: null }),
        (remote) => remote.checkTarget(request.serverId).then((result) => ({ result })),
      );
      return true;
    }
    case "remote_exec.list_jobs.request": {
      const request = RemoteExecListJobsRequestSchema.parse(message);
      await answer(
        emit,
        "remote_exec.list_jobs.response",
        request.requestId,
        service,
        () => ({ jobs: [] }),
        (remote) => {
          const jobs = remote.listJobs({
            ...(request.workspacePath !== undefined
              ? { workspacePath: request.workspacePath }
              : {}),
            ...(request.limit !== undefined ? { limit: request.limit } : {}),
          });
          return Promise.resolve({ jobs });
        },
      );
      return true;
    }
    case "remote_exec.get_job.request": {
      const request = RemoteExecGetJobRequestSchema.parse(message);
      await answer(
        emit,
        "remote_exec.get_job.response",
        request.requestId,
        service,
        () => ({ job: null }),
        (remote) => Promise.resolve({ job: remote.getJob(request.jobId) }),
      );
      return true;
    }
    case "remote_exec.read_job_output.request": {
      const request = RemoteExecReadJobOutputRequestSchema.parse(message);
      await answer(
        emit,
        "remote_exec.read_job_output.response",
        request.requestId,
        service,
        () => ({
          chunk: "",
          offset: request.offset,
          nextOffset: request.offset,
          totalBytes: 0,
          complete: false,
        }),
        (remote) =>
          remote
            .readOutput(
              request.jobId,
              request.offset,
              request.limit ?? REMOTE_OUTPUT_READ_MAX_BYTES,
            )
            .then((chunk) => ({ ...chunk })),
      );
      return true;
    }
    case "remote_exec.stop_job.request": {
      const request = RemoteExecStopJobRequestSchema.parse(message);
      await answer(
        emit,
        "remote_exec.stop_job.response",
        request.requestId,
        service,
        () => ({ job: null }),
        (remote) => remote.stopJob(request.jobId).then((job) => ({ job })),
      );
      return true;
    }
    default:
      // A remote_exec.* type with no handler (none today): claim nothing so the session's
      // other dispatchers still run.
      return false;
  }
}
