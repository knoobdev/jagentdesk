// rpc.test.ts — the six remote_exec.* session requests against an in-test fake implementing
// RemoteExecService. Proves: success payloads pass through, RemoteExecError maps to
// "<code>: <message>", unknown errors to "internal: <message>", error responses carry neutral
// payload values that still parse against the C0 response schemas, a null service (engine not
// merged) still answers instead of timing out, and non-remote_exec messages claim nothing.
import { describe, expect, it, vi } from "vitest";

import {
  RemoteExecCheckTargetResponseSchema,
  RemoteExecGetJobResponseSchema,
  RemoteExecListJobsResponseSchema,
  RemoteExecListTargetsResponseSchema,
  RemoteExecReadJobOutputResponseSchema,
  RemoteExecStopJobResponseSchema,
} from "@jagentdesk/protocol/remote-exec/rpc-schemas";
import {
  formatRemoteExecError,
  handleRemoteExecMessage,
  remoteExecJobUpdated,
  type RemoteExecOutboundMessage,
} from "./rpc.js";
import {
  REMOTE_OUTPUT_READ_MAX_BYTES,
  RemoteExecError,
  type RemoteExecService,
  type RemoteJob,
} from "./types.js";

const job: RemoteJob = {
  id: "rjb_0123456789ab",
  serverId: "srv_a",
  serverLabel: "build box",
  workspacePath: "/repo",
  workspaceKey: "wsk_0123456789ab",
  snapshotId: null,
  command: "npm test",
  status: "succeeded",
  exitCode: 0,
  error: null,
  agentId: null,
  sync: null,
  outputBytes: 12,
  outputTruncated: false,
  createdAtMs: 1_000,
  startedAtMs: 1_100,
  finishedAtMs: 1_200,
  timeoutMs: 7_200_000,
};

