// JAgentDesk-only bots strings for the settings surfaces (spec 37), under `bots.jad.settings`.
export const botsJadSettingsStrings = {
  // Spec 37.3.3: shown under Permissions when the mode runs tools without asking.
  bypassWarning: "This bot and its workers will run tools without asking.",
  // Spec 37.3.7 / 37.4.8 item 4: not in Orca.
  reviewBeforeDone: "Review before done",
  reviewBeforeDoneDescription:
    "Before an item is done, BA, Tester and Pentester reviews check the worker’s changes.",
  // Spec 37.4.7: Orca's bots.connectors.emptyNote with JAgentDesk's connectors.
  whoCanAskEmpty: "Let people reach {{name}} in Slack, GitHub, GitLab and Telegram.",
  shareUnavailable: "Sharing isn’t available in this build of JAgentDesk.",
} as const;
