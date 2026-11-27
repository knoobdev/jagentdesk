/**
 * Spec 42 §4 system instruction, next to the session ledger instruction. Static for the life of a
 * session, so the system prompt (and the provider's prompt cache) stays the same between turns.
 */
export const LESSON_INSTRUCTION = [
  "Learn from corrections: when the user corrects or contradicts you, or you find you were wrong and have confirmed the right way,",
  'call remember with kind "lesson" in that same turn: one sentence written as the rule to follow, with citations (the file that',
  "proves it, and a short exact excerpt when you can). Never save a lesson that is not confirmed yet. When a lesson or memory you",
  "were given clearly helped or misled you, call rate_memory with its id.",
].join(" ");

/**
 * Spec 42 §2b: the agent knows its own id. A long-lived agent was asked about "agent <its own id>"
 * and searched ~/.claude and ~/.codex for it instead of reading its own timeline. Built once per
 * launch, so the system prompt stays the same between turns.
 */
export function agentIdentityInstruction(input: {
  agentId: string;
  title: string | null | undefined;
  cwd: string;
  /** False when the JAgentDesk tools are off for this provider. */
  agentTools: boolean;
}): string {
  const title = input.title?.trim();
  const lines = [
    `You are JAgentDesk agent ${input.agentId}${title ? ` ("${title}")` : ""} in workspace ${input.cwd}.`,
    "A UUID the user mentions as an agent is a JAgentDesk agent. When it is your own id, answer from your own session ledger and timeline.",
  ];
  lines.push(
    input.agentTools
      ? "Read another agent's history with the JAgentDesk tool get_agent_activity and its id (it covers archived agents and agents on other providers, and pages older entries with beforeSeq; list_agents finds the ids of agents that are not archived); never search provider session folders such as ~/.claude or ~/.codex for it."
      : "Never search provider session folders such as ~/.claude or ~/.codex for an agent's history.",
  );
  return lines.join(" ");
}
