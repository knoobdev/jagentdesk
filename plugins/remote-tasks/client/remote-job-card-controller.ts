import type {
  RemoteExecGetJobPayload,
  RemoteExecReadJobOutputPayload,
  RemoteExecStopJobPayload,
} from "@jagentdesk/client/internal/daemon-client";
import type { RemoteExecJobUpdated, RemoteJob } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import {
  REMOTE_JOB_OUTPUT_TAIL_LIMIT,
  isTerminalRemoteJobStatus,
  remoteJobCardReducer,
  type RemoteJobCardAction,
  type RemoteJobCardState,
} from "./job-card-state";

/** Wire limit of one `remote_exec.read_job_output` response (spec 33.8). */
export const REMOTE_JOB_OUTPUT_READ_LIMIT = 262_144;

/**
 * The slice of `DaemonClient` the live job card needs. Structural: the real client satisfies
 * it, and tests wire an in-memory fake.
 */
export interface RemoteJobCardClient {
  remoteExecGetJob(options: { jobId: string }): Promise<RemoteExecGetJobPayload>;
  remoteExecReadJobOutput(options: {
    jobId: string;
    offset: number;
    limit?: number;
  }): Promise<RemoteExecReadJobOutputPayload>;
  remoteExecStopJob(options: { jobId: string }): Promise<RemoteExecStopJobPayload>;
  onRemoteExecJobUpdated(handler: (event: RemoteExecJobUpdated) => void): () => void;
}

export interface RemoteJobCardViewModel extends RemoteJobCardState {
  /** True between pressing Stop and the stop response (or its failure). */
  stopping: boolean;
  stopError: string | null;
}

export interface RemoteJobCardController {
  getState: () => RemoteJobCardViewModel;
  subscribe: (listener: () => void) => () => void;
  /** Asks the daemon to stop the job; the terminal push (or response) settles the card. */
  stop: () => void;
  /** Tears down the subscription and listeners; the mounted hook calls it on unmount. */
  close: () => void;
}

export interface RemoteJobCardControllerOptions {
  client: RemoteJobCardClient | null;
  jobId: string;
  /** Tool result seed (spec 33.7): the ≤64 KiB output tail and its byte offset. */
  initialJob?: RemoteJob | null;
  initialOutput?: string;
  initialOutputOffset?: number;
}

/**
 * Live state for one remote job card: seeds from the tool result, then follows the job with
 * `remote_exec.job_updated` pushes and offset-based `remote_exec.read_job_output` reads until
 * the job reaches a terminal status. Reads are serialized and event-driven — the daemon emits
 * at most one push per second per job (spec 33.8), so the card never polls faster than that.
 */
export function createRemoteJobCardController(
  options: RemoteJobCardControllerOptions,
): RemoteJobCardController {
  const { client, jobId } = options;
  const initialOutput = options.initialOutput ?? "";
  const initialOutputOffset = options.initialOutputOffset ?? 0;

  let state: RemoteJobCardViewModel = {
    job: options.initialJob ?? null,
    output: initialOutput,
    nextOffset: initialOutputOffset + initialOutput.length,
    totalBytes: initialOutputOffset + initialOutput.length,
    stopping: false,
    stopError: null,
  };

  const listeners = new Set<() => void>();
  let closed = false;
  /** Set once the job is terminal; no further reads or pushes are processed. */
  let settled = false;
  let unsubscribe: (() => void) | null = null;
  // Reads must land in order; each one chains behind the previous.
  let readQueue: Promise<void> = Promise.resolve();

  function publish(next: RemoteJobCardViewModel) {
    state = next;
    for (const listener of Array.from(listeners)) listener();
  }

  function applyJob(job: RemoteJob) {
    // A job push while Stop is in flight means the stop (or the job itself) settled the card.
    publish({
      ...remoteJobCardReducer(state, { type: "job", job }),
      stopping: false,
      stopError: null,
    });
    if (isTerminalRemoteJobStatus(job.status)) {
      settled = true;
      unsubscribe?.();
      unsubscribe = null;
      // The push that ends the job may also report output we have not read yet; fetch that
      // tail once (final reads run after settling) so the card shows the complete output.
      if (job.outputBytes > state.nextOffset) enqueueRead(false, { final: true });
    }
  }

  function publishReduced(action: RemoteJobCardAction) {
    publish({
      ...remoteJobCardReducer(state, action),
      stopping: state.stopping,
      stopError: state.stopError,
    });
  }

  function enqueueRead(replaceTail: boolean, opts: { from?: number; final?: boolean } = {}) {
    if (!client || closed) return;
    const { from, final = false } = opts;
    readQueue = readQueue.then(async () => {
      if (closed || (!final && settled)) return undefined;
      const offset = from ?? state.nextOffset;
      try {
        const res = await client.remoteExecReadJobOutput({
          jobId,
          offset,
          limit: REMOTE_JOB_OUTPUT_READ_LIMIT,
        });
        if (closed || res.error) return undefined;
        publishReduced(
          replaceTail
            ? {
                type: "loaded",
                job: null,
                output: res.chunk,
                nextOffset: res.nextOffset,
                totalBytes: res.totalBytes,
              }
            : {
                type: "chunk",
                chunk: res.chunk,
                nextOffset: res.nextOffset,
                totalBytes: res.totalBytes,
              },
        );
        // Output grew while this read was in flight: drain the rest (bounded by the wire limit).
        if (!closed && res.nextOffset > offset && state.nextOffset < res.totalBytes) {
          enqueueRead(false, { final });
        }
      } catch {
        // Transient (host reconnect, daemon restart). The next job_updated push retries.
      }
      return undefined;
    });
  }

  function handleJobUpdated(event: RemoteExecJobUpdated) {
    if (closed || event.payload.job.id !== jobId) return;
    const grew = event.payload.job.outputBytes > state.nextOffset;
    applyJob(event.payload.job);
    if (!settled && grew) enqueueRead(false);
  }

  async function initialize() {
    if (!client || closed) return;
    try {
      const res = await client.remoteExecGetJob({ jobId });
      if (closed) return;
      if (res.error || !res.job) return;
      applyJob(res.job);
      if (settled) return;
      if (res.job.outputBytes > state.nextOffset) {
        // History restore: only the last tail is kept in memory (spec 33.9), so a large
        // backlog skips the middle instead of replaying every byte.
        const backlog = res.job.outputBytes - state.nextOffset;
        if (backlog > REMOTE_JOB_OUTPUT_TAIL_LIMIT) {
          const from = res.job.outputBytes - REMOTE_JOB_OUTPUT_TAIL_LIMIT;
          enqueueRead(true, { from });
        } else {
          enqueueRead(false);
        }
      }
    } catch {
      // Keep the tool-result seed; a later job_updated push reconciles.
    }
  }

  if (client) {
    unsubscribe = client.onRemoteExecJobUpdated(handleJobUpdated);
  }
  void initialize();

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      if (!client || closed || settled || state.stopping) return;
      publish({ ...state, stopping: true });
      void (async () => {
        try {
          const res = await client?.remoteExecStopJob({ jobId });
          if (closed) return;
          if (!res) return;
          if (res.error) {
            publish({ ...state, stopping: false, stopError: res.error });
            return;
          }
          if (res.job) applyJob(res.job);
          else publish({ ...state, stopping: false });
        } catch (error) {
          if (closed) return;
          publish({
            ...state,
            stopping: false,
            stopError: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    },
    close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
      listeners.clear();
    },
  };
}
