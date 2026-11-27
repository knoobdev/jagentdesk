import type { BotAllowedEntry, BotsRequest } from "@jagentdesk/protocol/bots/rpc-schemas";
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

export type BotsHookRequest =
  | Extract<
      BotsRequest,
      { type: `bots.github.${string}` | `bots.gitlab.${string}` | `bots.telegram.${string}` }
    >
  | Extract<BotsRequest, { type: "bots.allowed.list.request" }>;

export function isBotsHookRequest(message: BotsRequest): message is BotsHookRequest {
  return (
    /^bots\.(?:github|gitlab|telegram)\./.test(message.type) ||
    message.type === "bots.allowed.list.request"
  );
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
  /** "Who can ask": every connector's allow-list (ADR-0061 §6 `bots.allowed.list`). */
  allowed(botId: string): BotAllowedEntry[] {
    const entries: BotAllowedEntry[] = [];
    const lists: [string, readonly { id: string; name: string; username?: string }[]][] = [
      ["slack", this.slack?.status(botId).allowedUsers ?? []],
      ["github", this.github.allowed(botId)],
      ["gitlab", this.gitlab.allowed(botId)],
      ["telegram", this.telegram.allowed(botId)],
    ];
    for (const [connector, users] of lists)
      for (const user of users) entries.push({ connector, ...user });
    return entries;
  }
  async handle(message: BotsHookRequest): Promise<Record<string, unknown>> {
    if (message.type === "bots.allowed.list.request")
      return { allowed: this.allowed(message.botId) };
    if (message.type.startsWith("bots.github."))
      return this.github.handle(message as Extract<BotsRequest, { type: `bots.github.${string}` }>);
    if (message.type.startsWith("bots.gitlab."))
      return this.gitlab.handle(message as Extract<BotsRequest, { type: `bots.gitlab.${string}` }>);
    return this.telegram.handle(
      message as Extract<BotsRequest, { type: `bots.telegram.${string}` }>,
    );
  }
}
