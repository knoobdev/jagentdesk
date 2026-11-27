import type { BotsRequest } from "@jagentdesk/protocol/bots/rpc-schemas";
import type { RelayControlHandler } from "../../relay-transport.js";
import type { BotsService } from "../service.js";
import type { BotsSlack } from "../slack.js";
import type { ForgeCli } from "./cli.js";
import type { HookConnectorOptions } from "./connector.js";
import { BotConnectorEvents } from "./events.js";
import { BotsGitHub } from "./github.js";
import { BotsGitLab } from "./gitlab.js";
import { composeRelayControlHandlers } from "./relay-control.js";
import { BotsTelegram } from "./telegram.js";

export type BotsHookRequest = Extract<
  BotsRequest,
  { type: `bots.github.${string}` | `bots.gitlab.${string}` | `bots.telegram.${string}` }
>;
/** One person on a connector's Who can ask, as bt1's `bots.allowed.list` rows (`{source, id, name}`). */
export interface BotAllowedPerson {
  source: "github" | "gitlab" | "telegram";
  id: string;
  name: string;
  username?: string;
}
/** A connector's line on the bot record (`Bot.github | gitlab | telegram`, bt1 contract). */
export interface BotConnectorSummary {
  connected: boolean;
  needsFix?: boolean;
  label?: string;
}

export function isBotsHookRequest(message: BotsRequest): message is BotsHookRequest {
  return /^bots\.(?:github|gitlab|telegram)\./.test(message.type);
}

/** GitHub, GitLab and Telegram connectors of every bot, behind one relay control handler. */
export class BotsHookConnectors {
  readonly events: BotConnectorEvents;
  readonly github: BotsGitHub;
  readonly gitlab: BotsGitLab;
  readonly telegram: BotsTelegram;
  constructor(
    bots: BotsService,
    private readonly slack: BotsSlack | undefined,
    options: Omit<HookConnectorOptions, "events"> & {
      events?: BotConnectorEvents;
      gh?: ForgeCli;
      glab?: ForgeCli;
      telegramApiBaseUrl?: string;
    },
  ) {
    this.events = options.events ?? new BotConnectorEvents();
    const shared = { ...options, events: this.events };
    this.github = new BotsGitHub(bots, { ...shared, gh: options.gh });
    this.gitlab = new BotsGitLab(bots, { ...shared, glab: options.glab });
    this.telegram = new BotsTelegram(bots, { ...shared, apiBaseUrl: options.telegramApiBaseUrl });
    // `bots.allowed.list` merges these with Slack's (bots contract).
    bots.allowedSources.push(async (bot) =>
      this.allowedPeople(bot.id).map(({ source, id, name }) => ({ source, id, name })),
    );
  }
  private get all() {
    return [this.github, this.gitlab, this.telegram];
  }
  /** Slack first, then these: one handler for the relay transport. */
  controlHandler(): RelayControlHandler {
    return composeRelayControlHandlers([...(this.slack ? [this.slack] : []), ...this.all]);
  }
  start(): void {
    for (const connector of this.all) connector.start();
  }
  stop(): void {
    for (const connector of this.all) connector.stop();
  }
  async dispose(): Promise<void> {
    await Promise.all(this.all.map((connector) => connector.dispose()));
  }
  async settled(): Promise<void> {
    await Promise.all(this.all.map((connector) => connector.settled()));
  }
  async disconnect(botId: string): Promise<void> {
    for (const connector of this.all) await connector.disconnect(botId).catch(() => undefined);
  }
  /** "Who can ask" people of GitHub, GitLab and Telegram; bt1's `bots.allowed.list` adds Slack's. */
  allowedPeople(botId: string): BotAllowedPerson[] {
    return [
      ...this.github
        .allowed(botId)
        .map((user): BotAllowedPerson => ({ source: "github", id: user.id, name: user.name })),
      ...this.gitlab
        .allowed(botId)
        .map((user): BotAllowedPerson => ({ source: "gitlab", id: user.id, name: user.name })),
      ...this.telegram.allowed(botId).map(
        (user): BotAllowedPerson => ({
          source: "telegram",
          id: user.id,
          name: user.name,
          username: user.username,
        }),
      ),
    ];
  }
  /** What `bots.list` puts on `Bot.github`, `Bot.gitlab` and `Bot.telegram` (bt1 contract). */
  summaries(botId: string): Record<"github" | "gitlab" | "telegram", BotConnectorSummary> {
    return {
      github: this.github.summary(botId),
      gitlab: this.gitlab.summary(botId),
      telegram: this.telegram.summary(botId),
    };
  }
  async handle(message: BotsHookRequest): Promise<Record<string, unknown>> {
    if (message.type.startsWith("bots.github."))
      return this.github.handle(message as Extract<BotsRequest, { type: `bots.github.${string}` }>);
    if (message.type.startsWith("bots.gitlab."))
      return this.gitlab.handle(message as Extract<BotsRequest, { type: `bots.gitlab.${string}` }>);
    return this.telegram.handle(
      message as Extract<BotsRequest, { type: `bots.telegram.${string}` }>,
    );
  }
}
