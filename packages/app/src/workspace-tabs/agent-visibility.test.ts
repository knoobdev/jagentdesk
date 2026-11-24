import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabSnapshot,
  createWorkspaceAgentVisibilitySelector,
  deriveWorkspaceAgentVisibility,
  shouldPruneWorkspaceAgentTab,
  workspaceAgentVisibilityEqual,
} from "@/workspace-tabs/agent-visibility";

function makeAgent(input: {
  id: string;
  cwd: string;
  workspaceId?: string;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
  createdAt?: Date;
  lastActivityAt?: Date;
  labels?: Record<string, string>;
}): Agent {
  const createdAt = input.createdAt ?? new Date("2026-03-04T00:00:00.000Z");
  const lastActivityAt = input.lastActivityAt ?? createdAt;
  return {
    serverId: "srv",
    id: input.id,
    provider: "codex",
    status: "idle",
    activeTurn: null,
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "codex",
      sessionId: null,
    },
    title: null,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    model: null,
    thinkingOptionId: null,
    parentAgentId: input.parentAgentId ?? null,
    labels: input.labels ?? {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt ?? null,
  };
}

const WORKSPACE_ID = "ws-1";

describe("workspace agent visibility", () => {
  it("removes a restored pinned tab from an unrelated workspace once its owner is known", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => values.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: async (key: string) => {
        values.delete(key);
      },
    };
    const original = createWorkspaceLayoutStore(undefined, storage);
    await original.persist.rehydrate();
    const agent = makeAgent({ id: "restored-agent", cwd: "/project-a", workspaceId: "ws-a" });
    for (const workspaceId of ["ws-a", "ws-b"]) {
      original
        .getState()
        .openTabFocused(`srv:${workspaceId}`, { kind: "agent", agentId: agent.id });
      original.getState().pinAgent(`srv:${workspaceId}`, agent.id);
    }
    const restored = createWorkspaceLayoutStore(undefined, storage);
    await restored.persist.rehydrate();
    const sessionAgents = new Map([[agent.id, agent]]);
    const beforeHydration = buildWorkspaceTabSnapshot({
      agentVisibility: deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId: "ws-b" }),
      agentsHydrated: false,
      terminalsHydrated: true,
      knownTerminalIds: [],
      standaloneTerminalIds: [],
      hasActivePendingDraftCreate: false,
    });
    restored.getState().reconcileTabs("srv:ws-b", beforeHydration);
    expect(restored.getState().pinnedAgentIdsByWorkspace["srv:ws-b"]).toEqual(new Set([agent.id]));
    for (const workspaceId of ["ws-a", "ws-b"]) {
      restored.getState().reconcileTabs(
        `srv:${workspaceId}`,
        buildWorkspaceTabSnapshot({
          agentVisibility: deriveWorkspaceAgentVisibility({ sessionAgents, workspaceId }),
          agentsHydrated: true,
          terminalsHydrated: true,
          knownTerminalIds: [],
          standaloneTerminalIds: [],
          hasActivePendingDraftCreate: false,
        }),
      );
    }

    expect(
      restored
        .getState()
        .getWorkspaceTabs("srv:ws-a")
        .filter((tab) => tab.target.kind === "agent")
        .map((tab) => tab.target),
    ).toEqual([{ kind: "agent", agentId: agent.id }]);
    expect(
      restored
        .getState()
        .getWorkspaceTabs("srv:ws-b")
        .filter((tab) => tab.target.kind === "agent"),
    ).toEqual([]);
    expect(restored.getState().pinnedAgentIdsByWorkspace["srv:ws-b"]).toBeUndefined();
  });

  it("uses directory ownership before historical details when identifying foreign agents", () => {
    const own = makeAgent({ id: "own", cwd: "/repo", workspaceId: WORKSPACE_ID });
    const foreign = makeAgent({ id: "foreign", cwd: "/repo", workspaceId: "ws-2" });
    const unknown = makeAgent({ id: "unknown", cwd: "/repo" });
    const result = deriveWorkspaceAgentVisibility({
      workspaceId: WORKSPACE_ID,
      sessionAgents: new Map([
        [own.id, own],
        [foreign.id, foreign],
        [unknown.id, unknown],
      ]),
      agentDetails: new Map([
        [own.id, { ...own, workspaceId: "ws-2" }],
        [foreign.id, { ...foreign, workspaceId: WORKSPACE_ID }],
        [unknown.id, { ...unknown, workspaceId: "ws-2" }],
      ]),
    });

    expect(result.activeAgentIds).toEqual(new Set([own.id]));
    expect(result.foreignAgentIds).toEqual(new Set([foreign.id]));
  });

  it("recognizes foreign historical ownership without making archived or unknown agents foreign", () => {
    const archived = makeAgent({
      id: "archived",
      cwd: "/repo",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });
    const foreign = { ...archived, id: "foreign", workspaceId: "ws-2" };
    const unknown = { ...archived, id: "unknown", workspaceId: undefined };
    const result = deriveWorkspaceAgentVisibility({
      workspaceId: WORKSPACE_ID,
      sessionAgents: new Map(),
      agentDetails: new Map([
        [archived.id, archived],
        [foreign.id, foreign],
        [unknown.id, unknown],
      ]),
    });

    expect(result.activeAgentIds).toEqual(new Set());
    expect(result.foreignAgentIds).toEqual(new Set([foreign.id]));
  });

  it("keeps subagents active and known while excluding them from auto-open", () => {
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [parent.id, parent],
        [child.id, child],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["parent-agent", "child-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["parent-agent"]));
    expect(result.knownAgentIds).toEqual(new Set(["parent-agent", "child-agent"]));
  });

  it("keeps archived subagents known but excludes them from active and auto-open", () => {
    const archivedChild = makeAgent({
      id: "archived-child",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([[archivedChild.id, archivedChild]]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.autoOpenAgentIds).toEqual(new Set<string>());
    expect(result.knownAgentIds).toEqual(new Set(["archived-child"]));
  });

  it("excludes a child from auto-open even when its snapshot arrives before the parent", () => {
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: "parent-agent",
    });
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [child.id, child],
        [parent.id, parent],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["child-agent", "parent-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["parent-agent"]));
    expect(result.knownAgentIds).toEqual(new Set(["child-agent", "parent-agent"]));
  });

  it("auto-opens a subagent whose parent belongs to another workspace", () => {
    const parent = makeAgent({
      id: "parent-agent",
      cwd: "/repo",
      workspaceId: "ws-parent",
    });
    const child = makeAgent({
      id: "child-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      parentAgentId: parent.id,
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map<string, Agent>([
        [parent.id, parent],
        [child.id, child],
      ]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["child-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["child-agent"]));
    expect(result.knownAgentIds).toEqual(new Set(["child-agent"]));
  });

  it("keeps archived agents out of activeAgentIds but present in knownAgentIds", () => {
    const visible = makeAgent({
      id: "visible-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
    });
    const archived = makeAgent({
      id: "archived-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
      createdAt: new Date("2026-03-04T00:01:00.000Z"),
    });
    const otherWorkspace = makeAgent({
      id: "other-workspace-agent",
      cwd: "/repo/other",
      workspaceId: "ws-other",
    });

    const sessionAgents = new Map<string, Agent>([
      [visible.id, visible],
      [archived.id, archived],
      [otherWorkspace.id, otherWorkspace],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["visible-agent"]));
    expect(result.autoOpenAgentIds).toEqual(new Set(["visible-agent"]));
    expect(result.knownAgentIds.has("visible-agent")).toBe(true);
    expect(result.knownAgentIds.has("archived-agent")).toBe(true);
    expect(result.knownAgentIds.has("other-workspace-agent")).toBe(false);
  });

  it("treats lazy historical details as known without making them active", () => {
    const active = makeAgent({
      id: "active-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
    });
    const historicalDetail = makeAgent({
      id: "historical-agent",
      cwd: "/repo/worktree",
      workspaceId: WORKSPACE_ID,
      archivedAt: new Date("2026-03-04T00:01:00.000Z"),
    });

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents: new Map([[active.id, active]]),
      agentDetails: new Map([[historicalDetail.id, historicalDetail]]),
      workspaceId: WORKSPACE_ID,
    });

    expect(result.activeAgentIds).toEqual(new Set(["active-agent"]));
    expect(result.knownAgentIds).toEqual(new Set(["active-agent", "historical-agent"]));
  });

  it("prunes archived agent tabs so archiving on one client closes tabs on all clients", () => {
    const activeAgentIds = new Set<string>();

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        activeAgentIds,
      }),
    ).toBe(true);
  });

  it("prunes pinned archived agent tabs because archive state is authoritative", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "archived-agent",
        agentsHydrated: true,
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("does not prune active agent tabs", () => {
    const activeAgentIds = new Set(["active-agent"]);

    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "active-agent",
        agentsHydrated: true,
        activeAgentIds,
      }),
    ).toBe(false);
  });

  it("prunes agent tabs once agents are hydrated and the agent is missing from activeAgentIds", () => {
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "missing-agent",
        agentsHydrated: true,
        activeAgentIds: new Set<string>(),
      }),
    ).toBe(true);
  });

  it("matches agents by workspaceId regardless of cwd", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "stamped-agent",
        makeAgent({
          id: "stamped-agent",
          cwd: "/repo/subdir",
          workspaceId: "ws-1",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set(["stamped-agent"]));
    expect(result.knownAgentIds).toEqual(new Set(["stamped-agent"]));
  });

  it("excludes a stamped agent whose workspaceId belongs to another workspace sharing the cwd", () => {
    const sessionAgents = new Map<string, Agent>([
      [
        "other-ws-agent",
        makeAgent({
          id: "other-ws-agent",
          cwd: "/repo/worktree",
          workspaceId: "ws-2",
        }),
      ],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.knownAgentIds).toEqual(new Set<string>());
  });

  it("excludes agents without a workspaceId", () => {
    const sessionAgents = new Map<string, Agent>([
      ["ownerless-agent", makeAgent({ id: "ownerless-agent", cwd: "/repo/worktree" })],
    ]);

    const result = deriveWorkspaceAgentVisibility({
      sessionAgents,
      workspaceId: "ws-1",
    });

    expect(result.activeAgentIds).toEqual(new Set<string>());
    expect(result.knownAgentIds).toEqual(new Set<string>());
  });

  it("builds the tab reconciliation snapshot without callers unpacking agent visibility", () => {
    const agentVisibility = {
      activeAgentIds: new Set(["active-agent"]),
      autoOpenAgentIds: new Set(["root-agent"]),
      foreignAgentIds: new Set<string>(),
      knownAgentIds: new Set(["active-agent", "archived-agent"]),
    };

    expect(
      buildWorkspaceTabSnapshot({
        agentVisibility,
        agentsHydrated: true,
        terminalsHydrated: true,
        knownTerminalIds: ["terminal-1", "script-terminal"],
        standaloneTerminalIds: ["terminal-1"],
        hasActivePendingDraftCreate: false,
      }),
    ).toEqual({
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: agentVisibility.activeAgentIds,
      autoOpenAgentIds: agentVisibility.autoOpenAgentIds,
      foreignAgentIds: new Set<string>(),
      knownAgentIds: agentVisibility.knownAgentIds,
      knownTerminalIds: ["terminal-1", "script-terminal"],
      standaloneTerminalIds: ["terminal-1"],
      hasActivePendingDraftCreate: false,
    });
  });

  describe("workspaceAgentVisibilityEqual", () => {
    it("returns true for identical sets", () => {
      const a = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set(["a", "b", "c"]),
      };
      const b = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set(["a", "b", "c"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });

    it("returns false when activeAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set(["a"]),
      };
      const b = {
        activeAgentIds: new Set(["b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set(["a"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns false when autoOpenAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set(["a", "b"]),
      };
      const b = {
        activeAgentIds: new Set(["a", "b"]),
        autoOpenAgentIds: new Set(["b"]),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set(["a", "b"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns false when knownAgentIds differ", () => {
      const a = {
        activeAgentIds: new Set(["a"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set(["a"]),
      };
      const b = {
        activeAgentIds: new Set(["a"]),
        autoOpenAgentIds: new Set(["a"]),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set(["a", "b"]),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(false);
    });

    it("returns true for empty sets", () => {
      const a = {
        activeAgentIds: new Set<string>(),
        autoOpenAgentIds: new Set<string>(),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set<string>(),
      };
      const b = {
        activeAgentIds: new Set<string>(),
        autoOpenAgentIds: new Set<string>(),
        foreignAgentIds: new Set<string>(),
        knownAgentIds: new Set<string>(),
      };
      expect(workspaceAgentVisibilityEqual(a, b)).toBe(true);
    });
  });
});

describe("screen dock agents", () => {
  const older = new Date("2026-03-01T00:00:00.000Z");
  const newer = new Date("2026-03-05T00:00:00.000Z");

  it("keeps a dock chat filed into another conversation's workspace out of its tabs", () => {
    const workspaceId = "wks_shared";
    const agents = new Map<string, Agent>([
      ["chat", makeAgent({ id: "chat", cwd: "/repo", workspaceId, createdAt: older })],
      [
        "sim",
        makeAgent({
          id: "sim",
          cwd: "/repo",
          workspaceId,
          createdAt: newer,
          labels: { "jagentdesk.simfleet.server": "srv" },
        }),
      ],
      [
        "db",
        makeAgent({
          id: "db",
          cwd: "/repo",
          workspaceId,
          createdAt: newer,
          labels: { "jagentdesk.database.id": "d1" },
        }),
      ],
      [
        "k8s",
        makeAgent({
          id: "k8s",
          cwd: "/repo",
          workspaceId,
          createdAt: newer,
          labels: { "jagentdesk.cluster.id": "c1" },
        }),
      ],
    ]);

    const visibility = deriveWorkspaceAgentVisibility({ sessionAgents: agents, workspaceId });

    expect([...visibility.autoOpenAgentIds]).toEqual(["chat"]);
    expect([...visibility.activeAgentIds]).toEqual(["chat"]);
    // The tab auto-opened for the misfiled sim chat is pruned once agents hydrate.
    expect(
      shouldPruneWorkspaceAgentTab({
        agentId: "sim",
        agentsHydrated: true,
        activeAgentIds: visibility.activeAgentIds,
      }),
    ).toBe(true);
  });

  it("opens a dock chat as a tab in its own workspace", () => {
    const workspaceId = "wks_sim_chat";
    const agents = new Map<string, Agent>([
      [
        "sim",
        makeAgent({
          id: "sim",
          cwd: "/repo",
          workspaceId,
          createdAt: newer,
          labels: { "jagentdesk.simfleet.server": "srv" },
        }),
      ],
    ]);

    const visibility = deriveWorkspaceAgentVisibility({ sessionAgents: agents, workspaceId });

    expect([...visibility.autoOpenAgentIds]).toEqual(["sim"]);
    expect([...visibility.activeAgentIds]).toEqual(["sim"]);
  });
});

it("reuses visibility through stream updates and preserves newly known dock agents", () => {
  const agent = makeAgent({ id: "a", cwd: "/repo", workspaceId: WORKSPACE_ID });
  const agents = new Map([[agent.id, agent]]);
  const agentDetails = new Map<string, Agent>();
  const select = createWorkspaceAgentVisibilitySelector({
    serverId: "srv",
    workspaceId: WORKSPACE_ID,
  });
  const before = select({ sessions: { srv: { agents, agentDetails } } });
  expect(select({ sessions: { srv: { agents, agentDetails } } })).toBe(before);
  expect(select({ sessions: { srv: { agents: new Map(agents), agentDetails } } })).toBe(before);
  const dock = makeAgent({
    id: "dock",
    cwd: "/repo",
    workspaceId: WORKSPACE_ID,
    labels: { "jagentdesk-dock": "database" },
  });
  const after = select({ sessions: { srv: { agents, agentDetails: new Map([[dock.id, dock]]) } } });
  expect(after.knownAgentIds).toEqual(new Set(["a", "dock"]));
  expect(before.knownAgentIds).toEqual(new Set(["a"]));
});
