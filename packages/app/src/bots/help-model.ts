/** Keys of the "How to ask" lines. The Slack line only applies once the bot's Slack app is connected. */
export function howToAskKeys(slackConnected: boolean): string[] {
  return slackConnected ? ["bots.help.chat", "bots.help.slack"] : ["bots.help.chat"];
}

export interface HelpSegment {
  text: string;
  code: boolean;
  /** Offset in the translated sentence; a stable key. */
  start: number;
}

/** Stands in for the bot name while a sentence is translated; `helpSegments` fills it in. */
export const NAME_SLOT = "\u0000";

/**
 * Splits a translated sentence on its `<code>…</code>` parts (Orca's How to ask markup).
 * Translate with `{ name: NAME_SLOT }` and pass the real name here: the name is filled in after
 * the split, so a bot name holding `<code>` stays plain text.
 */
export function helpSegments(translated: string, name: string): HelpSegment[] {
  const segments: HelpSegment[] = [];
  const push = (text: string, code: boolean, start: number) =>
    segments.push({ text: text.split(NAME_SLOT).join(name), code, start });
  const pattern = /<code>(.*?)<\/code>/g;
  let index = 0;
  for (const match of translated.matchAll(pattern)) {
    if (match.index > index) push(translated.slice(index, match.index), false, index);
    push(match[1], true, match.index);
    index = match.index + match[0].length;
  }
  if (index < translated.length) push(translated.slice(index), false, index);
  return segments;
}
