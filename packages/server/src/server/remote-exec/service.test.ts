import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { computeWorkspaceKey } from "./ids.js";
import { createRemoteExecService } from "./service.js";
import {
  RemoteExecError,
  type RemoteExecDeps,
  type RemoteExecServerConfig,
  type RemoteJob,
} from "./types.js";

let homeDir: string;
let workspace: string;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-svc-"));
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-ws-"));
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  await fs.rm(workspace, { recursive: true, force: true });
});

interface FakeDepsOptions {
  servers?: RemoteExecServerConfig[];
  acquireError?: Error;
}

function makeDeps(options: FakeDepsOptions = {}): RemoteExecDeps & { acquired: string[] } {
  const servers = options.servers ?? [
    {
      id: "srv1",
      label: "Target",
      address: "10.0.0.1",
      remoteExec: { enabled: true, workRoot: "~/.jad-remote-exec-test" },
    },
    { id: "srv2", label: "No remote tasks", address: "10.0.0.2" },
  ];
  const acquired: string[] = [];
  return {
    homeDir,
    daemonId: "daemon-test",
    async getServer(serverId: string) {
      return servers.find((server) => server.id === serverId) ?? null;
    },
    async listServers() {
      return servers;
    },
    async acquireClient(serverId: string) {
      acquired.push(serverId);
      if (options.acquireError) throw options.acquireError;
      throw new Error("acquire not expected in this test");
    },
    connectionState: () => "connected",
    environment: () => null,
    logger: pino({ level: "silent" }),
    acquired,
  };
}

async function seedStore(home: string, jobs: RemoteJob[]): Promise<void> {
  const filePath = path.join(home, "remote-exec", "jobs.json");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ version: 1, jobs }));
}

function makeStoredJob(id: string, overrides?: Partial<RemoteJob>): RemoteJob {
  return {
    id,
    serverId: "srv1",
    serverLabel: "Target",
    workspacePath: workspace,
    workspaceKey: computeWorkspaceKey("daemon-test", workspace),
    snapshotId: null,
    command: "true",
    status: "running",
    exitCode: null,
    error: null,
    agentId: null,
    sync: null,
    outputBytes: 0,
    outputTruncated: false,
    createdAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: null,
    timeoutMs: 60_000,
    ...overrides,
  };
}

describe("createRemoteExecService", () => {
  it("lists only servers with remote tasks enabled", async () => {
    const deps = makeDeps();
    const service = createRemoteExecService(deps);
    const targets = await service.listTargets();
    expect(targets.map((target) => target.serverId)).toEqual(["srv1"]);
    expect(targets[0]).toMatchObject({
      label: "Target",
      via: "direct",
      workRoot: "~/.jad-remote-exec-test",
      connectionState: "connected",
    });
  });

  it("throws target_not_found and target_disabled from checkTarget", async () => {
    const service = createRemoteExecService(makeDeps());
    await expect(service.checkTarget("missing")).rejects.toMatchObject({
      code: "target_not_found",
    });
    await expect(service.checkTarget("srv2")).rejects.toMatchObject({ code: "target_disabled" });
  });

  it("reports a reachable but failing server without throwing from checkTarget", async () => {
    const deps = makeDeps({
      acquireError: Object.assign(new Error("no route"), { code: "ECONNREFUSED" }),
    });
    const service = createRemoteExecService(deps);
    const result = await service.checkTarget("srv1");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("ECONNREFUSED");
  });

  it("fails startJob with not_git_workspace for a plain directory", async () => {
    const service = createRemoteExecService(makeDeps());
    await expect(
      service.startJob({
        serverId: "srv1",
        workspacePath: workspace,
        command: "true",
        timeoutMs: 60_000,
        agentId: null,
      }),
    ).rejects.toMatchObject({ code: "not_git_workspace" });
  });

  it("enforces the one-running-job rule with the active jobId in the details", async () => {
    await seedStore(homeDir, [makeStoredJob("rjb_active")]);
    const service = createRemoteExecService(makeDeps());
    const error = await service
      .startJob({
        serverId: "srv1",
        workspacePath: workspace,
        command: "true",
        timeoutMs: 60_000,
        agentId: null,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteExecError);
    expect((error as RemoteExecError).code).toBe("job_running");
    expect((error as RemoteExecError).details).toEqual({ jobId: "rjb_active" });
  });

  it("marks syncing jobs failed(daemon_restarted) on start and resumes following running ones", async () => {
    await seedStore(homeDir, [
      makeStoredJob("rjb_syncing", { status: "syncing", startedAtMs: null }),
      makeStoredJob("rjb_running"),
    ]);
    const deps = makeDeps({ acquireError: new Error("target offline") });
    const service = createRemoteExecService(deps);
    await service.start();
    expect(service.getJob("rjb_syncing")?.status).toBe("failed");
    expect(service.getJob("rjb_syncing")?.error?.code).toBe("daemon_restarted");
    expect(service.getJob("rjb_running")?.status).toBe("running");
    // The resumed follower keeps trying the target in the background.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deps.acquired.filter((serverId) => serverId === "srv1").length).toBeGreaterThan(0);
    await service.stop();
  });

  it("emits status changes to onJobUpdated listeners", async () => {
    await seedStore(homeDir, [
      makeStoredJob("rjb_syncing", { status: "syncing", startedAtMs: null }),
    ]);
    const service = createRemoteExecService(makeDeps());
    const events: RemoteJob[] = [];
    service.onJobUpdated((job) => events.push(job));
    await service.start();
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.id).toBe("rjb_syncing");
    expect(events.at(-1)?.status).toBe("failed");
    await service.stop();
  });

  it("throws job_not_found from waitForJob, readOutput and stopJob", async () => {
    const service = createRemoteExecService(makeDeps());
    await expect(service.waitForJob("rjb_x", 10)).rejects.toMatchObject({ code: "job_not_found" });
    await expect(service.readOutput("rjb_x", 0, 10)).rejects.toMatchObject({
      code: "job_not_found",
    });
    await expect(service.stopJob("rjb_x")).rejects.toMatchObject({ code: "job_not_found" });
  });

  it("lists jobs filtered by workspace path with a limit, newest first", async () => {
    await seedStore(homeDir, [
      makeStoredJob("rjb_1", { createdAtMs: 1, status: "succeeded" }),
      makeStoredJob("rjb_2", { createdAtMs: 2, workspacePath: "/other", status: "succeeded" }),
      makeStoredJob("rjb_3", { createdAtMs: 3, status: "succeeded" }),
    ]);
    const service = createRemoteExecService(makeDeps());
    await service.start();
    expect(service.listJobs({ workspacePath: workspace }).map((job) => job.id)).toEqual([
      "rjb_3",
      "rjb_1",
    ]);
    expect(service.listJobs({ limit: 1 }).map((job) => job.id)).toEqual(["rjb_3"]);
    await service.stop();
  });
});
