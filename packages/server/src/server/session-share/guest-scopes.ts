import type { SessionShareCapabilities } from "@jagentdesk/protocol/messages";

// The exact RPC types a session-share guest may exchange, derived from the granted capabilities
// (spec §21 / ADR-0019). The scope allowlist gates BOTH directions: inbound requests the guest may
// send, AND outbound frames the daemon may deliver to the guest (Session.emit drops any type not in
// scope — see the outbound guard). We therefore list the paired *_response types and the live push
// frames explicitly; without them the daemon would silently drop the guest's own responses.
//
// Every agent-scoped type here is additionally confined to the shared agentId by Session's central
// guest guard (guestMessageTouchesOtherAgent), so no cross-agent access is possible in either
// direction. Types WITHOUT an agentId (e.g. the provider/model catalog) carry no agent/workspace
// data and are safe to expose.
//
// NOTE: `files` and `terminal` capabilities are intentionally NOT mapped yet — those RPCs are
// workspace-scoped (not agent-scoped) and need an additional workspace guard before exposure.
export function guestScopesForCapabilities(caps: SessionShareCapabilities): string[] {
  const scopes: string[] = [
    // chat (always). Every type here is agentId-guarded (Session guest guard) or agent/workspace-
    // free, so nothing about other agents leaks — inbound OR via broadcast (see emit guard).
    "fetch_agent_timeline_request",
    "fetch_agent_timeline_response",
    "fetch_agent_history_request",
    "fetch_agent_history_response",
    "agent.timeline.list_prompts.request",
    "agent.timeline.list_prompts.response",
    "agent.timeline.set_subscription.request",
    "agent.timeline.set_subscription.response",
    "send_agent_message_request",
    "send_agent_message_response",
    // the shared agent's snapshot (agentId-guarded single fetch).
    "fetch_agent_request",
    "fetch_agent_response",
    // Host directory bootstraps the app runs on connect. For guests these are FILTERED server-side
    // to the one shared agent / empty projects (see handleFetchAgents + project.list) so nothing
    // about other agents/workspaces leaks — needed so the runtime reaches "online" and renders.
    "fetch_agents_request",
    "fetch_agents_response",
    "project.list.request",
    "project.list.response",
    // model catalog (no agent/workspace data) so the composer can show model names.
    "get_providers_snapshot_request",
    "get_providers_snapshot_response",
    "providers_snapshot_update",
    // live chat push frames — each agentId-guarded, so only the shared agent's stream reaches the
    // guest. Without these the transcript would never update after the initial timeline fetch.
    "agent_stream",
    "agent_update",
    "agent_attention_required",
  ];
  if (caps.files) {
    // Read-only file + diff surface, confined to the shared agent's workspace root by Session's
    // file-containment guard (isGuestFileMessageWithinWorkspace). WRITE types (fs.file.write,
    // checkout_commit) are deliberately absent, so the guest can view but never mutate. Download
    // tokens are omitted too — the download endpoint lives on the main Tailscale-only daemon, not the
    // tunnel, so file content reaches the guest inline via file_explorer mode:"file" / fs.file.update.
    scopes.push(
      "file_explorer_request",
      "file_explorer_response",
      "fs.file.subscribe.request",
      "fs.file.subscribe.response",
      "fs.file.unsubscribe.request",
      "fs.file.unsubscribe.response",
      "fs.file.update",
      "subscribe_checkout_diff_request",
      "subscribe_checkout_diff_response",
      "unsubscribe_checkout_diff_request",
      "checkout_diff_update",
    );
  }
  if (caps.terminal) {
    // Read-only terminal viewing, confined to the shared agent's workspace root by Session's
    // terminal-containment guard (cwd-keyed list/subscribe + terminalId-keyed subscribe/capture
    // resolved to the terminal's cwd). WRITE types (create_terminal, terminal_input, kill_terminal,
    // terminal.rename) are deliberately absent, so the guest can watch output but never type into,
    // spawn, or kill a terminal. Live output streams over the binary channel (not a JSON type).
    scopes.push(
      "list_terminals_request",
      "list_terminals_response",
      "subscribe_terminals_request",
      "unsubscribe_terminals_request",
      "terminals_changed",
      "subscribe_terminal_request",
      "subscribe_terminal_response",
      "unsubscribe_terminal_request",
      "capture_terminal_request",
      "capture_terminal_response",
    );
  }
  if (caps.modelMode) {
    scopes.push(
      "set_agent_mode_request",
      "set_agent_mode_response",
      "set_agent_model_request",
      "set_agent_model_response",
      "cancel_agent_request",
      "cancel_agent_response",
    );
  }
  return scopes;
}
