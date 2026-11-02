import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SnippetsOutboundMessageSchema,
  type SnippetsOutboundMessage,
} from "@jagentdesk/protocol/ssh/snippets-schemas";
import { handleSnippetsMessage } from "./rpc.js";
import type { SnippetRunEvent } from "./runner.js";
import { SshSnippetsService } from "./service.js";
import {
  SSHD_E2E_ENABLED,
  SSHD_PASSWORD_CONFIG,
  createTestSshClients,
  type TestSshClients,
} from "./sshd-e2e-fixture.js";

// Multi-server snippet run against a real sshd (spec 25.7, 25.16 #9). The same sshd is
// registered under two server ids, each with its own connection, so the run fans out
// to two servers; a third id points at a closed port.

describe.runIf(SSHD_E2E_ENABLED)("SshSnippetsService against a real sshd", () => {
  let tmp: string;
  let clients: TestSshClients;
  let service: SshSnippetsService;
  const events: SnippetRunEvent[] = [];

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jad-ssh-snippets-e2e-"));
    clients = createTestSshClients({
      srv_one: SSHD_PASSWORD_CONFIG,
      srv_two: SSHD_PASSWORD_CONFIG,
      srv_down: { ...SSHD_PASSWORD_CONFIG, port: 1 },
    });
    service = new SshSnippetsService({ sshHome: path.join(tmp, "ssh"), acquire: clients.acquire });
    service.subscribe((event) => events.push(event));
  });

  afterAll(async () => {
    await service.dispose();
    clients.closeAll();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it("runs a saved snippet on every server in parallel with per-server output and exit codes", async () => {
    const snippet = await service.saveSnippet({
      label: "Kernel",
      script: 'uname -a; echo "user=$(whoami)"; echo oops >&2; exit 3',
      defaultTargets: ["srv_one", "srv_two"],
    });
    const started = await service.run({
      source: { kind: "snippet", snippetId: snippet.id },
      serverIds: ["srv_one", "srv_two", "srv_down"],
    });
    expect(started.targets.map((t) => t.state)).toEqual(["connecting", "connecting", "connecting"]);

    const run = await service.waitForRun(started.runId);
    const byServer = new Map(run.targets.map((t) => [t.serverId, t]));
    for (const serverId of ["srv_one", "srv_two"]) {
      const target = byServer.get(serverId)!;
      expect(target.state).toBe("exited");
      expect(target.exitCode).toBe(3);
      expect(target.error).toBeNull();
      const stdout = target.output.filter((c) => c.stream === "stdout").map((c) => c.text);
      const stderr = target.output.filter((c) => c.stream === "stderr").map((c) => c.text);
      expect(stdout.join("")).toMatch(/^Linux .+\nuser=jad\n$/);
      expect(stderr.join("")).toBe("oops\n");
      const streamed = events
        .filter((e) => e.type === "ssh.snippet.output" && e.runId === run.runId)
        .filter((e) => e.type === "ssh.snippet.output" && e.serverId === serverId);
      expect(streamed.map((e) => (e.type === "ssh.snippet.output" ? e.text : "")).join("")).toBe(
        target.output.map((c) => c.text).join(""),
      );
    }
    const down = byServer.get("srv_down")!;
    expect(down.state).toBe("failed");
    expect(down.error?.code).toBe("ECONNREFUSED");
    expect(run.finishedAtMs).not.toBeNull();
    expect(clients.outstanding()).toBe(0);

    const states = events
      .filter((e) => e.type === "ssh.snippet.state" && e.runId === run.runId)
      .map((e) => (e.type === "ssh.snippet.state" ? `${e.target.serverId}:${e.target.state}` : ""));
    expect(states.filter((s) => s.startsWith("srv_one:"))).toEqual([
      "srv_one:connecting",
      "srv_one:running",
      "srv_one:exited",
    ]);

    expect((await service.listHistory("srv_two"))[0]).toMatchObject({
      command: snippet.script,
      source: "snippet",
    });
  });

  it("cancels a running target and times out another", async () => {
    const cancelRun = await service.run({
      source: { kind: "script", script: "sleep 30" },
      serverIds: ["srv_one"],
    });
    await waitFor(() => service.getRun(cancelRun.runId)?.targets[0]?.state === "running");
    service.cancelRun(cancelRun.runId);
    const cancelled = await service.waitForRun(cancelRun.runId);
    expect(cancelled.targets[0]?.state).toBe("cancelled");

    const timed = await service.run({
      source: { kind: "script", script: "sleep 30" },
      serverIds: ["srv_two"],
      timeoutMs: 500,
    });
    const timedOut = await service.waitForRun(timed.runId);
    expect(timedOut.targets[0]).toMatchObject({
      state: "failed",
      error: { code: "timeout", message: "Timed out after 500 ms" },
    });
    expect(clients.outstanding()).toBe(0);
  });

  it("answers ssh.snippet.run.request through the RPC handler with a valid wire message", async () => {
    const sent: SnippetsOutboundMessage[] = [];
    const handled = await handleSnippetsMessage(
      service,
      {
        type: "ssh.snippet.run.request",
        requestId: "req_1",
        source: { kind: "script", script: "echo hello" },
        serverIds: ["srv_one"],
      } as { type: string },
      (message) => sent.push(message),
    );
    expect(handled).toBe(true);
    const response = SnippetsOutboundMessageSchema.parse(sent[0]);
    expect(response.type).toBe("ssh.snippet.run.response");
    if (response.type !== "ssh.snippet.run.response") return;
    const run = await service.waitForRun(response.payload.run!.runId);
    expect(run.targets[0]?.output).toEqual([{ stream: "stdout", text: "hello\n" }]);
    expect(await handleSnippetsMessage(service, { type: "ssh.sftp.list.request" }, () => {})).toBe(
      false,
    );
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
