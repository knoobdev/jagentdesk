import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import type { Client, ClientChannel } from "ssh2";
import { SshConnectionError } from "../ssh/ssh-connection.js";
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
  /** Fake ssh client handed out by acquireClient; without one, acquire throws. */
  client?: Client;
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
      if (!options.client) throw new Error("acquire not expected in this test");
      return { client: options.client, release: () => undefined };
    },
    connectionState: () => "connected",
    environment: () => null,
    logger: pino({ level: "silent" }),
    acquired,
  };
}

interface FakeExec {
  command: string;
  completed: boolean;
  start(): void;
  complete(result?: { exitCode?: number; stdout?: string; stderr?: string }): void;
}

/**
 * Exec channels stay parked until started and completed by the test, so a stop can be requested
 * at any phase of the pipeline (sync steps, write-command, launch, follow poll).
 */
function makeFakeClient(): { client: Client; execs: FakeExec[] } {
  const execs: FakeExec[] = [];
  const client = {
    exec(command: string, callback: (error: Error | null, stream: ClientChannel) => void) {
      let stream: ClientChannel | null = null;
      const entry: FakeExec = {
        command,
        completed: false,
        start() {
          stream = new EventEmitter() as ClientChannel;
          Object.assign(stream, {
            stderr: new EventEmitter(),
            // A real Writable: the extract channel's stdin is piped into and must emit 'finish'.
            stdin: new Writable({ write: (_chunk, _enc, cb) => cb() }),
            write: () => true,
            end: () => undefined,
            close: () => undefined,
          });
          callback(null, stream);
        },
        complete(result = {}) {
          if (!stream) throw new Error(`exec not started: ${command}`);
          entry.completed = true;
          // Defer the emissions: a same-tick listener attach (openExecChannel resolves, then
          // uploadEntries attaches 'close' in its continuation) must win over the completion,
          // exactly like the real channel where events arrive after the callback returns.
          queueMicrotask(() => {
            if (!stream) return;
            if (result.stdout !== undefined) stream.emit("data", Buffer.from(result.stdout));
            if (result.stderr !== undefined) stream.stderr.emit("data", Buffer.from(result.stderr));
            stream.emit("exit", result.exitCode ?? 0);
            stream.emit("close");
          });
        },
      };
      execs.push(entry);
    },
  } as unknown as Client;
  return { client, execs };
}

function nextExec(execs: FakeExec[], fragment: string): FakeExec {
  const entry = execs.find(
    (candidate) => !candidate.completed && candidate.command.includes(fragment),
  );
  if (!entry) {
    throw new Error(
      `no pending exec matching ${fragment}; have: ${execs.map((e) => e.command).join(" | ")}`,
    );
  }
  return entry;
}

function completeExec(
  execs: FakeExec[],
  fragment: string,
  result?: { exitCode?: number; stdout?: string; stderr?: string },
): void {
  const entry = nextExec(execs, fragment);
  entry.start();
  entry.complete(result);
}

