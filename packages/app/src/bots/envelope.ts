/** The label the daemon puts on a bot's supervisor agent (`server/bots/daemon-runtime.ts`). */
export const BOT_ID_LABEL = "jagentdesk.bot.id";

export function botIdFromLabels(labels: Record<string, string> | undefined | null): string | null {
  return labels?.[BOT_ID_LABEL] ?? null;
}

// The daemon delivers each bot message to its supervisor as `[<source>]\n<text>` so the agent
// knows where it came from (chat, room, jira, a Slack event…). The source stays in the agent's
// prompt and in the bot message's `source` field; people only see the text.
const BOT_ENVELOPE = /^\[[^\]\n]{1,64}\]\n/;

export function stripBotEnvelope(text: string): string {
  return text.replace(BOT_ENVELOPE, "");
}
