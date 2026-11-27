// JAgentDesk-only bots strings for the Schedules screen (spec 37.2.6, 37.4.4), under
// `bots.jad.schedulesScreen`. A bot's automations are core schedules: listed there with the bot,
// filtered by the bot from its panel's "All {{count}} automations", changed only in its chat.
export const botsJadSchedulesStrings = {
  filterLabel: "Bot",
  allSchedules: "All schedules",
  filteredBy: "{{name}}'s automations",
  removeFilter: "Remove filter {{name}}",
  unknownBot: "Bot",
  runsIn: {
    home: "{{name}} · Home Chat",
    chat: "{{name}} · one of its chats",
    new: "{{name}} · a new conversation",
  },
  editInChat: "Edit in {{name}}'s chat",
  editDraft: 'Change the automation "{{name}}" so that ',
  botPaused: "Bot paused",
  skippedWhilePaused: "Skipped while {{name}} is paused",
  empty: "{{name}} has no automations yet. Ask it in chat to run something on a schedule.",
  updateHost: "Update {{host}} to see its bots' automations here.",
} as const;
