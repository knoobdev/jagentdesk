import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Logger } from "pino";
import {
  MIGRATED_FROM_LABEL,
  MIGRATION_HISTORY_UNAVAILABLE_LABEL,
} from "@jagentdesk/protocol/agent-labels";

import type { StoredAgentRecord } from "../agent/agent-storage.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../workspace-registry.js";
import { claudeProjectDir } from "../agent/providers/claude/project-dir.js";
import { exportHostData } from "./export-host-data.js";
import { importHostData } from "./import-host-data.js";

const logger = {
  warn: () => {},
  info: () => {},
  error: () => {},
} as unknown as Logger;

let tmpRoot: string;
let claudeConfigDir: string;
let agentCwd: string;
const sessionId = "session-abc";

const project: PersistedProjectRecord = {
  projectId: "proj_1",
  rootPath: "/repo",
  kind: "git",
  displayName: "repo",
  projectKey: null,
  customName: null,
  customIconRevision: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
};

function makeWorkspace(): PersistedWorkspaceRecord {
  return {
    workspaceId: "ws_1",
    projectId: "proj_1",
    cwd: agentCwd,
    kind: "directory",
    displayName: "ws",
    title: null,
    branch: null,
    worktreeRoot: null,
    baseBranch: null,
    isJAgentDeskOwnedWorktree: false,
    mainRepoRoot: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
    autoArchivedChangeRequestUrl: null,
    pinnedAt: null,
  };
}

function makeRecord(): StoredAgentRecord {
  return {
    id: "agent_old",
    provider: "claude",
    cwd: agentCwd,
    workspaceId: "ws_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    labels: { foo: "bar" },
    lastStatus: "closed",
    persistence: { provider: "claude", sessionId },
    usageTotals: {
      inputTokens: 10,
      cachedInputTokens: 1,
      outputTokens: 5,
      totalCostUsd: 0.02,
      turns: 2,
    },
  };
}

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jagentdesk-migration-"));
  claudeConfigDir = path.join(tmpRoot, ".claude");
  agentCwd = path.join(tmpRoot, "work");
  await fs.mkdir(agentCwd, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  // Seed a fake provider transcript so capture has something to bundle.
  const projectDir = await claudeProjectDir(agentCwd);
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "user", text: "hello" }) + "\n",
  );
});

