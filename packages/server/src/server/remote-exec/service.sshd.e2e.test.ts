import { execFileSync, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ssh2 from "ssh2";
import type { Client } from "ssh2";
import pino from "pino";
import { createRemoteExecService } from "./service.js";
import { RemoteExecError } from "./types.js";
import type { RemoteExecDeps, RemoteExecServerConfig } from "./types.js";

// End-to-end against a real sshd (spec 33). Run with JAD_REMOTE_EXEC_E2E=1. A throwaway
// OpenSSH container is started (same image the ssh e2e harness uses); docker must be available.

const { Client: Ssh2Client } = ssh2;

const E2E_ENABLED = process.env.JAD_REMOTE_EXEC_E2E === "1";
const IMAGE = "lscr.io/linuxserver/openssh-server:latest";
const WORK_ROOT = "~/jad-remote-exec-e2e";

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

function connect(config: {
  host: string;
  port: number;
  username: string;
  password: string;
}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Ssh2Client();
    let settled = false;
    // Persistent listener: ssh2 can emit a second error (e.g. "Connection lost before
    // handshake") on an abandoned client, which crashes the process with no listeners left.
    client.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    client.once("ready", () => {
      settled = true;
      resolve(client);
    });
    client.connect({ ...config, readyTimeout: 10_000, hostVerifier: () => true });
  });
}

/** One raw exec, deliberately bypassing the service's /bin/sh wrapper (to probe the login shell). */
function rawExec(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let out = "";
      stream.on("data", (chunk: Buffer) => {
        out += chunk.toString("utf8");
      });
      stream.on("error", reject);
      stream.on("close", () => resolve(out));
    });
  });
}

