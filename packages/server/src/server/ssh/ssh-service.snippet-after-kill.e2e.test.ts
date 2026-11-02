import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SshSnippetRunTarget } from "@jagentdesk/protocol/ssh/snippets-schemas";
import { SshSnippetsService } from "./snippets/service.js";
import { SshService } from "./ssh-service.js";
import { TEST_SSHD } from "./test-support/test-sshd.js";

// Snippet runs on a pooled connection (spec 25.7): right after a tab on the same server was
// killed, and back-to-back quick commands whose exit-status arrives in the same socket read as
// the exec confirmation (the acceptance run once saw those reported as `connection_lost`).
// Run against the sshd from test-support/start-test-sshd.sh:
//   JAD_SSH_E2E=1 JAD_TEST_SSHD_PORT=<port> npx vitest run <this file>

async function waitFor<T>(probe: () => T | null | undefined | false, label: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function outputText(target: SshSnippetRunTarget | undefined): string {
  return (target?.output ?? [])
    .map((chunk) => chunk.text)
    .join("")
    .trim();
}

describe.runIf(process.env.JAD_SSH_E2E === "1")("snippet runs on a pooled connection", () => {
  let home: string;
  let service: SshService;
  let snippets: SshSnippetsService;
  let serverId: string;
  const parallelIds: string[] = [];

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "jad-ssh-kill-run-"));
    service = new SshService({
      jagentdeskHome: home,
      broadcast: (message) => {
        if (message.type === "ssh.hostkey.prompt")
          service.respondHostKey(message.promptId, "accept");
      },
    });
    await service.initialize();
    snippets = new SshSnippetsService({
      acquire: service.acquireClient,
      sshHome: path.join(home, "ssh"),
    });
    const saved = await service.saveServer(
      {
        id: "",
        label: "kill-then-run",
        address: TEST_SSHD.host,
        port: TEST_SSHD.port,
        username: TEST_SSHD.username,
        authMethods: ["password"],
      },
      { password: TEST_SSHD.password },
    );
    serverId = saved.id;
    // Three more records for the same sshd: three pooled connections running at once is what
    // makes ssh2 parse confirmation, output and exit-status in one socket read.
    for (const label of ["parallel-a", "parallel-b", "parallel-c"]) {
      const extra = await service.saveServer(
        {
          id: "",
          label,
          address: TEST_SSHD.host,
          port: TEST_SSHD.port,
          username: TEST_SSHD.username,
          authMethods: ["password"],
        },
        { password: TEST_SSHD.password },
      );
      parallelIds.push(extra.id);
    }
  });

  afterAll(async () => {
    await snippets?.dispose();
    service?.dispose();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function openTab(): Promise<string> {
    const terminalId = service.createSession(serverId, { cols: 80, rows: 24 });
    const session = await waitFor(() => service.getSshTerminalSession(terminalId), "session");
    await waitFor(() => session.hasShell(), "shell");
    return terminalId;
  }

  it("every run that starts right after the kill exits 0 with its output", async () => {
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const terminalId = await openTab();
      service.getSshTerminalSession(terminalId)?.kill();
      const started = await snippets.run({
        source: { kind: "script", script: "echo run-$((40+2))" },
        serverIds: [serverId],
      });
      const run = await snippets.waitForRun(started.runId);
      const target = run.targets[0];
      outcomes.push(
        `${target?.state} ${target?.exitCode} ${target?.error?.code ?? "-"} ${outputText(target)}`,
      );
    }
    expect(outcomes).toEqual(Array.from({ length: 10 }, () => "exited 0 - run-42"));
  });

  it("a run started in the same tick as the kill succeeds", async () => {
    const terminalId = await openTab();
    const kill = Promise.resolve().then(() => service.getSshTerminalSession(terminalId)?.kill());
    const started = snippets.run({
      source: { kind: "script", script: "uname -s" },
      serverIds: [serverId],
    });
    await kill;
    const run = await snippets.waitForRun((await started).runId);
    expect(run.targets.map((t) => [t.state, t.exitCode, outputText(t)])).toEqual([
      ["exited", 0, "Linux"],
    ]);
  });

  it("60 rounds of a quick command on three warm connections all report their exit code", async () => {
    const outcomes = new Map<string, number>();
    for (let round = 0; round < 60; round += 1) {
      const started = await snippets.run({
        source: { kind: "script", script: "echo x" },
        serverIds: parallelIds,
      });
      const run = await snippets.waitForRun(started.runId);
      for (const target of run.targets) {
        const key = `${target.state} ${target.exitCode} ${target.error?.code ?? "-"}`;
        outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
      }
    }
    expect(Object.fromEntries(outcomes)).toEqual({ "exited 0 -": 180 });
  });
});
