import { describe, expect, it } from "vitest";
import { SessionInboundMessageSchema, SessionOutboundMessageSchema } from "./messages.js";
import type { RemoteJob } from "./remote-exec/rpc-schemas.js";

// Spec 33 / ADR-0044: remote_exec.* RPCs and the remote_exec.job_updated push, plus the
// SshServer via/remoteExec fields that opt a saved server into remote execution. Additive:
// old clients ignore the new fields, old daemons never send the new types.

function jobFixture(overrides: Partial<RemoteJob> = {}): RemoteJob {
  return {
    id: "rjb_1a2b3c4d5e6f",
    serverId: "srv_1a2b3c4d5e6f",
    serverLabel: "build-box",
    workspacePath: "/Users/dev/work/app",
    workspaceKey: "wsk_1a2b3c4d5e6f",
    snapshotId: null,
    command: "npm test",
    status: "running",
    exitCode: null,
    error: null,
    agentId: null,
    sync: {
      snapshotId: "rsnap_1a2b3c4d5e6f",
      filesTotal: 120,
      filesUploaded: 3,
      filesDeleted: 0,
      bytesUploaded: 4096,
      excludedSecrets: [".env"],
      skipped: ["vendor/lib"],
    },
    outputBytes: 512,
    outputTruncated: false,
    createdAtMs: 1_000,
    startedAtMs: 1_050,
    finishedAtMs: null,
    timeoutMs: 7_200_000,
    ...overrides,
  };
}

describe("remote_exec.* requests", () => {
  it("parses list_targets with no parameters", () => {
    const message = { type: "remote_exec.list_targets.request", requestId: "req_1" };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses check_target", () => {
    const message = {
      type: "remote_exec.check_target.request",
      requestId: "req_2",
      serverId: "srv_1a2b3c4d5e6f",
    };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses list_jobs without filters", () => {
    const message = { type: "remote_exec.list_jobs.request", requestId: "req_3" };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses list_jobs with workspacePath and limit", () => {
    const message = {
      type: "remote_exec.list_jobs.request",
      requestId: "req_4",
      workspacePath: "/Users/dev/work/app",
      limit: 50,
    };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects list_jobs limit out of bounds", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "remote_exec.list_jobs.request",
        requestId: "req_5",
        limit: 0,
      }).success,
    ).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "remote_exec.list_jobs.request",
        requestId: "req_6",
        limit: 201,
      }).success,
    ).toBe(false);
  });

  it("accepts list_jobs limit bounds", () => {
    for (const limit of [1, 200]) {
      expect(
        SessionInboundMessageSchema.safeParse({
          type: "remote_exec.list_jobs.request",
          requestId: `req_${limit}`,
          limit,
        }).success,
      ).toBe(true);
    }
  });

  it("parses get_job and stop_job", () => {
    const get = {
      type: "remote_exec.get_job.request",
      requestId: "req_7",
      jobId: "rjb_1a2b3c4d5e6f",
    };
    expect(SessionInboundMessageSchema.parse(get)).toEqual(get);
    const stop = {
      type: "remote_exec.stop_job.request",
      requestId: "req_8",
      jobId: "rjb_1a2b3c4d5e6f",
    };
    expect(SessionInboundMessageSchema.parse(stop)).toEqual(stop);
  });

  it("parses read_job_output and enforces offset/limit bounds", () => {
    const message = {
      type: "remote_exec.read_job_output.request",
      requestId: "req_9",
      jobId: "rjb_1a2b3c4d5e6f",
      offset: 0,
      limit: 262_144,
    };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "remote_exec.read_job_output.request",
        requestId: "req_10",
        jobId: "rjb_1a2b3c4d5e6f",
        offset: -1,
      }).success,
    ).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "remote_exec.read_job_output.request",
        requestId: "req_11",
        jobId: "rjb_1a2b3c4d5e6f",
        offset: 0,
        limit: 0,
      }).success,
    ).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "remote_exec.read_job_output.request",
        requestId: "req_12",
        jobId: "rjb_1a2b3c4d5e6f",
        offset: 0,
        limit: 262_145,
      }).success,
    ).toBe(false);
  });
});