afterAll(async () => {
  delete process.env.CLAUDE_CONFIG_DIR;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("host data export/import", () => {
  it("exports records, workspaces, projects and captures provider history", async () => {
    const bundle = await exportHostData({
      serverId: "srv_source",
      agentStorage: { list: async () => [makeRecord()] },
      workspaceRegistry: { list: async () => [makeWorkspace()] },
      projectRegistry: { list: async () => [project] },
      logger,
    });

    expect(bundle.sourceServerId).toBe("srv_source");
    expect(bundle.agents).toHaveLength(1);
    expect(bundle.agents[0].oldAgentId).toBe("agent_old");
    expect(bundle.agents[0].historyPortable).toBe(true);
    expect(bundle.agents[0].historyBlobRef).not.toBeNull();
    expect(bundle.projects).toHaveLength(1);
    expect(bundle.workspaces).toHaveLength(1);
    expect(Object.keys(bundle.historyBlobs)).toHaveLength(1);
  });

  it("imports onto a target, assigns a new id, stamps provenance, materializes same-machine history", async () => {
    const bundle = await exportHostData({
      serverId: "srv_source",
      agentStorage: { list: async () => [makeRecord()] },
      workspaceRegistry: { list: async () => [makeWorkspace()] },
      projectRegistry: { list: async () => [project] },
      logger,
    });

    const writtenAgents: StoredAgentRecord[] = [];
    const writtenWorkspaces: PersistedWorkspaceRecord[] = [];
    const writtenProjects: PersistedProjectRecord[] = [];

    // Remove the seeded transcript so materialization must recreate it.
    const projectDir = await claudeProjectDir(agentCwd);
    await fs.rm(path.join(projectDir, `${sessionId}.jsonl`));

    const result = await importHostData({
      targetServerId: "srv_target",
      bundle,
      agentStorage: {
        upsert: async (record) => {
          writtenAgents.push(record);
        },
      },
      workspaceRegistry: {
        upsert: async (record) => {
          writtenWorkspaces.push(record as PersistedWorkspaceRecord);
        },
        get: async () => null,
      },
      projectRegistry: {
        upsert: async (record) => {
          writtenProjects.push(record as PersistedProjectRecord);
        },
        get: async () => null,
      },
      logger,
      newAgentId: () => "agent_new",
    });

    expect(result.idMap).toEqual({ agent_old: "agent_new" });
    expect(result.sourceServerId).toBe("srv_source");
    expect(result.targetServerId).toBe("srv_target");
    expect(result.importedAgentCount).toBe(1);
    expect(result.historyMaterializedCount).toBe(1);
    expect(result.historyUnavailableCount).toBe(0);
    expect(writtenProjects).toHaveLength(1);
    expect(writtenWorkspaces).toHaveLength(1);

    const imported = writtenAgents[0];
    expect(imported.id).toBe("agent_new");
    expect(imported.labels[MIGRATED_FROM_LABEL]).toBe("srv_source");
    expect(imported.labels.foo).toBe("bar");
    expect(imported.labels[MIGRATION_HISTORY_UNAVAILABLE_LABEL]).toBeUndefined();

    // Same-machine materialization recreated the transcript at the target path.
    const materialized = await fs.readFile(path.join(projectDir, `${sessionId}.jsonl`), "utf8");
    expect(materialized).toContain("hello");
  });

  it("materializes cross-machine history by rewriting embedded paths when the target cwd exists", async () => {
    const fakeSourceHome = "/some/other/machine/home";
    // Seed a transcript that embeds the SOURCE machine's home so we can prove the
    // path rewrite runs. capture reads it verbatim into the bundle.
    const projectDir = await claudeProjectDir(agentCwd);
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "user", cwd: agentCwd, transcript: `${fakeSourceHome}/notes.md` }) +
        "\n",
    );

    const bundle = await exportHostData({
      serverId: "srv_source",
      agentStorage: { list: async () => [makeRecord()] },
      workspaceRegistry: { list: async () => [makeWorkspace()] },
      projectRegistry: { list: async () => [project] },
      logger,
    });
    // Simulate a DIFFERENT physical machine: the source home is not this host's,
    // but the target cwd (agentCwd) genuinely exists here.
    const crossMachineBundle = { ...bundle, sourceHome: fakeSourceHome };

    // Remove the seeded transcript so materialization must recreate it.
    await fs.rm(path.join(projectDir, `${sessionId}.jsonl`));

    const writtenAgents: StoredAgentRecord[] = [];
    const result = await importHostData({
      targetServerId: "srv_target",
      bundle: crossMachineBundle,
      agentStorage: {
        upsert: async (record) => {
          writtenAgents.push(record);
        },
      },
      workspaceRegistry: { upsert: async () => {}, get: async () => null },
      projectRegistry: { upsert: async () => {}, get: async () => null },
      logger,
      newAgentId: () => "agent_new",
    });

    // History crossed machines: it is materialized and NOT flagged unavailable.
    expect(result.historyMaterializedCount).toBe(1);
    expect(result.historyUnavailableCount).toBe(0);
    expect(writtenAgents[0].labels[MIGRATION_HISTORY_UNAVAILABLE_LABEL]).toBeUndefined();

    // The transcript is on disk at the target project dir and the source home has
    // been rewritten to this machine's home so the session can resume.
    const materialized = await fs.readFile(path.join(projectDir, `${sessionId}.jsonl`), "utf8");
    expect(materialized).toContain(`${os.homedir()}/notes.md`);
    expect(materialized).not.toContain(fakeSourceHome);

    // Restore the generic transcript the other tests rely on.
    await fs.writeFile(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "user", text: "hello" }) + "\n",
    );
  });

  it("flags history unavailable when the target cwd does not exist (honest seam)", async () => {
    const bundle = await exportHostData({
      serverId: "srv_source",
      agentStorage: { list: async () => [makeRecord()] },
      workspaceRegistry: { list: async () => [makeWorkspace()] },
      projectRegistry: { list: async () => [project] },
      logger,
    });
    // The target machine has no such working directory: the session cannot resume
    // there, so history must NOT be faked. Point the imported record at a missing
    // path while keeping the captured transcript bytes in the bundle.
    const missingCwd = path.join(tmpRoot, "does-not-exist-on-target");
    const bundleMissingCwd = {
      ...bundle,
      sourceHome: "/some/other/machine/home",
      agents: bundle.agents.map((agent) =>
        Object.assign({}, agent, {
          record: { ...agent.record, cwd: missingCwd },
        }),
      ),
    };

    const writtenAgents: StoredAgentRecord[] = [];
    const result = await importHostData({
      targetServerId: "srv_target",
      bundle: bundleMissingCwd,
      agentStorage: {
        upsert: async (record) => {
          writtenAgents.push(record);
        },
      },
      workspaceRegistry: { upsert: async () => {}, get: async () => null },
      projectRegistry: { upsert: async () => {}, get: async () => null },
      logger,
      newAgentId: () => "agent_new",
    });

    expect(result.historyMaterializedCount).toBe(0);
    expect(result.historyUnavailableCount).toBe(1);
    expect(writtenAgents[0].labels[MIGRATION_HISTORY_UNAVAILABLE_LABEL]).toBe("true");
    // The agent still exists on the target so it is visible.
    expect(writtenAgents[0].id).toBe("agent_new");
    // Nothing was written under the (non-existent) target project dir.
    const missingProjectDir = await claudeProjectDir(missingCwd);
    await expect(fs.access(missingProjectDir)).rejects.toThrow();
  });
});
