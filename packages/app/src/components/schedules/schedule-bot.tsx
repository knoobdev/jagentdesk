// A bot's automation on the Schedules screen (spec 37.2.6): a core schedule carrying `bot`. Its row
// shows the bot's mascot and name; it is created and changed only in the bot's chat, so "Edit"
// opens that chat with a draft instead of the schedule form.
import { useCallback } from "react";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { ScheduleBot } from "@jagentdesk/protocol/schedule/types";
import { i18n } from "@/i18n/i18next";
import { BotAvatar } from "@/bots/avatar";
import { useBotsRead } from "@/bots/queries";
import { openBot } from "@/bots/navigation";
import { prefillHomeChat } from "@/bots/home-chat-draft";

/** The host's bot by id, from the same `bots.list` read the sidebar uses. */
export function useScheduleBot(serverId: string, botId: string | undefined): Bot | undefined {
  const select = useCallback(
    (payload: { bots: Bot[] }) => payload.bots.find((bot) => bot.id === botId),
    [botId],
  );
  return useBotsRead(serverId, "bots.list.request", {}, { enabled: Boolean(botId), select }).data;
}

export function scheduleBotName(bot: Pick<Bot, "name"> | undefined): string {
  return bot?.name ?? i18n.t("bots.jad.schedulesScreen.unknownBot");
}

/** Where its runs go, with the bot's name: "Helper · Home Chat". */
export function scheduleBotTargetLabel(bot: ScheduleBot, name: string): string {
  switch (bot.runsIn) {
    case "chat":
      return i18n.t("bots.jad.schedulesScreen.runsIn.chat", { name });
    case "new":
      return i18n.t("bots.jad.schedulesScreen.runsIn.new", { name });
    default:
      return i18n.t("bots.jad.schedulesScreen.runsIn.home", { name });
  }
}

/** "Edit in {{bot}}'s chat": the bot's Home Chat, its composer holding a draft, nothing sent. */
export function editScheduleInBotChat(input: {
  serverId: string;
  botId: string;
  scheduleName: string;
}): void {
  prefillHomeChat(
    input.serverId,
    input.botId,
    i18n.t("bots.jad.schedulesScreen.editDraft", { name: input.scheduleName }),
  );
  openBot(input.serverId, input.botId, { tab: "home" });
}

export function ScheduleBotGlyph({
  serverId,
  bot,
  size,
}: {
  serverId: string;
  bot: Bot | undefined;
  size: number;
}) {
  if (!bot) return null;
  return <BotAvatar bot={bot} serverId={serverId} size={size} testID={`schedule-bot-${bot.id}`} />;
}
