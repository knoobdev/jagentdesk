// What a bot is doing, for its sidebar row, its panel header and the Home tab badge: the Needs you
// count (`bots.needs_you.list`, the same rows the Items section lists), the chat tree's live work,
// and its waits.
import { useMemo } from "react";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { useChatTree, useItems, useNeedsYou } from "./queries";
import { botRowMark, botWorkingCount, selectBotRowLine, type BotRowLine } from "./row-line";

export interface BotLiveState {
  needsYou: number;
  working: number;
  line: BotRowLine;
  mark: ReturnType<typeof botRowMark>;
}

export function useBotLiveState(serverId: string, bot: Bot, now: number): BotLiveState {
  const needs = useNeedsYou(serverId, bot.id);
  const tree = useChatTree(serverId, bot.id);
  const items = useItems(serverId, bot.id);
  const needsYou = needs.data?.length ?? 0;
  return useMemo(() => {
    const line = selectBotRowLine({
      paused: bot.paused,
      needsYou,
      tree: tree.data,
      items: items.data,
      now,
    });
    return { needsYou, working: botWorkingCount(tree.data), line, mark: botRowMark(line) };
  }, [bot.paused, needsYou, tree.data, items.data, now]);
}

/** A minute is fine-grained enough for "until 5 PM" and wait deadlines. */
export function minuteNow(): number {
  return Math.floor(Date.now() / 60_000) * 60_000;
}
