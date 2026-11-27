import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { buildWorkspaceAgentsRoster } from "./workspace-agents-roster";

function makeAgent(input: {
  id: string;
  workspaceId: string;
  title?: string;
  parentAgentId?: string | null;
  archivedAt?: Date | null;
  labels?: Record<string, string>;
}): Agent {
  const createdAt = new Date("2026-11-28T00:00:00.000Z");
  return {
    serverId: "srv",
    id: input.id,
    provider: "claude",
    status: "idle",
    activeTurn: null,
    createdAt,
    updatedAt: createdAt,
    lastUserMessageAt: null,
    lastActivityAt: createdAt,
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
    runtimeInfo: { provider: "claude", sessionId: null },
    title: input.title ?? null,
    cwd: `/${input.workspaceId}`,
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

const ROLE = "jagentdesk.orchestration.role";

function roster(agents: Agent[], workspaceId: string) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return buildWorkspaceAgentsRoster({
    agents: agents.values(),
    workspaceId,
    lookup: (agentId) => byId.get(agentId),
  }).map((entry) => [entry.role, entry.agent.id, entry.external]);
}

describe("buildWorkspaceAgentsRoster", () => {
  it("lists the bot chat that started a worker as the worker workspace's Supervisor", () => {
    // User report 2026-11-28: the phone showed the worker but no way to reach its Supervisor.
    const home = makeAgent({ id: "home", workspaceId: "bot-home", title: "heocon" });
    const lead = makeAgent({
      id: "lead",
      workspaceId: "worker",
      parentAgentId: "home",
      labels: { [ROLE]: "lead" },
    });
    const peer = makeAgent({
      id: "peer",
      workspaceId: "worker",
      parentAgentId: "lead",
      labels: { [ROLE]: "peer" },
    });
    expect(roster([peer, lead, home], "worker")).toEqual([
      ["supervisor", "home", true],
      ["lead", "lead", false],
      ["peer", "peer", false],
    ]);
  });

  it("keeps a workspace's own Supervisor and adds no outside agent", () => {
    const supervisor = makeAgent({
      id: "sup",
      workspaceId: "ws",
      labels: { [ROLE]: "supervisor" },
    });
    const lead = makeAgent({
      id: "lead",
      workspaceId: "ws",
      parentAgentId: "sup",
      labels: { [ROLE]: "lead" },
    });
    expect(roster([lead, supervisor], "ws")).toEqual([
      ["supervisor", "sup", false],
      ["lead", "lead", false],
    ]);
  });

  it("leaves out an archived or unknown parent", () => {
    const archived = makeAgent({ id: "old", workspaceId: "bot-home", archivedAt: new Date() });
    const lead = makeAgent({
      id: "lead",
      workspaceId: "worker",
      parentAgentId: "old",
      labels: { [ROLE]: "lead" },
    });
    const orphan = makeAgent({
      id: "lead-2",
      workspaceId: "worker-2",
      parentAgentId: "missing",
      labels: { [ROLE]: "lead" },
    });
    expect(roster([lead, archived, orphan], "worker")).toEqual([["lead", "lead", false]]);
    expect(roster([lead, archived, orphan], "worker-2")).toEqual([["lead", "lead-2", false]]);
  });
});
