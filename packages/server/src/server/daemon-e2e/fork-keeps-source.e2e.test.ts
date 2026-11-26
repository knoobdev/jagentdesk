import { execSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

// Spec 41 §6 / A41.10: forking into a new workspace never archives or hides the source agent or its
// workspace, including when the new workspace opens the same directory (a plain folder has no
// worktrees, so the fork's workspace shares the source's cwd).

const cleanupPaths = new Set<string>();
let ctx: DaemonTestContext | null = null;

afterEach(async () => {
  await ctx?.cleanup();
  ctx = null;
  for (const target of cleanupPaths) rmSync(target, { recursive: true, force: true });
  cleanupPaths.clear();
});

function makeDirectory(kind: "plain" | "git"): string {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), `jagentdesk-fork-source-${kind}-`)));
  cleanupPaths.add(dir);
  writeFileSync(path.join(dir, "README.md"), "# fork source\n", "utf8");
  if (kind === "git") {
    execSync("git init -b main", { cwd: dir, stdio: "pipe" });
    execSync("git add README.md", { cwd: dir, stdio: "pipe" });
    execSync(
      "git -c user.name=test -c user.email=test@localhost -c commit.gpgSign=false commit -m init",
      { cwd: dir, stdio: "pipe" },
    );
  }
  return dir;
}

describe("fork into a new workspace", () => {
  for (const kind of ["plain", "git"] as const) {
    test(`keeps the source agent and workspace active (${kind} directory)`, async () => {
      ctx = await createDaemonTestContext({
        agentClients: { mock: new MockLoadTestAgentClient() },
        mcpEnabled: false,
        isDev: true,
      });
      const { client } = ctx;
      const dir = makeDirectory(kind);

      const source = await client.createWorkspace({ source: { kind: "directory", path: dir } });
      if (!source.workspace) throw new Error(source.error ?? "Missing source workspace");
      const sourceAgent = await client.createAgent({
        workspaceId: source.workspace.id,
        provider: "mock",
        model: "e2e-fast-stream",
        cwd: dir,
        initialPrompt: "Work on this task",
      });
      await client.waitForFinish(sourceAgent.id, 30_000);

      // What "Fork in a new workspace" sends: the fork context, then the new-workspace screen's
      // workspace.create for the same directory with the first agent.
      const forkContext = await client.buildAgentForkContext(sourceAgent.id);
      expect(forkContext.error ?? null).toBeNull();
      const fork = await client.createWorkspace({
        source: { kind: "directory", path: dir, projectId: source.workspace.projectId },
        agent: {
          provider: "mock",
          model: "e2e-fast-stream",
          cwd: dir,
          initialPrompt: "Continue from the fork",
        },
      });
      if (!fork.workspace) throw new Error(fork.error ?? "Missing fork workspace");
      expect(fork.workspace.id).not.toBe(source.workspace.id);
      expect(fork.agent?.id).toBeDefined();

      const sourceAfter = await client.fetchAgent({ agentId: sourceAgent.id });
      expect(sourceAfter?.agent.archivedAt ?? null).toBeNull();

      const listed = await client.fetchWorkspaces({});
      const listedIds = listed.entries.map((entry) => entry.id);
      expect(listedIds).toEqual(expect.arrayContaining([source.workspace.id, fork.workspace.id]));
      const sourceRow = listed.entries.find((entry) => entry.id === source.workspace!.id);
      expect(sourceRow?.archivingAt ?? null).toBeNull();

      const forkAfter = await client.fetchAgent({ agentId: fork.agent!.id });
      expect(forkAfter?.agent.archivedAt ?? null).toBeNull();
    }, 60_000);
  }
});
