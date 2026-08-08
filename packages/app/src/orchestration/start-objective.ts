import {
  ORCHESTRATION_ROLE_LABEL,
  type OrchestrationConfig,
  type OrchestrationTaskBrief,
} from "@jagentdesk/protocol/orchestration";
import { type Agent, useSessionStore } from "@/stores/session-store";
import type { useHostRuntimeClient } from "@/runtime/host-runtime";

type OrchestrationClient = NonNullable<ReturnType<typeof useHostRuntimeClient>>;

/**
 * Shared handler for the `/orc <request>` client slash command. Used by both the
 * active-agent composer and the workspace draft composer so `/orc` behaves the same
 * everywhere (find/reuse the Supervisor, prepare the brief, start the run) instead of
 * falling through and being sent to a provider as a literal message ("unknown command").
 */
export async function runOrchestrateClientCommand(deps: {
  client: OrchestrationClient | null | undefined;
  config: OrchestrationConfig | null | undefined;
  cwd: string | null | undefined;
  serverId: string;
  workspaceId: string;
  rawRequest: string;
}): Promise<void> {
  const { client, config, cwd, serverId, workspaceId, rawRequest } = deps;
  if (!client || !cwd || !config) {
    throw new Error("Connect to the host and open a workspace before using /orc.");
  }
  const sessions = useSessionStore.getState().sessions[serverId];
  const supervisor = sessions
    ? Array.from(sessions.agents.values()).find(
        (agent) =>
          agent.workspaceId === workspaceId &&
          agent.labels[ORCHESTRATION_ROLE_LABEL] === "supervisor",
      )
    : undefined;
  const { brief, started } = await startOrchestrationObjective({
    client,
    config,
    cwd,
    workspaceId,
    supervisor,
    rawRequest,
  });
  if (!started) {
    throw new Error(
      `Needs clarification before orchestration can start: ${brief.openQuestions.join(" ")}`,
    );
  }
}

export async function startOrchestrationObjective(deps: {
  client: OrchestrationClient;
  config: OrchestrationConfig;
  cwd: string;
  workspaceId: string;
  supervisor: Agent | undefined;
  rawRequest: string;
}): Promise<{ brief: OrchestrationTaskBrief; started: boolean }> {
  const { client, config, cwd, workspaceId, supervisor } = deps;
  const rawRequest = deps.rawRequest.trim();
  if (!rawRequest) {
    throw new Error("Enter what the team should do.");
  }
  if (!config.enabled || !config.roles.supervisor.enabled) {
    throw new Error("Orchestration or the Supervisor role is disabled in Host > Orchestration.");
  }
  const prepared = await client.prepareOrchestrationTask({ rawRequest, workspaceId, cwd });
  if (prepared.brief.status === "needs_clarification") {
    return { brief: prepared.brief, started: false };
  }
  const profile = config.roles.supervisor.profiles.find(
    (candidate) => candidate.id === config.roles.supervisor.defaultProfileId,
  );
  if (!profile) {
    throw new Error("The configured Supervisor default profile is missing.");
  }
  const prompt = [
    prepared.brief.normalizedPrompt,
    "",
    "Runtime contract:",
    "- You are the Supervisor. Own the human objective and do not perform bounded implementation yourself.",
    "- Call orchestration.bootstrap_lead exactly once when this run has no healthy Lead; pass the human relay without adding an engineering plan.",
    "- Never use generic create_agent or send_agent_prompt to bypass the topology, and never dispatch directly to a Peer.",
    "- The Lead must use orchestration.create_peer for bounded assignments, orchestration.handback for evidence, orchestration.resolve_dissent for the three allowed outcomes, and orchestration.accept_result after validation.",
    "- Report the Lead's accepted result, dissent, counterevidence, validation, and unresolved decisions back to this conversation.",
    `- The requested engineering route is ${prepared.brief.routeCategory}; preferred target is ${prepared.brief.selectedRoute.role}/${prepared.brief.selectedRoute.profileId}.`,
    `- The daemon enforces a maximum of ${config.limits.maxPeersPerLead} bounded Peer assignments for this run.`,
  ].join("\n");
  if (supervisor) {
    if (supervisor.labels["jagentdesk.orchestration.brief-id"] !== prepared.brief.id) {
      await client.updateAgent(supervisor.id, {
        labels: { "jagentdesk.orchestration.brief-id": prepared.brief.id },
      });
    }
    await client.sendAgentMessage(supervisor.id, prompt);
  } else {
    await client.createAgent({
      provider: profile.provider,
      cwd,
      workspaceId,
      model: profile.model,
      thinkingOptionId: profile.thinkingOptionId,
      initialPrompt: prompt,
      labels: {
        [ORCHESTRATION_ROLE_LABEL]: "supervisor",
        "jagentdesk.orchestration.workspace-id": workspaceId,
        "jagentdesk.orchestration.brief-id": prepared.brief.id,
      },
    });
  }
  return { brief: prepared.brief, started: true };
}
