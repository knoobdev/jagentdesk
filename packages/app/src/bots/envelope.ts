import { isBotCreatedKickoff } from "@jagentdesk/protocol/bots/rules";

/** The label the daemon puts on a bot's supervisor agent (`server/bots/daemon-runtime.ts`). */
export const BOT_ID_LABEL = "jagentdesk.bot.id";
/** `home` on a bot's Home Chat agent (`server/bots/runtime.ts` `BOT_ROLE_LABEL`). */
export const BOT_ROLE_LABEL = "jagentdesk.bot.role";

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

/** The source the daemon put on a delivered message, or null without an envelope. */
export function botEnvelopeSource(text: string): string | null {
  const match = BOT_ENVELOPE.exec(text);
  return match ? match[0].slice(1, -2) : null;
}

/**
 * The daemon's turn after a restart cut the bot's reply (`[restart]`; `[resume]` from round-1
 * daemons). Its words are for the agent only; the chat shows a notice in their place, as Orca's
 * NativeChatNoticeRow does for `restartContinued`.
 */
export function isBotRestartWake(text: string): boolean {
  const source = botEnvelopeSource(text);
  return source === "restart" || source === "resume";
}

/**
 * The daemon's kickoff turn to a new bot (`[jagentdesk]` + `BOT_CREATED_KICKOFF`). The owner never
 * typed it, so the chat shows Orca's bot-created row in its place, not a user bubble.
 */
export function isBotKickoffWake(text: string): boolean {
  return botEnvelopeSource(text) === "jagentdesk" && isBotCreatedKickoff(stripBotEnvelope(text));
}

/** `BOT_QUIET_MARKER` (`server/bots/look-around.ts`): a bot ends a reply with it to post nothing. */
const BOT_QUIET_MARKER = "[[quiet]]";

/** A bot reply without its quiet marker; empty when the bot chose to say nothing (Orca shows none). */
export function stripBotQuietMarker(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(BOT_QUIET_MARKER)
    ? trimmed.slice(0, -BOT_QUIET_MARKER.length).trimEnd()
    : text;
}
