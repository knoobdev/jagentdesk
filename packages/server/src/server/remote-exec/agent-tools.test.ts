// agent-tools.test.ts — the six remote_* agent tools against an in-test fake implementing
// RemoteExecService. Proves: availability follows remoteExec.enabled (at listing time and per
// call), remote_run raises the permission card with the snapshot stats and maps a denial to
// exactly "The user declined", serverId is optional only with one enabled target, the caller's
// cwd is the workspacePath, and timeoutMs/waitMs are clamped to the contract limits.
import { describe, expect, it, vi } from "vitest";

import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { JAgentDeskToolResult } from "../agent/tools/types.js";
import {
  createRemoteExecAgentTools,
  type RemoteExecAgentToolDependencies,
  type RemoteExecPermissionRequest,
} from "./agent-tools.js";
import {
  REMOTE_RUN_DEFAULT_TIMEOUT_MS,
  REMOTE_RUN_MAX_TIMEOUT_MS,
  RemoteExecError,
  type RemoteExecService,
  type RemoteJob,
  type RemoteRunResult,
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

const runResult: RemoteRunResult = {
  job,
  output: "all green",
  outputOffset: 0,
  outputTruncatedHead: false,
};

const preview = {
  workspacePath: "/repo",
  workspaceKey: "wsk_0123456789ab",
  filesTotal: 7,
  bytesTotal: 4_096,
  excludedSecrets: [".env"],
  skipped: [],
};

function target(serverId: string, label: string) {
  return {
    serverId,
    label,
    address: `${serverId}.tailnet`,
    via: "tailnet" as const,
    workRoot: "~/.jagentdesk/remote-exec",
    connectionState: "connected",
    environment: null,
  };
}

function createFakeService(overrides: Partial<RemoteExecService> = {}): RemoteExecService {
  return {
    listTargets: vi.fn(async () => [target("srv_a", "build box")]),
    checkTarget: vi.fn(async () => ({
      ok: true,
      os: "linux",
      shell: "/bin/bash",
      missing: [],
      freeKb: 1_000,
      writable: true,
      error: null,
    })),
    previewSnapshot: vi.fn(async () => preview),
    startJob: vi.fn(async () => job),
    waitForJob: vi.fn(async () => runResult),
    readOutput: vi.fn(async () => ({
      chunk: "hello",
      offset: 0,
      nextOffset: 5,
      totalBytes: 5,
      complete: true,
    })),
    stopJob: vi.fn(async () => ({ ...job, status: "stopped" as const })),
    listJobs: vi.fn(() => [job]),
    getJob: vi.fn(() => job),
    onJobUpdated: vi.fn(() => () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    ...overrides,
  };
}

interface Harness {
  deps: RemoteExecAgentToolDependencies;
  service: RemoteExecService;
  asked: RemoteExecPermissionRequest[];
  decisions: AgentPermissionResponse[];
}

function createHarness(
  overrides: {
    service?: Partial<RemoteExecService>;
    hasEnabledTarget?: boolean;
    callerCwd?: string | null;
    callerAgentId?: string | null;
    decisions?: AgentPermissionResponse[];
    deps?: Partial<RemoteExecAgentToolDependencies>;
  } = {},
): Harness {
  const service = createFakeService(overrides.service);
  const asked: RemoteExecPermissionRequest[] = [];
  const decisions = overrides.decisions ?? [{ behavior: "allow" }];
  let decisionIndex = 0;
  const deps: RemoteExecAgentToolDependencies = {
    service,
    hasEnabledTarget: () => overrides.hasEnabledTarget ?? true,
    callerCwd: () => (overrides.callerCwd === undefined ? "/repo" : overrides.callerCwd),
    callerAgentId: overrides.callerAgentId === undefined ? "agt_1" : overrides.callerAgentId,
    requestPermission: async (_agentId, request) => {
      asked.push(request);
      const decision = decisions[Math.min(decisionIndex, decisions.length - 1)];
      decisionIndex += 1;
      return decision;
    },
    ...overrides.deps,
  };
  return { deps, service, asked, decisions };
}

function tool(deps: RemoteExecAgentToolDependencies, name: string) {
  const found = createRemoteExecAgentTools(deps).find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool ${name} not offered`);
  return found;
}

function text(result: JAgentDeskToolResult): string {
  return result.content[0].text ?? "";
}

async function run(deps: RemoteExecAgentToolDependencies, name: string, input?: unknown) {
  return tool(deps, name).handler(input ?? {});
}

describe("createRemoteExecAgentTools", () => {
  it("offers exactly the six spec 33.7 tools while a target is enabled", () => {
    const { deps } = createHarness();
    expect(createRemoteExecAgentTools(deps).map((candidate) => candidate.name)).toEqual([
      "remote_targets",
      "remote_run",
      "remote_job_wait",
      "remote_job_output",
      "remote_job_stop",
      "remote_jobs",
    ]);
  });

  it("offers nothing while no SSH server has remote tasks enabled", () => {
    const { deps } = createHarness({ hasEnabledTarget: false });
    expect(createRemoteExecAgentTools(deps)).toEqual([]);
  });

  it("flags exactly remote_run and remote_job_stop as needing permission", () => {
    const { deps } = createHarness();
    const needs = createRemoteExecAgentTools(deps)
      .filter((candidate) => candidate.requiresPermission)
      .map((candidate) => candidate.name);
    expect(needs).toEqual(["remote_run", "remote_job_stop"]);
  });
});

describe("remote_run", () => {
  it("previews the snapshot, asks with its stats, then starts and waits", async () => {
    const { deps, service, asked } = createHarness();

    const result = await run(deps, "remote_run", { command: "npm test" });

    expect(service.previewSnapshot).toHaveBeenCalledWith({ workspacePath: "/repo" });
    expect(asked).toEqual([
      {
        kind: "tool",
        name: "remote_run",
        title: "Run on build box",
        description: "npm test",
        input: {
          server: "build box",
          command: "npm test",
          cwd: "/repo",
          files: 7,
          bytes: 4_096,
          excludedSecrets: 1,
        },
      },
    ]);
    expect(service.startJob).toHaveBeenCalledWith({
      serverId: "srv_a",
      workspacePath: "/repo",
      command: "npm test",
      timeoutMs: REMOTE_RUN_DEFAULT_TIMEOUT_MS,
      agentId: "agt_1",
    });
    expect(service.waitForJob).toHaveBeenCalledWith(job.id, 120_000);
    expect(JSON.parse(text(result))).toEqual(runResult);
  });

  it("returns the tool error 'The user declined' and starts nothing when denied", async () => {
    const { deps, service } = createHarness({ decisions: [{ behavior: "deny" }] });

    const result = await run(deps, "remote_run", { command: "npm test" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("The user declined");
    expect(service.startJob).not.toHaveBeenCalled();
  });

  it("uses the requested serverId when given", async () => {
    const { deps, service } = createHarness({
      service: { listTargets: vi.fn(async () => [target("srv_a", "a"), target("srv_b", "b")]) },
    });

    await run(deps, "remote_run", { serverId: "srv_b", command: "npm test" });

    expect(service.startJob).toHaveBeenCalledWith(expect.objectContaining({ serverId: "srv_b" }));
  });

  it("errors when several targets are enabled and no serverId is given", async () => {
    const { deps, service } = createHarness({
      service: { listTargets: vi.fn(async () => [target("srv_a", "a"), target("srv_b", "b")]) },
    });

    const result = await run(deps, "remote_run", { command: "npm test" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("Several remote task targets are enabled; pass serverId");
    expect(service.startJob).not.toHaveBeenCalled();
  });

  it("errors on an unknown serverId, listing the enabled targets", async () => {
    const { deps } = createHarness();

    const result = await run(deps, "remote_run", { serverId: "srv_zzz", command: "npm test" });

    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No remote task target srv_zzz");
    expect(text(result)).toContain("srv_a (build box)");
  });

  it("errors when no target is enabled", async () => {
    const { deps } = createHarness({
      service: { listTargets: vi.fn(async () => []) },
    });

    const result = await run(deps, "remote_run", { command: "npm test" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("No SSH server has remote tasks enabled.");
  });

  it("propagates startJob's RemoteExecError as '<code>: <message>'", async () => {
    const { deps } = createHarness({
      service: {
        startJob: vi.fn(async () => {
          throw new RemoteExecError("job_running", "already running (rjb_1)");
        }),
      },
    });

    const result = await run(deps, "remote_run", { command: "npm test" });

    expect(text(result)).toBe("job_running: already running (rjb_1)");
  });

  it("errors when the calling agent has no working directory", async () => {
    const { deps, service } = createHarness({ callerCwd: null });

    const result = await run(deps, "remote_run", { command: "npm test" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("This tool needs a workspace: the agent has no working directory.");
    expect(service.previewSnapshot).not.toHaveBeenCalled();
  });

  it("errors when only available to agent-scoped tool sessions", async () => {
    const { deps, service } = createHarness({ callerAgentId: null });

    const result = await run(deps, "remote_run", { command: "npm test" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("remote_run is only available to agent-scoped tool sessions.");
    expect(service.startJob).not.toHaveBeenCalled();
  });

  it("clamps timeoutMs and waitMs to the contract limits and defaults", async () => {
    const { deps, service } = createHarness();

    await run(deps, "remote_run", {
      command: "npm test",
      timeoutMs: 99_999_999,
      waitMs: 99_999_999,
    });
    expect(service.startJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: REMOTE_RUN_MAX_TIMEOUT_MS }),
    );
    expect(service.waitForJob).toHaveBeenLastCalledWith(job.id, 1_800_000);

    await run(deps, "remote_run", { command: "npm test", timeoutMs: 500, waitMs: 5 });
    expect(service.startJob).toHaveBeenLastCalledWith(expect.objectContaining({ timeoutMs: 500 }));
    expect(service.waitForJob).toHaveBeenLastCalledWith(job.id, 5);

    await run(deps, "remote_run", { command: "npm test" });
    expect(service.startJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeoutMs: REMOTE_RUN_DEFAULT_TIMEOUT_MS }),
    );
    expect(service.waitForJob).toHaveBeenLastCalledWith(job.id, 120_000);
  });

  it("re-checks availability per call even if it lapsed after listing", async () => {
    let enabled = true;
    const { deps } = createHarness({ deps: { hasEnabledTarget: () => enabled } });
    const handler = tool(deps, "remote_run").handler;
    enabled = false;

    const result = await handler({ command: "npm test" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("No SSH server has remote tasks enabled.");
  });

  it("passes source through and lists the sources on the permission card", async () => {
    const { deps, service, asked } = createHarness({
      service: {
        previewSnapshot: vi.fn(async () => ({
          ...preview,
          filesTotal: 3,
          excludedSecrets: ["A/.env"],
          sources: [
            { name: "A", files: 2, bytes: 3_000, excludedSecrets: 1 },
            { name: "C", files: 1, bytes: 1_096, excludedSecrets: 0 },
          ],
        })),
      },
    });

    await run(deps, "remote_run", { command: "npm test", source: ["A", "C"] });

    expect(service.previewSnapshot).toHaveBeenCalledWith({
      workspacePath: "/repo",
      source: ["A", "C"],
    });
    expect(asked[0].input).toMatchObject({
      files: 3,
      excludedSecrets: 1,
      sources: [
        { name: "A", files: 2, bytes: 3_000, excludedSecrets: 1 },
        { name: "C", files: 1, bytes: 1_096, excludedSecrets: 0 },
      ],
    });
    expect(service.startJob).toHaveBeenCalledWith(expect.objectContaining({ source: ["A", "C"] }));
  });

  it('shows code:"none" on the card and sends noCode for sendCode: false', async () => {
    const { deps, service, asked } = createHarness({
      service: {
        previewSnapshot: vi.fn(async () => ({ ...preview, filesTotal: 0, noCode: true })),
      },
    });

    await run(deps, "remote_run", { command: "uname -a", sendCode: false });

    expect(service.previewSnapshot).toHaveBeenCalledWith({
      workspacePath: "/repo",
      noCode: true,
    });
    expect(asked[0].input).toEqual({
      server: "build box",
      command: "uname -a",
      cwd: "/repo",
      code: "none",
    });
    expect(asked[0].input.files).toBeUndefined();
    expect(service.startJob).toHaveBeenCalledWith(expect.objectContaining({ noCode: true }));
  });

  it("returns source errors before asking permission and starts no job", async () => {
    const { deps, service, asked } = createHarness({
      service: {
        previewSnapshot: vi.fn(async () => {
          throw new RemoteExecError("source_outside_workspace", "outside");
        }),
      },
    });

    const result = await run(deps, "remote_run", { command: "npm test", source: "../outside" });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("source_outside_workspace: outside");
    expect(asked).toEqual([]);
    expect(service.startJob).not.toHaveBeenCalled();
  });
});

describe("remote_job_stop", () => {
  it("asks for approval and stops when allowed", async () => {
    const { deps, service, asked } = createHarness();

    const result = await run(deps, "remote_job_stop", { jobId: job.id });

    expect(asked).toEqual([
      {
        kind: "tool",
        name: "remote_job_stop",
        title: `Stop remote job ${job.id}`,
        description: job.id,
        input: { jobId: job.id },
      },
    ]);
    expect(service.stopJob).toHaveBeenCalledWith(job.id);
    expect(JSON.parse(text(result))).toEqual({ ...job, status: "stopped" });
  });

  it("maps a denial to exactly 'The user declined'", async () => {
    const { deps, service } = createHarness({ decisions: [{ behavior: "deny" }] });

    const result = await run(deps, "remote_job_stop", { jobId: job.id });

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("The user declined");
    expect(service.stopJob).not.toHaveBeenCalled();
  });
});

describe("read-only tools", () => {
  it("remote_targets lists the enabled targets without asking permission", async () => {
    const { deps, asked } = createHarness();

    const result = await run(deps, "remote_targets");

    expect(asked).toEqual([]);
    expect(JSON.parse(text(result))).toEqual({
      targets: [target("srv_a", "build box")],
    });
  });

  it("remote_job_wait waits on the given job", async () => {
    const { deps, service, asked } = createHarness();

    const result = await run(deps, "remote_job_wait", { jobId: job.id, waitMs: 30_000 });

    expect(asked).toEqual([]);
    expect(service.waitForJob).toHaveBeenCalledWith(job.id, 30_000);
    expect(JSON.parse(text(result))).toEqual(runResult);
  });

  it("remote_job_output reads a byte range", async () => {
    const { deps, service } = createHarness();

    const result = await run(deps, "remote_job_output", { jobId: job.id, offset: 10, limit: 20 });

    expect(service.readOutput).toHaveBeenCalledWith(job.id, 10, 20);
    expect(JSON.parse(text(result))).toEqual({
      chunk: "hello",
      offset: 0,
      nextOffset: 5,
      totalBytes: 5,
      complete: true,
    });
  });

  it("remote_jobs lists the caller workspace's recent jobs", async () => {
    const { deps, service } = createHarness();

    const result = await run(deps, "remote_jobs");

    expect(service.listJobs).toHaveBeenCalledWith({ workspacePath: "/repo", limit: 20 });
    expect(JSON.parse(text(result))).toEqual({ jobs: [job] });
  });
});
