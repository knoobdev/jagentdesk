// The Connectors tab's four rows in order (spec 37.4.7) and what each one says, from the bot's
// connector summaries (`Bot.slack|github|gitlab|telegram`). Ported from Orca dfdb4fda (MIT)
// src/renderer/src/components/bots/bot-connector-entries.ts and bot-connector-need.ts, limited to the
// connectors JAgentDesk has.
import type { Bot } from "@jagentdesk/protocol/bots/types";

export type BotConnectorId = "slack" | "github" | "gitlab" | "telegram";
export const BOT_CONNECTOR_IDS: readonly BotConnectorId[] = [
  "slack",
  "github",
  "gitlab",
  "telegram",
];
export const BOT_CONNECTOR_NAMES: Record<BotConnectorId, string> = {
  slack: "Slack",
  github: "GitHub",
  gitlab: "GitLab",
  telegram: "Telegram",
};

/** The i18n key of a row's description; GitHub and GitLab take `{{folder}}`. */
export const BOT_CONNECTOR_DESCRIPTION_KEYS: Record<BotConnectorId, string> = {
  slack: "bots.connectors.slack",
  github: "bots.jad.panels.connectors.githubLine",
  gitlab: "bots.jad.panels.connectors.gitlabLine",
  telegram: "bots.jad.panels.connectors.telegramLine",
};

export interface BotConnectorRowView {
  id: BotConnectorId;
  name: string;
  connected: boolean;
  needsFix: boolean;
  label: string | null;
}

export function botConnectorRows(bot: Pick<Bot, BotConnectorId>): BotConnectorRowView[] {
  return BOT_CONNECTOR_IDS.map((id) => {
    const summary = bot[id];
    return {
      id,
      name: BOT_CONNECTOR_NAMES[id],
      connected: summary?.connected === true,
      needsFix: summary?.needsFix === true,
      label: summary?.label ?? null,
    };
  });
}

/** Connectors that need the owner (signature failures, revoked token, hook deleted at the source). */
export function botConnectorsNeedFix(bot: Pick<Bot, BotConnectorId>): number {
  return botConnectorRows(bot).filter((row) => row.needsFix).length;
}
