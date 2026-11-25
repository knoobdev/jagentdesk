import { describe, expect, it } from "vitest";
import type {
  RemoteExecGetJobPayload,
  RemoteExecReadJobOutputPayload,
  RemoteExecStopJobPayload,
} from "@jagentdesk/client/internal/daemon-client";
import type { RemoteExecJobUpdated, RemoteJob } from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import { REMOTE_JOB_OUTPUT_TAIL_LIMIT } from "./job-card-state";
import {
  createRemoteJobCardController,
  type RemoteJobCardClient,
} from "./remote-job-card-controller";

function makeJob(
  status: RemoteJob["status"],
  outputBytes: number,
  overrides: Partial<RemoteJob> = {},
): RemoteJob {
  return {
    id: "rjb_0123456789ab",
    serverId: "srv_1",
    serverLabel: "WSL box",
    workspacePath: "/repo",
    workspaceKey: "wsk_0123456789ab",
    snapshotId: "snp_0123456789ab",
    command: "npm test",
    status,
    exitCode: null,
    error: null,
    agentId: null,
    sync: null,
    outputBytes,
    outputTruncated: false,
    createdAtMs: 0,
    startedAtMs: null,
    finishedAtMs: null,
    timeoutMs: 7_200_000,
    ...overrides,
  };
}

