import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@jagentdesk/protocol/agent-labels";
import {
  ORCHESTRATION_BRIEF_LABEL,
  ORCHESTRATION_ROLE_LABEL,
  ORCHESTRATION_WORKSPACE_LABEL,
  createDefaultOrchestrationConfig,
  type OrchestrationConfig,
} from "@jagentdesk/protocol/orchestration";
import type { Logger } from "pino";
import { createAgentCommand } from "../agent/create-agent/create.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { ManagedAgent } from "../agent/agent-manager.js";
import { OrchestrationRuntime } from "./runtime.js";

vi.mock("../agent/create-agent/create.js", () => ({ createAgentCommand: vi.fn() }));
vi.mock("../agent/agent-prompt.js", () => ({ sendPromptToAgent: vi.fn() }));

function fakeLogger(): Logger {
  const logger = { child: () => logger };
  return logger as unknown as Logger;
}

function makeAgent(input: {
  id: string;
  provider: string;
  model: string;
  workspaceId: string;
  labels: Record<string, string>;
}): ManagedAgent {
  return {
    id: input.id,
    provider: input.provider,
    cwd: "/workspace",
    workspaceId: input.workspaceId,
    config: {
      provider: input.provider,
      cwd: "/workspace",
      model: input.model,
      thinkingOptionId: "max",
    },
    labels: input.labels,
    lifecycle: "idle",
    session: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: false,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    runtimeInfo: undefined,
    createdAt: new Date(),
    updatedAt: new Date(),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: new Map(),
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    attention: { requiresAttention: false },
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
  } as ManagedAgent;
}