describe.runIf(E2E_ENABLED)("remote-exec service against a real sshd", () => {
  let containerName: string | null = null;
  let port = 0;
  let homeDir: string;
  let workspace: string;
  /** Non-git cwd with git repos A and B, plain dir C and a root .env (spec 33.10#13). */
  let sourcesWorkspace: string;
  let clients: Client[] = [];
  let current: Promise<Client> | null = null;
  let service: ReturnType<typeof createRemoteExecService>;
  const daemonId = "e2e-daemon";

  async function acquireClient(): Promise<{ client: Client; release: () => void }> {
    current ??= connect({ host: "127.0.0.1", port, username: "jad", password: "jadtest" }).then(
      (client) => {
        clients.push(client);
        return client;
      },
    );
    const client = await current;
    return { client, release: () => undefined };
  }

  function disconnect(): void {
    const client = current;
    current = null;
    void client?.then((c) => c.end()).catch(() => undefined);
  }

  beforeAll(async () => {
    if (!dockerAvailable()) {
      throw new Error("docker is not available; the sshd e2e cannot run");
    }
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-e2e-home-"));
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-e2e-ws-"));
    sourcesWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-e2e-srcws-"));
    const git = (args: string[], cwd: string = workspace) =>
      execFileSync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=E2E", ...args], {
        cwd,
        stdio: "ignore",
      });
    git(["init", "-q"]);
    await fs.writeFile(path.join(workspace, "tracked.txt"), "original tracked\n");
    git(["add", "."]);
    git(["commit", "-qm", "init"]);

    // sourcesWorkspace: repo A (.gitignore'd build/, .env), repo B, plain C (node_modules,
    // notes.txt), root .env (spec 33.10#13).
    for (const name of ["A", "B", "C"]) {
      await fs.mkdir(path.join(sourcesWorkspace, name));
    }
    await fs.writeFile(path.join(sourcesWorkspace, ".env"), "ROOT_SECRET=yes\n");
    await fs.writeFile(path.join(sourcesWorkspace, "A", ".gitignore"), "build/\n");
    await fs.writeFile(path.join(sourcesWorkspace, "A", "code.ts"), "export a;\n");
    await fs.mkdir(path.join(sourcesWorkspace, "A", "build"));
    await fs.writeFile(path.join(sourcesWorkspace, "A", "build", "x.js"), "ignored\n");
    await fs.writeFile(path.join(sourcesWorkspace, "A", ".env"), "A_SECRET=yes\n");
    git(["init", "-q"], path.join(sourcesWorkspace, "A"));
    git(["add", "."], path.join(sourcesWorkspace, "A"));
    git(["commit", "-qm", "init"], path.join(sourcesWorkspace, "A"));
    await fs.writeFile(path.join(sourcesWorkspace, "B", "b.ts"), "export b;\n");
    git(["init", "-q"], path.join(sourcesWorkspace, "B"));
    git(["add", "."], path.join(sourcesWorkspace, "B"));
    git(["commit", "-qm", "init"], path.join(sourcesWorkspace, "B"));
    await fs.mkdir(path.join(sourcesWorkspace, "C", "node_modules"), { recursive: true });
    await fs.writeFile(path.join(sourcesWorkspace, "C", "node_modules", "m.js"), "dep\n");
    await fs.writeFile(path.join(sourcesWorkspace, "C", "notes.txt"), "plain\n");

    port = 20000 + Math.floor(Math.random() * 20000);
    containerName = `jad-remote-exec-e2e-${Date.now()}`;
    const run = spawnSync(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "-p",
        `${port}:2222`,
        "-e",
        "PASSWORD_ACCESS=true",
        "-e",
        "USER_NAME=jad",
        "-e",
        "USER_PASSWORD=jadtest",
        IMAGE,
      ],
      { encoding: "utf8", timeout: 300_000 },
    );
    if (run.status !== 0) {
      throw new Error(`failed to start sshd container: ${run.stderr}`);
    }
    const deps: RemoteExecDeps = {
      homeDir,
      daemonId,
      async getServer(serverId: string): Promise<RemoteExecServerConfig | null> {
        return serverId === "srv1"
          ? {
              id: "srv1",
              label: "E2E sshd",
              address: "127.0.0.1",
              remoteExec: { enabled: true, workRoot: WORK_ROOT },
            }
          : null;
      },
      async listServers() {
        return [
          {
            id: "srv1",
            label: "E2E sshd",
            address: "127.0.0.1",
            remoteExec: { enabled: true, workRoot: WORK_ROOT },
          },
        ];
      },
      acquireClient: () => acquireClient(),
      connectionState: () => "connected",
      environment: () => null,
      logger: pino({ level: "silent" }),
    };
    service = createRemoteExecService(deps);

    // Wait for sshd to accept logins (first run may pull the image).
    const deadline = Date.now() + 180_000;
    let lastError: unknown = null;
    while (Date.now() < deadline) {
      try {
        const client = await connect({
          host: "127.0.0.1",
          port,
          username: "jad",
          password: "jadtest",
        });
        client.end();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    throw new Error(`sshd never became ready: ${String(lastError)}`);
  }, 300_000);

  afterAll(async () => {
    await service?.stop();
    disconnect();
    for (const client of clients) client.end();
    if (containerName) {
      spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore", timeout: 60_000 });
    }
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("checks the target over one exec channel", async () => {
    const result = await service.checkTarget("srv1");
    expect(result.error).toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.writable).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.os).toContain("Linux");
    expect(result.shell).toBeTruthy();
    expect(result.freeKb).toBeGreaterThan(0);
  }, 120_000);

  it("previews the snapshot without uploading", async () => {
    await fs.writeFile(path.join(workspace, ".env"), "E2E_SECRET=yes\n");
    const preview = await service.previewSnapshot({ workspacePath: workspace });
    expect(preview.filesTotal).toBeGreaterThanOrEqual(1);
    expect(preview.bytesTotal).toBeGreaterThan(0);
    expect(preview.excludedSecrets).toContain(".env");
    expect(preview.workspaceKey).toMatch(/^wsk_[0-9a-f]{12}$/);
  }, 120_000);

  it("syncs the first snapshot and runs uname -s && pwd in src", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "uname -s && pwd",
      timeoutMs: 120_000,
      agentId: null,
    });
    expect(job.status).toBe("syncing");
    const result = await service.waitForJob(job.id, 120_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.exitCode).toBe(0);
    expect(result.output).toContain("Linux");
    expect(result.output.trimEnd().endsWith(`/${result.job.workspaceKey}/src`)).toBe(true);
    expect(result.job.sync?.filesTotal).toBeGreaterThanOrEqual(1);
    expect(result.job.snapshotId).toMatch(/^snp_[0-9a-f]{12}$/);
  }, 180_000);

  it("uploads nothing when nothing changed", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "true",
      timeoutMs: 120_000,
      agentId: null,
    });
    const result = await service.waitForJob(job.id, 120_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.sync?.filesUploaded).toBe(0);
    expect(result.job.sync?.bytesUploaded).toBe(0);
  }, 180_000);

  it("uploads changes, excludes .env, and deletes removed files on the next sync", async () => {
    await fs.writeFile(path.join(workspace, "tracked.txt"), "modified tracked\n");
    await fs.writeFile(path.join(workspace, "newfile.txt"), "brand new\n");
    const writeJob = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "cat tracked.txt newfile.txt && test ! -e .env",
      timeoutMs: 120_000,
      agentId: null,
    });
    const writeResult = await service.waitForJob(writeJob.id, 120_000);
    expect(writeResult.job.status).toBe("succeeded");
    expect(writeResult.job.exitCode).toBe(0);
    expect(writeResult.output).toBe("modified tracked\nbrand new\n");
    expect(writeResult.job.sync?.excludedSecrets).toContain(".env");
    expect(writeResult.job.sync?.filesUploaded).toBeGreaterThanOrEqual(2);

    await fs.rm(path.join(workspace, "newfile.txt"));
    const deleteJob = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "test ! -e newfile.txt",
      timeoutMs: 120_000,
      agentId: null,
    });
    const deleteResult = await service.waitForJob(deleteJob.id, 120_000);
    expect(deleteResult.job.status).toBe("succeeded");
    expect(deleteResult.job.sync?.filesDeleted).toBeGreaterThanOrEqual(1);
  }, 240_000);

  it("keeps node_modules between syncs", async () => {
    const markerJob = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "mkdir -p node_modules && echo keep > node_modules/.keep-marker",
      timeoutMs: 120_000,
      agentId: null,
    });
    await service.waitForJob(markerJob.id, 120_000);
    await fs.writeFile(path.join(workspace, "tracked.txt"), "changed again\n");
    const syncJob = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "test -f node_modules/.keep-marker && cat tracked.txt",
      timeoutMs: 120_000,
      agentId: null,
    });
    const result = await service.waitForJob(syncJob.id, 120_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.output).toBe("changed again\n");
  }, 240_000);

  it("keeps exactly the produced output across a forced disconnect", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "for i in $(seq 1 10); do echo line-$i; sleep 0.5; done",
      timeoutMs: 120_000,
      agentId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    disconnect();
    const result = await service.waitForJob(job.id, 120_000);
    expect(result.job.status).toBe("succeeded");
    const expected = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join("\n");
    expect(result.output.trimEnd()).toBe(expected);
  }, 240_000);

  it("rejects a second run while a job is active with job_running", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "sleep 3",
      timeoutMs: 120_000,
      agentId: null,
    });
    try {
      const error = await service
        .startJob({
          serverId: "srv1",
          workspacePath: workspace,
          command: "true",
          timeoutMs: 120_000,
          agentId: null,
        })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RemoteExecError);
      expect((error as RemoteExecError & { code: string }).code).toBe("job_running");
      expect((error as RemoteExecError & { details?: { jobId?: string } }).details?.jobId).toBe(
        job.id,
      );
    } finally {
      await service.waitForJob(job.id, 60_000);
    }
  }, 180_000);

  it("stops a running job and leaves no process in its group", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "sleep 600",
      timeoutMs: 600_000,
      agentId: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const stopped = await service.stopJob(job.id);
    expect(stopped.status).toBe("stopped");
    const verify = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command:
        `p=$(cat "$HOME/jad-remote-exec-e2e/${job.workspaceKey}/jobs/${job.id}/pid"); ` +
        `if kill -0 -"$p" 2>/dev/null || kill -0 "$p" 2>/dev/null; then exit 1; fi`,
      timeoutMs: 120_000,
      agentId: null,
    });
    const result = await service.waitForJob(verify.id, 120_000);
    expect(result.job.status).toBe("succeeded");
  }, 180_000);

  it("stopping during sync, launch and follow never leaves the job running", async () => {
    // Stop at different pipeline phases: still syncing, mid-launch, just launched, following.
    for (const delayMs of [0, 200, 700, 1200, 2500]) {
      const job = await service.startJob({
        serverId: "srv1",
        workspacePath: workspace,
        command: "echo started-marker; sleep 25",
        timeoutMs: 600_000,
        agentId: null,
      });
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const stopped = await service.stopJob(job.id);
      expect(stopped.status).toBe("stopped");
      // Whatever phase the stop landed in, nothing from the job may still be alive: its pid file
      // either does not exist (never launched) or names a dead process group.
      const verify = await service.startJob({
        serverId: "srv1",
        workspacePath: workspace,
        command:
          `p=$(cat "$HOME/jad-remote-exec-e2e/${job.workspaceKey}/jobs/${job.id}/pid" 2>/dev/null); ` +
          `if [ -n "$p" ] && { kill -0 -"$p" 2>/dev/null || kill -0 "$p" 2>/dev/null; }; then exit 1; fi`,
        timeoutMs: 120_000,
        agentId: null,
      });
      const result = await service.waitForJob(verify.id, 120_000);
      expect(result.job.status).toBe("succeeded");
    }
  }, 300_000);

  it("runs sendCode:false without sending any code", async () => {
    // First run against sourcesWorkspace: only an empty src/ is ensured; no manifest may exist
    // afterwards (one would force the next default run to re-upload everything, spec 33.5).
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: sourcesWorkspace,
      command: `test ! -e ../manifest.json && [ -z "$(ls -A .)" ] && pwd`,
      timeoutMs: 120_000,
      agentId: null,
      noCode: true,
    });
    const result = await service.waitForJob(job.id, 180_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.exitCode).toBe(0);
    expect(result.job.noCode).toBe(true);
    expect(result.job.snapshotId).toBeNull();
    expect(result.job.sync).toBeNull();
    expect(result.job.sources).toBeUndefined();
    expect(result.output.trimEnd().endsWith(`/${result.job.workspaceKey}/src`)).toBe(true);
  }, 180_000);

  it("syncs the non-git sources workspace into the default layout", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: sourcesWorkspace,
      command:
        "test -f A/code.ts && test -f B/b.ts && test -f C/notes.txt && " +
        "test ! -e A/build && test ! -e A/.env && test ! -e C/node_modules && test ! -e .env && " +
        "test -f ../manifest.json && pwd",
      timeoutMs: 120_000,
      agentId: null,
    });
    const result = await service.waitForJob(job.id, 180_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.exitCode).toBe(0);
    expect(result.output.trimEnd().endsWith(`/${result.job.workspaceKey}/src`)).toBe(true);
    expect(result.job.sources).toBeUndefined();
    expect(result.job.sync?.excludedSecrets).toContain(".env");
    expect(result.job.sync?.excludedSecrets).toContain("A/.env");
    // A/.gitignore, A/code.ts, B/b.ts, C/notes.txt (build/, node_modules and secrets excluded).
    expect(result.job.sync?.filesUploaded).toBeGreaterThanOrEqual(4);
    expect(result.job.snapshotId).toMatch(/^snp_[0-9a-f]{12}$/);
  }, 240_000);

  it("uploads nothing on the next default run", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: sourcesWorkspace,
      command: "true",
      timeoutMs: 120_000,
      agentId: null,
    });
    const result = await service.waitForJob(job.id, 180_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.sync?.filesUploaded).toBe(0);
    expect(result.job.sync?.bytesUploaded).toBe(0);
  }, 240_000);

  it("syncs source A into sources/A and runs there", async () => {
    const sourcePath = await fs.realpath(path.join(sourcesWorkspace, "A"));
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: sourcesWorkspace,
      command:
        "test -f code.ts && test ! -e build && test ! -e .env && " +
        "test -f ../../manifests/A.json && pwd",
      timeoutMs: 120_000,
      agentId: null,
      source: "A",
    });
    const result = await service.waitForJob(job.id, 180_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.exitCode).toBe(0);
    expect(result.output.trimEnd().endsWith("/sources/A")).toBe(true);
    expect(result.job.sources).toHaveLength(1);
    expect(result.job.sources?.[0]?.name).toBe("A");
    expect(result.job.sources?.[0]?.path).toBe(sourcePath);
    // Per-source sync paths are relative to the source (spec 33.6); the aggregate prefixes them.
    expect(result.job.sources?.[0]?.sync.excludedSecrets).toEqual([".env"]);
    // .gitignore + code.ts; the gitignored build/ and the secret .env stay behind.
    expect(result.job.sources?.[0]?.sync.filesUploaded).toBeGreaterThanOrEqual(2);
    // One explicit source keeps its own snapshotId (spec 33.4).
    expect(result.job.snapshotId).toBe(result.job.sources?.[0]?.sync.snapshotId);
    expect(result.job.sync?.excludedSecrets).toEqual(["A/.env"]);
  }, 240_000);

  it("uploads nothing when source A runs again", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: sourcesWorkspace,
      command: "true",
      timeoutMs: 120_000,
      agentId: null,
      source: "A",
    });
    const result = await service.waitForJob(job.id, 180_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.sync?.filesUploaded).toBe(0);
    expect(result.job.sync?.bytesUploaded).toBe(0);
    expect(result.job.sources?.[0]?.sync.filesUploaded).toBe(0);
  }, 240_000);

  it("syncs sources A and C side by side and runs in sources/", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: sourcesWorkspace,
      command:
        "test -f A/code.ts && test -f C/notes.txt && test ! -e B && " +
        "test -f ../manifests/A.json && test -f ../manifests/C.json && pwd",
      timeoutMs: 120_000,
      agentId: null,
      source: ["A", "C"],
    });
    const result = await service.waitForJob(job.id, 180_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.exitCode).toBe(0);
    expect(result.output.trimEnd().endsWith("/sources")).toBe(true);
    expect(result.job.sources?.map((source) => source.name)).toEqual(["A", "C"]);
    expect(result.job.sources?.[0]?.sync.excludedSecrets).toEqual([".env"]);
    expect(result.job.sources?.[1]?.sync.filesTotal).toBe(1);
    expect(result.job.sync?.excludedSecrets).toEqual(["A/.env"]);
    // A was already synced by the earlier source-A runs, so only C's notes.txt uploads now.
    expect(result.job.sources?.[0]?.sync.filesUploaded).toBe(0);
    expect(result.job.sources?.[1]?.sync.filesUploaded).toBeGreaterThanOrEqual(1);
    expect(result.job.sync?.filesUploaded).toBe(result.job.sources?.[1]?.sync.filesUploaded);
    // Several sources get the aggregate id, distinct from every per-source id (spec 33.4).
    expect(result.job.snapshotId).toMatch(/^snp_[0-9a-f]{12}$/);
    expect(result.job.snapshotId).not.toBe(result.job.sources?.[0]?.sync.snapshotId);
    expect(result.job.snapshotId).not.toBe(result.job.sources?.[1]?.sync.snapshotId);
  }, 240_000);

  it("uploads nothing when sources A and C run again", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: sourcesWorkspace,
      command: "true",
      timeoutMs: 120_000,
      agentId: null,
      source: ["A", "C"],
    });
    const result = await service.waitForJob(job.id, 180_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.sync?.filesUploaded).toBe(0);
    expect(result.job.sync?.bytesUploaded).toBe(0);
    for (const source of result.job.sources ?? []) {
      expect(source.sync.filesUploaded).toBe(0);
    }
  }, 240_000);

  it("leaves other sources and the default src untouched", async () => {
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: sourcesWorkspace,
      command: "test -f b.ts && test -f ../A/code.ts && test -f ../../src/A/code.ts && pwd",
      timeoutMs: 120_000,
      agentId: null,
      source: "B",
    });
    const result = await service.waitForJob(job.id, 180_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.job.exitCode).toBe(0);
    expect(result.output.trimEnd().endsWith("/sources/B")).toBe(true);
    expect(result.job.sources?.map((source) => source.name)).toEqual(["B"]);
  }, 240_000);

  it("runs the whole pipeline when the target user's login shell is not sh-compatible", async () => {
    // Install zsh and make it the target user's login shell; sshd then runs every exec command
    // through zsh, so only the /bin/sh wrapper keeps the engine's snippets parseable.
    const prepare = spawnSync(
      "docker",
      [
        "exec",
        containerName!,
        "sh",
        "-c",
        "apk add --no-cache zsh >/dev/null && sed -i '/^jad:/s#/bin/bash$#/bin/zsh#' /etc/passwd",
      ],
      { encoding: "utf8", timeout: 300_000 },
    );
    expect(prepare.status).toBe(0);
    const passwd = spawnSync("docker", ["exec", containerName!, "grep", "^jad:", "/etc/passwd"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(passwd.stdout).toContain("/bin/zsh");

    // OpenSSH resolves the login shell per connection, so drop the pooled client: the service's
    // next lease reconnects, and every exec channel from then on runs through zsh.
    disconnect();

    // A fresh raw connection proves the login shell really changed for exec channels.
    const probe = await connect({ host: "127.0.0.1", port, username: "jad", password: "jadtest" });
    try {
      expect(await rawExec(probe, "echo $0")).toContain("zsh");
    } finally {
      probe.end();
    }

    const check = await service.checkTarget("srv1");
    expect(check.ok).toBe(true);
    const job = await service.startJob({
      serverId: "srv1",
      workspacePath: workspace,
      command: "printf 'ran-under-zsh'",
      timeoutMs: 120_000,
      agentId: null,
    });
    const result = await service.waitForJob(job.id, 120_000);
    expect(result.job.status).toBe("succeeded");
    expect(result.output).toContain("ran-under-zsh");
  }, 300_000);
});