async function waitUntil(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met before the timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function execed(execs: FakeExec[], fragment: string): boolean {
  return execs.some((entry) => entry.command.includes(fragment));
}

function execCount(execs: FakeExec[], fragment: string): number {
  return execs.filter((entry) => entry.command.includes(fragment)).length;
}

async function initGitWorkspace(): Promise<void> {
  execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
  await fs.writeFile(path.join(workspace, "tracked.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "init"],
    { cwd: workspace, stdio: "ignore" },
  );
}

function startInput() {
  return {
    serverId: "srv1",
    workspacePath: workspace,
    command: "echo hi",
    timeoutMs: 60_000,
    agentId: null,
  } as const;
}

/** Drives the sync steps until an exec matching `untilFragment` exists (usually still parked). */
async function syncThrough(execs: FakeExec[], untilFragment: string): Promise<void> {
  await waitUntil(() => execs.length >= 1); // the runner is parked on the first sync step
  completeExec(execs, "mkdir -p", { exitCode: 0 });
  await waitUntil(() => execs.length >= 2);
  completeExec(execs, "2>/dev/null", { exitCode: 1 }); // no manifest on the target yet
  await waitUntil(() => execed(execs, "tar -xzf"));
  completeExec(execs, "tar -xzf", { exitCode: 0 });
  await waitUntil(() => execed(execs, ".tmp && mv"));
  completeExec(execs, ".tmp && mv", { exitCode: 0 });
  await waitUntil(() => execed(execs, untilFragment));
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

  it("preserves tailnet_unavailable with its message from checkTarget", async () => {
    const deps = makeDeps({
      acquireError: new SshConnectionError({
        code: "tailnet_unavailable",
        message: "JAgentDesk Tailscale is not connected on this host.",
      }),
    });
    const service = createRemoteExecService(deps);
    const result = await service.checkTarget("srv1");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("tailnet_unavailable");
    expect(result.error?.message).toBe("JAgentDesk Tailscale is not connected on this host.");
  });

  it("keeps the generic connection code for other SshConnectionError codes", async () => {
    const deps = makeDeps({
      acquireError: new SshConnectionError({ code: "auth_failed", message: "bad credentials" }),
    });
    const service = createRemoteExecService(deps);
    const result = await service.checkTarget("srv1");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("connection_failed");
    expect(result.error?.message).toBe("bad credentials");
  });

  it("maps tailnet_unavailable into the failed job's error", async () => {
    execFileSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
    const deps = makeDeps({
      acquireError: new SshConnectionError({
        code: "tailnet_unavailable",
        message: "JAgentDesk Tailscale is not connected on this host.",
      }),
    });
    const service = createRemoteExecService(deps);
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "true",
      timeoutMs: 60_000,
      agentId: null,
    });
    const result = await service.waitForJob(job.id, 5_000);
    expect(result.job.status).toBe("failed");
    expect(result.job.error?.code).toBe("tailnet_unavailable");
    expect(result.job.error?.message).toBe("JAgentDesk Tailscale is not connected on this host.");
    await service.stop();
  });

  it("surfaces tailnet_unavailable in follower reconnect logs", async () => {
    await seedStore(homeDir, [makeStoredJob("rjb_running", { startedAtMs: Date.now() })]);
    const records: Array<Record<string, unknown>> = [];
    const deps = makeDeps({
      acquireError: new SshConnectionError({
        code: "tailnet_unavailable",
        message: "JAgentDesk Tailscale is not connected on this host.",
      }),
    });
    deps.logger = pino(
      { level: "debug" },
      {
        write(chunk: string) {
          records.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      },
    );
    const service = createRemoteExecService(deps);
    await service.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.stop();
    const pollFailure = records.find(
      (record) => record.msg === "remote-exec: poll failed, backing off",
    );
    expect(pollFailure).toBeDefined();
    expect(pollFailure?.code).toBe("tailnet_unavailable");
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
    // The agent only sees the text: the active job's id must be in it, with the next actions.
    expect((error as RemoteExecError).message).toContain("(rjb_active)");
    expect((error as RemoteExecError).message).toContain("remote_job_wait");
    expect((error as RemoteExecError).message).toContain("remote_job_stop");
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

  it("stop while parked on the first sync step settles stopped without further remote steps", async () => {
    await initGitWorkspace();
    const { client, execs } = makeFakeClient();
    const service = createRemoteExecService(makeDeps({ client }));
    const job = await service.startJob(startInput());
    await waitUntil(() => execs.length === 1);
    const stopping = service.stopJob(job.id);
    completeExec(execs, "mkdir -p", { exitCode: 0 });
    const stopped = await stopping;
    expect(stopped.status).toBe("stopped");
    expect(stopped.startedAtMs).toBeNull();
    expect(execs).toHaveLength(1);
    await service.stop();
  });

  it("stop during the upload aborts the sync before any later step", async () => {
    await initGitWorkspace();
    const { client, execs } = makeFakeClient();
    const service = createRemoteExecService(makeDeps({ client }));
    const job = await service.startJob(startInput());
    await waitUntil(() => execs.length >= 1);
    completeExec(execs, "mkdir -p", { exitCode: 0 });
    await waitUntil(() => execs.length >= 2);
    completeExec(execs, "2>/dev/null", { exitCode: 1 }); // no manifest on the target yet
    await waitUntil(() => execed(execs, "tar -xzf"));
    const stopping = service.stopJob(job.id);
    completeExec(execs, "tar -xzf", { exitCode: 0 }); // the extract channel finishes
    const stopped = await stopping;
    expect(stopped.status).toBe("stopped");
    expect(stopped.startedAtMs).toBeNull();
    expect(execed(execs, ".tmp && mv")).toBe(false);
    expect(execed(execs, "setsid")).toBe(false);
    await service.stop();
  });

  it("stop between write-command and launch never launches the job", async () => {
    await initGitWorkspace();
    const { client, execs } = makeFakeClient();
    const service = createRemoteExecService(makeDeps({ client }));
    const job = await service.startJob(startInput());
    await syncThrough(execs, "&& cat >");
    const stopping = service.stopJob(job.id);
    completeExec(execs, "&& cat >", { exitCode: 0 });
    const stopped = await stopping;
    expect(stopped.status).toBe("stopped");
    expect(stopped.startedAtMs).toBeNull();
    expect(execed(execs, "setsid")).toBe(false);
    await service.stop();
  });

  it("stop during the launch runs the stop procedure on the pid the launch recorded", async () => {
    await initGitWorkspace();
    const { client, execs } = makeFakeClient();
    const service = createRemoteExecService(makeDeps({ client }));
    const job = await service.startJob(startInput());
    await syncThrough(execs, "&& cat >");
    completeExec(execs, "&& cat >", { exitCode: 0 });
    await waitUntil(() => execed(execs, "setsid"));
    const stopping = service.stopJob(job.id);
    completeExec(execs, "setsid", { exitCode: 0 }); // the launch completes and records a pid
    await waitUntil(() => execed(execs, "kill -TERM"));
    completeExec(execs, "kill -TERM", { exitCode: 0 });
    await waitUntil(() => execed(execs, "tail -c"));
    completeExec(execs, "tail -c", { exitCode: 0 }); // the stop procedure's final read
    const stopped = await stopping;
    expect(stopped.status).toBe("stopped");
    expect(stopped.startedAtMs).toBeNull();
    await service.stop();
  });

  it("stop while following settles stopped through the follow loop", async () => {
    await initGitWorkspace();
    const { client, execs } = makeFakeClient();
    const service = createRemoteExecService(makeDeps({ client }));
    const job = await service.startJob(startInput());
    await syncThrough(execs, "&& cat >");
    completeExec(execs, "&& cat >", { exitCode: 0 });
    await waitUntil(() => execed(execs, "setsid"));
    completeExec(execs, "setsid", { exitCode: 0 });
    // The runner marks the job running and the follow loop starts polling.
    await waitUntil(() => execed(execs, "tail -c"));
    expect(service.getJob(job.id)?.status).toBe("running");
    const stopping = service.stopJob(job.id);
    completeExec(execs, "tail -c", { exitCode: 0 }); // finish the in-flight poll
    await waitUntil(() => execed(execs, "kill -TERM"));
    completeExec(execs, "kill -TERM", { exitCode: 0 });
    await waitUntil(() => execCount(execs, "tail -c") >= 2);
    completeExec(execs, "tail -c", { exitCode: 0 }); // the stop procedure's final read
    const stopped = await stopping;
    expect(stopped.status).toBe("stopped");
    expect(stopped.startedAtMs).not.toBeNull();
    await service.stop();
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
