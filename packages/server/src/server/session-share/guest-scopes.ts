import type { SessionShareCapabilities } from "@jagentdesk/protocol/messages";

// The exact RPC types a session-share guest may send, derived from the granted capabilities
// (spec §21 / ADR-0019). Every agent-scoped type here is additionally confined to the shared
// agentId by Session's central guest guard, so no cross-agent access is possible. Types WITHOUT an
// agentId (e.g. the provider/model catalog) are safe to expose (no agent/workspace data).
//
// NOTE: `files` and `terminal` capabilities are intentionally NOT mapped yet — those RPCs are
// workspace-scoped (not agent-scoped) and need an additional workspace guard before exposure.
export function guestScopesForCapabilities(caps: SessionShareCapabilities): string[] {
  const scopes: string[] = [
    // chat (always). Every type here is agentId-guarded (Session guest guard) or agent/workspace-
    // free, so nothing about other agents leaks — inbound OR via broadcast (see emit guard).
    "fetch_agent_timeline_request",
    "fetch_agent_history_request",
    "agent.timeline.list_prompts.request",
    "agent.timeline.set_subscription.request",
    "send_agent_message_request",
    // the shared agent's snapshot (agentId-guarded single fetch).
    "fetch_agent_request",
    // model catalog (no agent/workspace data) so the composer can show model names.
    "get_providers_snapshot_request",
  ];
  if (caps.modelMode) {
    scopes.push("set_agent_mode_request", "set_agent_model_request", "cancel_agent_request");
  }
  return scopes;
}