describe("remote_exec.* responses", () => {
  it("parses list_targets with full target DTOs", () => {
    const message = {
      type: "remote_exec.list_targets.response",
      payload: {
        requestId: "req_1",
        error: null,
        targets: [
          {
            serverId: "srv_1a2b3c4d5e6f",
            label: "build-box",
            address: "build-box.tailnet.ts.net",
            via: "tailnet",
            workRoot: "~/.jagentdesk/remote-exec",
            connectionState: "connected",
            environment: null,
          },
        ],
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses check_target result", () => {
    const message = {
      type: "remote_exec.check_target.response",
      payload: {
        requestId: "req_2",
        error: null,
        result: {
          ok: true,
          os: "Linux 6.8.0 x86_64",
          shell: "/bin/bash",
          missing: [],
          freeKb: 8_388_608,
          writable: true,
          error: null,
        },
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses check_target with a null result on failure", () => {
    const message = {
      type: "remote_exec.check_target.response",
      payload: { requestId: "req_2", error: "connection failed", result: null },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses list_jobs", () => {
    const message = {
      type: "remote_exec.list_jobs.response",
      payload: { requestId: "req_3", error: null, jobs: [jobFixture()] },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses get_job with a job and with null", () => {
    const found = {
      type: "remote_exec.get_job.response",
      payload: { requestId: "req_7", error: null, job: jobFixture() },
    };
    expect(SessionOutboundMessageSchema.parse(found)).toEqual(found);
    const missing = {
      type: "remote_exec.get_job.response",
      payload: { requestId: "req_7", error: null, job: null },
    };
    expect(SessionOutboundMessageSchema.parse(missing)).toEqual(missing);
  });

  it("parses read_job_output chunk fields", () => {
    const message = {
      type: "remote_exec.read_job_output.response",
      payload: {
        requestId: "req_9",
        error: null,
        chunk: "line\n",
        offset: 0,
        nextOffset: 5,
        totalBytes: 512,
        complete: false,
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses stop_job", () => {
    const message = {
      type: "remote_exec.stop_job.response",
      payload: {
        requestId: "req_8",
        error: null,
        job: jobFixture({ status: "stopped", finishedAtMs: 2_000 }),
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects a job with an unknown status", () => {
    const message = {
      type: "remote_exec.get_job.response",
      payload: {
        requestId: "req_7",
        error: null,
        job: jobFixture({ status: "queued" as RemoteJob["status"] }),
      },
    };
    expect(SessionOutboundMessageSchema.safeParse(message).success).toBe(false);
  });

  it("parses a job with noCode and per-source records (ADR-0045)", () => {
    const message = {
      type: "remote_exec.get_job.response",
      payload: {
        requestId: "req_7",
        error: null,
        job: jobFixture({
          noCode: true,
          sources: [
            {
              name: "A",
              path: "/Users/dev/work/A",
              sync: {
                snapshotId: "snp_1a2b3c4d5e6f",
                filesTotal: 10,
                filesUploaded: 2,
                filesDeleted: 0,
                bytesUploaded: 512,
                excludedSecrets: [".env"],
                skipped: [],
              },
            },
          ],
        }),
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

describe("remote_exec.job_updated push", () => {
  it("parses the unsolicited event with the full job", () => {
    const message = {
      type: "remote_exec.job_updated",
      payload: {
        job: jobFixture({
          status: "succeeded",
          exitCode: 0,
          finishedAtMs: 3_000,
          snapshotId: "rsnap_1a2b3c4d5e6f",
        }),
      },
    };
    expect(SessionOutboundMessageSchema.parse(message)).toEqual(message);
  });
});

describe("SshServer via/remoteExec fields (spec 33)", () => {
  const base = {
    type: "ssh.servers.save.request",
    requestId: "req_20",
    server: {
      id: "srv_1a2b3c4d5e6f",
      label: "build-box",
      address: "build-box.tailnet.ts.net",
    },
  };

  it("parses a server without via/remoteExec (old payloads still parse)", () => {
    expect(SessionInboundMessageSchema.parse(base)).toEqual(base);
  });

  it("parses a server with via and remoteExec", () => {
    const message = {
      ...base,
      server: {
        ...base.server,
        via: "tailnet",
        remoteExec: { enabled: true, workRoot: "~/jobs" },
      },
    };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("parses remoteExec without workRoot", () => {
    const message = {
      ...base,
      server: { ...base.server, via: "direct", remoteExec: { enabled: false } },
    };
    expect(SessionInboundMessageSchema.parse(message)).toEqual(message);
  });

  it("rejects an invalid via and an empty workRoot", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        ...base,
        server: { ...base.server, via: "wifi" },
      }).success,
    ).toBe(false);
    expect(
      SessionInboundMessageSchema.safeParse({
        ...base,
        server: { ...base.server, remoteExec: { enabled: true, workRoot: "" } },
      }).success,
    ).toBe(false);
  });

  it("does not accept via/remoteExec on a group (server-only fields)", () => {
    const message = {
      type: "ssh.groups.save.request",
      requestId: "req_21",
      group: {
        id: "grp_1a2b3c4d5e6f",
        label: "farm",
        via: "tailnet",
      },
    };
    const parsed = SessionInboundMessageSchema.parse(message);
    expect("via" in (parsed as { group: Record<string, unknown> }).group).toBe(false);
  });
});