function createFakeService(
  overrides: Partial<RemoteExecService> = {},
): RemoteExecService & { calls: Record<string, unknown> } {
  const calls: Record<string, unknown> = {};
  return {
    calls,
    listTargets: vi.fn(async () => {
      calls.listTargets = true;
      return [];
    }),
    checkTarget: vi.fn(async () => {
      calls.checkTarget = true;
      return {
        ok: true,
        os: "linux",
        shell: "/bin/bash",
        missing: [],
        freeKb: 1_000,
        writable: true,
        error: null,
      };
    }),
    previewSnapshot: vi.fn(async () => {
      calls.previewSnapshot = true;
      return {
        workspacePath: "/repo",
        workspaceKey: "wsk_0123456789ab",
        filesTotal: 0,
        bytesTotal: 0,
        excludedSecrets: [],
        skipped: [],
      };
    }),
    startJob: vi.fn(async () => {
      calls.startJob = true;
      return job;
    }),
    waitForJob: vi.fn(async () => {
      calls.waitForJob = true;
      return { job, output: "done", outputOffset: 0, outputTruncatedHead: false };
    }),
    readOutput: vi.fn(async () => {
      calls.readOutput = true;
      return { chunk: "hello", offset: 0, nextOffset: 5, totalBytes: 5, complete: true };
    }),
    stopJob: vi.fn(async () => {
      calls.stopJob = true;
      return { ...job, status: "stopped" as const };
    }),
    listJobs: vi.fn(() => {
      calls.listJobs = true;
      return [job];
    }),
    getJob: vi.fn(() => {
      calls.getJob = true;
      return job;
    }),
    onJobUpdated: vi.fn(() => () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

async function emitFor(
  service: RemoteExecService | null,
  message: Record<string, unknown>,
): Promise<RemoteExecOutboundMessage[]> {
  const emitted: RemoteExecOutboundMessage[] = [];
  const handled = await handleRemoteExecMessage(service, message, (out) => emitted.push(out));
  expect(handled).toBe(true);
  return emitted;
}

describe("handleRemoteExecMessage", () => {
  it("answers list_targets with the service's targets", async () => {
    const service = createFakeService({
      listTargets: vi.fn(async () => [
        {
          serverId: "srv_a",
          label: "build box",
          address: "build.tailnet",
          via: "tailnet" as const,
          workRoot: "~/.jagentdesk/remote-exec",
          connectionState: "connected",
          environment: null,
        },
      ]),
    });

    const emitted = await emitFor(service, {
      type: "remote_exec.list_targets.request",
      requestId: "r1",
    });

    expect(emitted).toEqual([
      {
        type: "remote_exec.list_targets.response",
        payload: {
          requestId: "r1",
          error: null,
          targets: [
            {
              serverId: "srv_a",
              label: "build box",
              address: "build.tailnet",
              via: "tailnet",
              workRoot: "~/.jagentdesk/remote-exec",
              connectionState: "connected",
              environment: null,
            },
          ],
        },
      },
    ]);
    expect(RemoteExecListTargetsResponseSchema.parse(emitted[0])).toEqual(emitted[0]);
  });

  it("answers check_target with the probe result", async () => {
    const service = createFakeService();

    const emitted = await emitFor(service, {
      type: "remote_exec.check_target.request",
      requestId: "r2",
      serverId: "srv_a",
    });

    expect(service.checkTarget).toHaveBeenCalledWith("srv_a");
    expect(emitted[0]).toMatchObject({
      type: "remote_exec.check_target.response",
      payload: { requestId: "r2", error: null, result: { ok: true, os: "linux" } },
    });
  });

  it("forwards list_jobs filters to the service", async () => {
    const service = createFakeService();

    await emitFor(service, {
      type: "remote_exec.list_jobs.request",
      requestId: "r3",
      workspacePath: "/repo",
      limit: 5,
    });
    expect(service.listJobs).toHaveBeenCalledWith({ workspacePath: "/repo", limit: 5 });

    await emitFor(service, { type: "remote_exec.list_jobs.request", requestId: "r4" });
    expect(service.listJobs).toHaveBeenLastCalledWith({});
  });

  it("answers get_job with the stored job or null", async () => {
    const service = createFakeService({ getJob: vi.fn(() => null) });

    const emitted = await emitFor(service, {
      type: "remote_exec.get_job.request",
      requestId: "r5",
      jobId: "rjb_missing",
    });

    expect(emitted).toEqual([
      {
        type: "remote_exec.get_job.response",
        payload: { requestId: "r5", error: null, job: null },
      },
    ]);
    expect(RemoteExecGetJobResponseSchema.parse(emitted[0])).toEqual(emitted[0]);
  });

  it("defaults read_job_output's limit to the contract maximum", async () => {
    const service = createFakeService();

    await emitFor(service, {
      type: "remote_exec.read_job_output.request",
      requestId: "r6",
      jobId: "rjb_0123456789ab",
      offset: 0,
    });
    expect(service.readOutput).toHaveBeenCalledWith(
      "rjb_0123456789ab",
      0,
      REMOTE_OUTPUT_READ_MAX_BYTES,
    );

    await emitFor(service, {
      type: "remote_exec.read_job_output.request",
      requestId: "r7",
      jobId: "rjb_0123456789ab",
      offset: 5,
      limit: 10,
    });
    expect(service.readOutput).toHaveBeenLastCalledWith("rjb_0123456789ab", 5, 10);
  });

  it("answers stop_job with the stopped job", async () => {
    const service = createFakeService();

    const emitted = await emitFor(service, {
      type: "remote_exec.stop_job.request",
      requestId: "r8",
      jobId: "rjb_0123456789ab",
    });

    expect(emitted[0]).toMatchObject({
      type: "remote_exec.stop_job.response",
      payload: { requestId: "r8", error: null, job: { id: "rjb_0123456789ab", status: "stopped" } },
    });
    expect(RemoteExecStopJobResponseSchema.parse(emitted[0])).toEqual(emitted[0]);
  });

  it("maps RemoteExecError to '<code>: <message>' and sends neutral payload fields", async () => {
    const service = createFakeService({
      listTargets: vi.fn(async () => {
        throw new RemoteExecError("target_not_found", "no such server");
      }),
    });

    const emitted = await emitFor(service, {
      type: "remote_exec.list_targets.request",
      requestId: "r9",
    });

    expect(emitted[0]).toMatchObject({
      type: "remote_exec.list_targets.response",
      payload: { requestId: "r9", error: "target_not_found: no such server", targets: [] },
    });
    expect(RemoteExecListTargetsResponseSchema.parse(emitted[0])).toEqual(emitted[0]);
  });

  it("maps unknown errors to 'internal: <message>' and still parses", async () => {
    const service = createFakeService({
      stopJob: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const emitted = await emitFor(service, {
      type: "remote_exec.stop_job.request",
      requestId: "r10",
      jobId: "rjb_0123456789ab",
    });

    expect(emitted[0]).toMatchObject({
      type: "remote_exec.stop_job.response",
      payload: { requestId: "r10", error: "internal: boom", job: null },
    });
    expect(RemoteExecStopJobResponseSchema.parse(emitted[0])).toEqual(emitted[0]);
  });

  it("answers every request with 'internal: remote-exec is unavailable' when the service is null", async () => {
    const requests: Array<Record<string, unknown>> = [
      { type: "remote_exec.list_targets.request", requestId: "n1" },
      { type: "remote_exec.check_target.request", requestId: "n2", serverId: "srv_a" },
      { type: "remote_exec.list_jobs.request", requestId: "n3" },
      { type: "remote_exec.get_job.request", requestId: "n4", jobId: "rjb_x" },
      {
        type: "remote_exec.read_job_output.request",
        requestId: "n5",
        jobId: "rjb_x",
        offset: 3,
      },
      { type: "remote_exec.stop_job.request", requestId: "n6", jobId: "rjb_x" },
    ];
    const schemas = [
      RemoteExecListTargetsResponseSchema,
      RemoteExecCheckTargetResponseSchema,
      RemoteExecListJobsResponseSchema,
      RemoteExecGetJobResponseSchema,
      RemoteExecReadJobOutputResponseSchema,
      RemoteExecStopJobResponseSchema,
    ];

    for (const [index, request] of requests.entries()) {
      const emitted = await emitFor(null, request);
      const response = emitted[0];
      const parsed = schemas[index].parse(response);
      expect(response).toMatchObject({
        type: request.type.replace(".request", ".response"),
        payload: { requestId: request.requestId, error: "internal: remote-exec is unavailable" },
      });
      expect(parsed).toEqual(response);
    }
  });

  it("claims nothing for messages outside the remote_exec namespace", async () => {
    const emitted: RemoteExecOutboundMessage[] = [];
    const handled = await handleRemoteExecMessage(
      createFakeService(),
      { type: "ssh.list.request", requestId: "r11" },
      (out) => emitted.push(out),
    );
    expect(handled).toBe(false);
    expect(emitted).toEqual([]);
  });

  it("claims nothing for an unhandled remote_exec.* type so other dispatchers still run", async () => {
    const handled = await handleRemoteExecMessage(
      createFakeService(),
      { type: "remote_exec.something_else.request", requestId: "r12" },
      () => {},
    );
    expect(handled).toBe(false);
  });
});

describe("formatRemoteExecError", () => {
  it("formats RemoteExecError as '<code>: <message>'", () => {
    expect(formatRemoteExecError(new RemoteExecError("job_running", "one at a time"))).toBe(
      "job_running: one at a time",
    );
  });

  it("formats plain errors and non-errors as 'internal: <message>'", () => {
    expect(formatRemoteExecError(new Error("boom"))).toBe("internal: boom");
    expect(formatRemoteExecError("raw string")).toBe("internal: raw string");
  });
});

describe("remoteExecJobUpdated", () => {
  it("wraps the job in the remote_exec.job_updated push", () => {
    expect(remoteExecJobUpdated(job)).toEqual({
      type: "remote_exec.job_updated",
      payload: { job },
    });
  });
});
