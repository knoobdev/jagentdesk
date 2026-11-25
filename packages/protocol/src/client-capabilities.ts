export const CLIENT_CAPS = {
  terminalChunkedReplay: "terminal_chunked_replay",
  binaryChunkingV1: "binary_chunking_v1",
  pluginBinaryPayloads: "plugin_binary_payloads",
  explicitEventSubscriptions: "explicit_event_subscriptions",
  // COMPAT(pluginTimelineItems): added in v0.9.59; remove after 2027-05-23 once the client floor supports plugin items.
  pluginTimelineItems: "plugin_timeline_items",
  // COMPAT(timelineNotifications): added in v0.9.59; remove after 2027-05-23 once the client floor supports notifications.
  timelineNotifications: "timeline_notifications",
  // COMPAT(selectiveAgentTimeline): added in v0.1.106. Capable clients receive
  // agent streams only for their explicit viewed set. Remove after 2027-01-12
  // once the supported client floor is >= v0.1.106.
  selectiveAgentTimeline: "selective_agent_timeline",
  reasoningMergeEnum: "reasoning_merge_enum",
  // COMPAT(customModeIcons): added in v0.1.84. Old clients pin AgentModeIcon to
  // a closed enum and crash rendering unknown values; daemon downgrades icons
  // outside the legacy set to "ShieldCheck" when this cap is absent. Drop the
  // gate when floor >= v0.1.84.
  customModeIcons: "custom_mode_icons",
  // COMPAT(terminalReflowableSnapshot): added in v0.1.88. The daemon attaches
  // per-row soft-wrap flags (gridWrapped/scrollbackWrapped) to terminal snapshots
  // only when the client advertises this, so restored content can reflow on resize.
  // Old clients use a strict TerminalState schema and would reject the extra fields.
  // Drop the gate (always send the flags) when floor >= v0.1.88.
  terminalReflowableSnapshot: "terminal_reflowable_snapshot",
  // COMPAT(providerSubagents): added in v0.1.107. The daemon emits provider-owned
  // child descriptors and timelines only to clients that understand the new messages.
  providerSubagents: "provider_subagents",
  // COMPAT(projectedSubagentTimeline): added after v0.8.0, remove gates after 2027-03-14; retain wire capability.
  projectedSubagentTimeline: "projected_subagent_timeline",
  // COMPAT(projectUpdates): added in v0.1.109, remove gate after 2027-01-15.
  projectUpdates: "project_updates",
  // COMPAT(compactProviderSnapshots): added in v0.2.X. Capable clients receive
  // provider catalogs with shared thinking sets and may revalidate by content hash.
  // Remove the legacy snapshot encoding after 2027-02-04.
  compactProviderSnapshots: "compact_provider_snapshots",
  // COMPAT(timelineReplacementInvalidation): added in v0.5.0, remove legacy
  // reconstructed timeline replay after 2027-02-21 once the client floor supports invalidation.
  timelineReplacementInvalidation: "timeline_replacement_invalidation",
  // COMPAT(backgroundAgents): added in v0.9.59, remove after 2027-05-24.
  backgroundAgents: "background_agents",
  browserHost: "browser_host",
  // Spec mode (spec 28.6): only clients that render the Phase review bar may turn it on.
  specMode: "spec_mode",
  // Argo CD SSO (spec 30.2.2): only the Electron desktop advertises it — it can open the
  // 127.0.0.1:8085 loopback listener, so the daemon routes mobile SSO delegation to it.
  argocdSsoLoopback: "argocd_sso_loopback",
  // Spec 27.7 / ADR-0033: the client decodes live device screens pushed as binary JPEG frames
  // (opcode 0x20). Clients without it keep polling simulator/screenshot.
  binaryScreenFrames: "binary_screen_frames",
  // COMPAT(agentActiveTurnBehaviors): added in v0.9.59, remove after 2027-05-24 once client floor >= v0.9.59.
  // An agent sender's steer means wait-for-turn-end from clients without it, because older
  // CLIs and connected hosts send an explicit steer for every default agent send.
  agentActiveTurnBehaviors: "agent_active_turn_behaviors",
} as const;

export type ClientCapability = (typeof CLIENT_CAPS)[keyof typeof CLIENT_CAPS];