function readPayload(
  chunk: string,
  offset: number,
  totalBytes: number,
): RemoteExecReadJobOutputPayload {
  return {
    requestId: "req",
    error: null,
    chunk,
    offset,
    nextOffset: offset + chunk.length,
    totalBytes,
    complete: offset + chunk.length >= totalBytes,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

class FakeClient implements RemoteJobCardClient {
  getJobResult: RemoteExecGetJobPayload | null = null;
  readHandler: ((offset: number, limit?: number) => RemoteExecReadJobOutputPayload) | null = null;
  stopResult: RemoteExecStopJobPayload | null = null;
  reads: Array<{ offset: number; limit?: number }> = [];
  unsubscribeCount = 0;
  private handlers = new Set<(event: RemoteExecJobUpdated) => void>();

  async remoteExecGetJob(): Promise<RemoteExecGetJobPayload> {
    return this.getJobResult ?? { requestId: "req", error: null, job: null };
  }

  async remoteExecReadJobOutput(options: {
    offset: number;
    limit?: number;
  }): Promise<RemoteExecReadJobOutputPayload> {
    this.reads.push({ offset: options.offset, limit: options.limit });
    return (
      this.readHandler?.(options.offset, options.limit) ??
      readPayload("", options.offset, options.offset)
    );
  }

  async remoteExecStopJob(): Promise<RemoteExecStopJobPayload> {
    return this.stopResult ?? { requestId: "req", error: null, job: null };
  }

  onRemoteExecJobUpdated(handler: (event: RemoteExecJobUpdated) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
      this.unsubscribeCount += 1;
    };
  }

  push(job: RemoteJob) {
    const event: RemoteExecJobUpdated = { type: "remote_exec.job_updated", payload: { job } };
    for (const handler of Array.from(this.handlers)) handler(event);
  }
}

describe("createRemoteJobCardController", () => {
  it("seeds from the tool result and appends output when a push reports growth", async () => {
    const client = new FakeClient();
    client.readHandler = (offset) => readPayload(" world", offset, 11);
    const controller = createRemoteJobCardController({
      client,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("running", 11),
      initialOutput: "hello",
      initialOutputOffset: 0,
    });

    expect(controller.getState().output).toBe("hello");
    expect(controller.getState().nextOffset).toBe(5);

    client.push(makeJob("running", 11));
    await flush();

    expect(controller.getState().output).toBe("hello world");
    expect(controller.getState().nextOffset).toBe(11);
    expect(controller.getState().totalBytes).toBe(11);
    expect(client.reads).toEqual([{ offset: 5, limit: 262_144 }]);
    controller.close();
  });

  it("self-drains when output grew while a read was in flight", async () => {
    const client = new FakeClient();
    client.readHandler = (offset) => {
      if (offset === 5) return readPayload("ab", 5, 11);
      return readPayload("cdef", 7, 11);
    };
    const controller = createRemoteJobCardController({
      client,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("running", 11),
      initialOutput: "hello",
      initialOutputOffset: 0,
    });

    client.push(makeJob("running", 11));
    await flush();
    await flush();

    expect(controller.getState().output).toBe("helloabcdef");
    expect(controller.getState().nextOffset).toBe(11);
    expect(client.reads.map((r) => r.offset)).toEqual([5, 7]);
    controller.close();
  });

  it("never holds more than the 64 KiB tail in memory", async () => {
    const client = new FakeClient();
    const seed = "s".repeat(REMOTE_JOB_OUTPUT_TAIL_LIMIT);
    client.readHandler = (offset) => readPayload("t".repeat(1000), offset, offset + 1000);
    const controller = createRemoteJobCardController({
      client,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("running", REMOTE_JOB_OUTPUT_TAIL_LIMIT),
      initialOutput: seed,
      initialOutputOffset: 0,
    });

    client.push(makeJob("running", REMOTE_JOB_OUTPUT_TAIL_LIMIT + 1000));
    await flush();

    const state = controller.getState();
    expect(state.output.length).toBe(REMOTE_JOB_OUTPUT_TAIL_LIMIT);
    expect(state.output).toBe("s".repeat(REMOTE_JOB_OUTPUT_TAIL_LIMIT - 1000) + "t".repeat(1000));
    controller.close();
  });

  it("stops listening once the job reaches a terminal status", async () => {
    const client = new FakeClient();
    client.readHandler = (offset) => readPayload("done", offset, offset + 4);
    const controller = createRemoteJobCardController({
      client,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("running", 4),
      initialOutput: "",
      initialOutputOffset: 0,
    });

    client.push(makeJob("succeeded", 4, { exitCode: 0, finishedAtMs: 1 }));
    await flush();

    const state = controller.getState();
    expect(state.job?.status).toBe("succeeded");
    expect(state.output).toBe("done");
    expect(client.unsubscribeCount).toBe(1);

    const readsAfterTerminal = client.reads.length;
    client.push(makeJob("succeeded", 400, { exitCode: 0 }));
    await flush();
    expect(controller.getState().nextOffset).toBe(4);
    expect(client.reads.length).toBe(readsAfterTerminal);
    controller.close();
  });

  it("replaces the tail with the last 64 KiB when the history backlog exceeds the limit", async () => {
    const client = new FakeClient();
    const backlog = REMOTE_JOB_OUTPUT_TAIL_LIMIT + 10_000;
    client.getJobResult = { requestId: "req", error: null, job: makeJob("running", backlog) };
    client.readHandler = (offset) => {
      const head = `tail@${offset}`;
      return readPayload(
        head + ".".repeat(Math.max(0, backlog - offset - head.length)),
        offset,
        backlog,
      );
    };
    const controller = createRemoteJobCardController({ client, jobId: "rjb_0123456789ab" });
    await flush();
    await flush();

    const state = controller.getState();
    expect(state.output.startsWith(`tail@${backlog - REMOTE_JOB_OUTPUT_TAIL_LIMIT}`)).toBe(true);
    expect(state.output.length).toBe(REMOTE_JOB_OUTPUT_TAIL_LIMIT);
    expect(state.nextOffset).toBe(backlog);
    expect(state.totalBytes).toBe(backlog);
    expect(client.reads).toEqual([
      { offset: backlog - REMOTE_JOB_OUTPUT_TAIL_LIMIT, limit: 262_144 },
    ]);
    controller.close();
  });

  it("sets stopping and settles on a successful stop", async () => {
    const client = new FakeClient();
    let stoppingSeen = false;
    const controller = createRemoteJobCardController({
      client,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("running", 0),
    });
    controller.subscribe(() => {
      if (controller.getState().stopping) stoppingSeen = true;
    });

    client.stopResult = {
      requestId: "req",
      error: null,
      job: makeJob("stopped", 0, { finishedAtMs: 1 }),
    };
    controller.stop();
    expect(controller.getState().stopping).toBe(true);
    await flush();

    expect(stoppingSeen).toBe(true);
    const state = controller.getState();
    expect(state.stopping).toBe(false);
    expect(state.stopError).toBeNull();
    expect(state.job?.status).toBe("stopped");
    expect(client.unsubscribeCount).toBe(1);
    controller.close();
  });

  it("surfaces a stop failure without settling the card", async () => {
    const client = new FakeClient();
    const controller = createRemoteJobCardController({
      client,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("running", 0),
    });

    client.stopResult = { requestId: "req", error: "job already finished", job: null };
    controller.stop();
    await flush();

    const state = controller.getState();
    expect(state.stopping).toBe(false);
    expect(state.stopError).toBe("job already finished");
    expect(state.job?.status).toBe("running");
    expect(client.unsubscribeCount).toBe(0);
    controller.close();
  });

  it("reports a thrown stop error as stopError", async () => {
    const client = new FakeClient();
    client.remoteExecStopJob = async () => {
      throw new Error("connection lost");
    };
    const controller = createRemoteJobCardController({
      client,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("running", 0),
    });

    controller.stop();
    await flush();

    expect(controller.getState().stopError).toBe("connection lost");
    expect(controller.getState().stopping).toBe(false);
    controller.close();
  });

  it("ignores pushes for other jobs", async () => {
    const client = new FakeClient();
    const controller = createRemoteJobCardController({
      client,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("running", 0),
    });

    client.push(makeJob("succeeded", 0, { id: "rjb_other" }));
    await flush();

    expect(controller.getState().job?.status).toBe("running");
    expect(client.unsubscribeCount).toBe(0);
    controller.close();
  });

  it("works without a client (tool result only)", () => {
    const controller = createRemoteJobCardController({
      client: null,
      jobId: "rjb_0123456789ab",
      initialJob: makeJob("succeeded", 3, { exitCode: 0 }),
      initialOutput: "ok\n",
      initialOutputOffset: 0,
    });

    const state = controller.getState();
    expect(state.job?.status).toBe("succeeded");
    expect(state.output).toBe("ok\n");
    expect(state.nextOffset).toBe(3);
    controller.stop();
    expect(controller.getState().stopping).toBe(false);
    controller.close();
  });
});