describe("OrchestrationRuntime", () => {
  let home: string;
  let config: OrchestrationConfig;
  let agents: Map<string, ManagedAgent>;
  let runtime: OrchestrationRuntime;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "jagentdesk-orchestration-"));
    config = createDefaultOrchestrationConfig();
    agents = new Map();
    const supervisor = makeAgent({
      id: "supervisor-1",
      provider: "codex",
      model: "gpt-5.6-luna",
      workspaceId: "workspace-1",
      labels: {
        [ORCHESTRATION_ROLE_LABEL]: "supervisor",
        [ORCHESTRATION_WORKSPACE_LABEL]: "workspace-1",
        [ORCHESTRATION_BRIEF_LABEL]: "brief-1",
      },
    });
    agents.set(supervisor.id, supervisor);

    vi.mocked(createAgentCommand).mockImplementation(async (_dependencies, input) => {
      if (input.kind !== "mcp") throw new Error("test only covers MCP creation");
      const [provider, model] = input.provider.split("/", 2);
      const agent = makeAgent({
        id: `${input.labels?.[ORCHESTRATION_ROLE_LABEL] ?? "agent"}-${agents.size + 1}`,
        provider,
        model,
        workspaceId: input.workspaceId ?? "workspace-1",
        labels: {
          ...(input.labels ?? {}),
          [PARENT_AGENT_ID_LABEL]: input.callerAgentId ?? "",
        },
      });
      agents.set(agent.id, agent);
      return {
        snapshot: agent,
        liveSnapshot: agent,
        background: true,
        initialPromptStarted: true,
        initialPromptError: null,
      };
    });

    const agentManager = {
      getAgent: (id: string) => agents.get(id) ?? null,
      listAgents: () => [...agents.values()],
      setLabels: async (id: string, patch: Record<string, string>) => {
        const agent = agents.get(id);
        if (!agent) throw new Error(`Agent ${id} not found`);
        agent.labels = { ...agent.labels, ...patch };
      },
    };
    runtime = new OrchestrationRuntime({
      jagentdeskHome: home,
      agentManager: agentManager as never,
      agentStorage: {} as never,
      providerSnapshotManager: {} as never,
      getConfig: () => config,
      logger: fakeLogger(),
    });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test("bootstraps one Lead, caps Peer fan-out, and carries handback to Lead", async () => {
    const lead = await runtime.bootstrapLead({
      callerAgentId: "supervisor-1",
      assignment: "Own the engineering objective and return evidence.",
    });
    expect(lead.reused).toBe(false);

    const reused = await runtime.bootstrapLead({
      callerAgentId: "supervisor-1",
      assignment: "Do not create another Lead.",
    });
    expect(reused.agentId).toBe(lead.agentId);
    expect(reused.reused).toBe(true);

    const peerResults = [];
    for (let index = 0; index < config.limits.maxPeersPerLead; index += 1) {
      peerResults.push(
        await runtime.createPeer({
          callerAgentId: lead.agentId,
          routeCategory: "impl",
          assignment: `Bounded assignment ${index + 1}`,
          ownershipBoundary: "Only inspect and change the assigned surface.",
          expectedHandback: "Return tests and file references.",
        }),
      );
    }
    expect(peerResults).toHaveLength(3);
    await expect(
      runtime.createPeer({
        callerAgentId: lead.agentId,
        routeCategory: "impl",
        assignment: "This must be rejected by the fan-out bound.",
        ownershipBoundary: "One bounded surface.",
        expectedHandback: "Evidence.",
      }),
    ).rejects.toThrow("Peer fan-out limit reached");

    const handback = await runtime.recordHandback({
      callerAgentId: peerResults[0].agentId,
      handback: {
        whatChangedOrInspected: "Inspected the assigned files.",
        evidence: "Targeted test passed.",
        remainingUncertainty: "No uncertainty in the bounded surface.",
        counterevidence: "No counterevidence found.",
        requestedResolution: "Lead may accept or request one verification round.",
      },
    });
    expect(handback.leadAgentId).toBe(lead.agentId);
    expect(sendPromptToAgent).toHaveBeenCalled();
  });

  test("allows one evidence round for dissent and rejects a second one", async () => {
    const lead = await runtime.bootstrapLead({
      callerAgentId: "supervisor-1",
      assignment: "Own the objective.",
    });
    const peer = await runtime.createPeer({
      callerAgentId: lead.agentId,
      routeCategory: "audit",
      assignment: "Audit the bounded change.",
      ownershipBoundary: "Review only the requested surface.",
      expectedHandback: "Return evidence and counterevidence.",
    });

    const first = await runtime.resolveDissent({
      callerAgentId: lead.agentId,
      peerAgentId: peer.agentId,
      outcome: "NEEDS_MORE_EVIDENCE",
      rationale: "The claim is material but can be checked once.",
      nextAction: "Run the bounded verification and hand back the result.",
    });
    expect(first.verificationRound).toBe(1);
    await expect(
      runtime.resolveDissent({
        callerAgentId: lead.agentId,
        peerAgentId: peer.agentId,
        outcome: "NEEDS_MORE_EVIDENCE",
        rationale: "No second debate loop.",
        nextAction: "Escalate or resolve with the evidence already collected.",
      }),
    ).rejects.toThrow("Only one bounded NEEDS_MORE_EVIDENCE round");
  });

  test("a prior resolved dissent does not consume the evidence round", async () => {
    const lead = await runtime.bootstrapLead({
      callerAgentId: "supervisor-1",
      assignment: "Own the objective.",
    });
    const peer = await runtime.createPeer({
      callerAgentId: lead.agentId,
      routeCategory: "audit",
      assignment: "Audit the bounded change.",
      ownershipBoundary: "Review only the requested surface.",
      expectedHandback: "Return evidence and counterevidence.",
    });

    await runtime.resolveDissent({
      callerAgentId: lead.agentId,
      peerAgentId: peer.agentId,
      outcome: "RESOLVED_BY_LEAD",
      rationale: "Closed the first concern with existing evidence.",
      nextAction: "Continue with the accepted direction.",
    });

    const evidence = await runtime.resolveDissent({
      callerAgentId: lead.agentId,
      peerAgentId: peer.agentId,
      outcome: "NEEDS_MORE_EVIDENCE",
      rationale: "A new material claim needs one bounded check.",
      nextAction: "Run the verification and hand back the result.",
    });
    expect(evidence.verificationRound).toBe(1);

    await expect(
      runtime.resolveDissent({
        callerAgentId: lead.agentId,
        peerAgentId: peer.agentId,
        outcome: "NEEDS_MORE_EVIDENCE",
        rationale: "No second debate loop.",
        nextAction: "Escalate or resolve with the evidence already collected.",
      }),
    ).rejects.toThrow("Only one bounded NEEDS_MORE_EVIDENCE round");
  });

  test("reuses the single workspace Lead for a subsequent brief", async () => {
    const lead = await runtime.bootstrapLead({
      callerAgentId: "supervisor-1",
      assignment: "Own the first objective.",
    });
    const nextSupervisor = makeAgent({
      id: "supervisor-2",
      provider: "codex",
      model: "gpt-5.6-luna",
      workspaceId: "workspace-1",
      labels: {
        [ORCHESTRATION_ROLE_LABEL]: "supervisor",
        [ORCHESTRATION_WORKSPACE_LABEL]: "workspace-1",
        [ORCHESTRATION_BRIEF_LABEL]: "brief-2",
      },
    });
    agents.set(nextSupervisor.id, nextSupervisor);

    const reused = await runtime.bootstrapLead({
      callerAgentId: nextSupervisor.id,
      assignment: "Own the second objective with the existing engineering owner.",
    });

    expect(reused).toMatchObject({ agentId: lead.agentId, reused: true });
    expect(agents.get(lead.agentId)?.labels[ORCHESTRATION_BRIEF_LABEL]).toBe("brief-2");
    expect(sendPromptToAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: lead.agentId,
        prompt: expect.stringContaining("second objective"),
      }),
    );
  });
});
