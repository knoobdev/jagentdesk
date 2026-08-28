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

/** A concise, human-facing title for the Supervisor agent, from the objective. */
function orchestrationAgentTitle(rawRequest: string): string {
  const first = rawRequest.split("\n")[0]?.trim() ?? "";
  if (!first) return "Orchestration";
  return first.length > 60 ? `${first.slice(0, 57).trimEnd()}…` : first;
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
    "- You are the Supervisor and the single point of contact for this objective.",
    "- Delegate ONLY when the objective genuinely needs multiple parallel workstreams. If it is a single, self-contained task, COMPLETE IT YOURSELF in this conversation and do NOT create any other agent — spawning a Lead/Peers for a simple task just doubles the token cost for no benefit.",
    "- When (and only when) delegation is warranted: call orchestration.bootstrap_lead exactly once to hand the objective to a Lead; pass the human relay without adding an engineering plan. Then the Lead uses orchestration.create_peer for bounded assignments, orchestration.handback for evidence, orchestration.resolve_dissent for the three allowed outcomes, and orchestration.accept_result after validation.",
    "- If you delegate, never use generic create_agent or send_agent_prompt to bypass the topology, and never dispatch directly to a Peer; report the Lead's accepted result, dissent, counterevidence, validation, and unresolved decisions back to this conversation.",
    `- If delegation is warranted, the requested engineering route is ${prepared.brief.routeCategory}; preferred target is ${prepared.brief.selectedRoute.role}/${prepared.brief.selectedRoute.profileId}.`,
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
      // Give the Supervisor an explicit, meaningful title. Without one the agent
      // (and the whole ORC workspace's sidebar row) falls back to the git branch
      // name — which reads as a bogus "main" agent.
      title: orchestrationAgentTitle(rawRequest),
      labels: {
        [ORCHESTRATION_ROLE_LABEL]: "supervisor",
        "jagentdesk.orchestration.workspace-id": workspaceId,
        "jagentdesk.orchestration.brief-id": prepared.brief.id,
      },
    });
  }
  return { brief: prepared.brief, started: true };
}
