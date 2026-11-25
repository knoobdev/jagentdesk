// Spec 27.6: an agent's "view and control <device>" answer lasts until its session ends. The
// session ends when the agent is closed or archived (lifecycle "closed", no session) or when a
// new provider session replaces the old one (reload, resume); either way the grants go.

export interface AgentStateEvent {
  type: string;
  agent?: { id: string; lifecycle: string; session: object | null };
}

export type SubscribeAgentEvents = (callback: (event: AgentStateEvent) => void) => () => void;

export function clearGrantsWhenSessionsEnd(
  subscribe: SubscribeAgentEvents,
  grants: { forgetAgent(agentId: string): void },
): () => void {
  const sessions = new Map<string, object>();
  return subscribe((event) => {
    if (event.type !== "agent_state" || !event.agent) return;
    const { id, lifecycle, session } = event.agent;
    if (lifecycle === "closed" || session === null) {
      sessions.delete(id);
      grants.forgetAgent(id);
      return;
    }
    const previous = sessions.get(id);
    if (previous && previous !== session) grants.forgetAgent(id);
    sessions.set(id, session);
  });
}
