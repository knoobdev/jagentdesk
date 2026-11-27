import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { Logger } from "pino";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotStorage } from "./storage.js";
import type { BotTrigger, BotTriggerSource } from "./service.js";
/** A feature-owned source (for example a built-in plugin's); listed only while it is enabled. */
export interface ExternalBotTriggerSource {
  name: string;
  poll(
    bot: Bot,
    context: {
      now: number;
      state(key: string): number | undefined;
      setState(key: string, value: number): void;
    },
  ): Promise<BotTrigger[]>;
}
const exec = promisify(execFile);
export type GhCommand = (args: string[]) => Promise<string>;
export const runGh: GhCommand = async (args) =>
  (
    await exec("gh", args, {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: "1" },
    })
  ).stdout;
/** The first-run screen's `"GitHub: {{count}} open PRs of yours"`; null when `gh` is not signed in. */
export async function countOwnOpenPullRequests(gh: GhCommand = runGh): Promise<number | null> {
  try {
    await gh(["auth", "status"]);
  } catch {
    return null;
  }
  const rows = z
    .array(z.object({ number: z.number() }))
    .parse(
      JSON.parse(
        await gh([
          "search",
          "prs",
          "--author",
          "@me",
          "--state",
          "open",
          "--json",
          "number",
          "--limit",
          "100",
        ]),
      ),
    );
  return rows.length;
}
export class LocalBotTriggers implements BotTriggerSource {
  private readonly polling = new Set<string>();
  constructor(
    private readonly deps: {
      storage: BotStorage;
      sources?: () => readonly ExternalBotTriggerSource[];
      now?: () => number;
      logger?: Pick<Logger, "warn">;
    },
  ) {}
  async poll(bot: Bot): Promise<BotTrigger[]> {
    if (this.polling.has(bot.id)) return [];
    this.polling.add(bot.id);
    try {
      const external = this.deps.sources?.() ?? [];
      const storage = this.deps.storage;
      // GitHub reaches bots through the webhook (spec 37.10); the round-1 five-minute `gh`
      // poll is gone (spec 37.2.6, ADR-0061 §2).
      const results = await Promise.allSettled(
        external.map((source) =>
          source.poll(bot, {
            now: this.deps.now?.() ?? Date.now(),
            state: (key) => storage.state(key, z.number()),
            setState: (key, value) => storage.setState(key, value),
          }),
        ),
      );
      const names = external.map((source) => source.name);
      const events: BotTrigger[] = [];
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") events.push(...result.value);
        else
          this.deps.logger?.warn(
            { err: result.reason, botId: bot.id, source: names[index] },
            "Bot trigger source failed",
          );
      }
      return events;
    } finally {
      this.polling.delete(bot.id);
    }
  }
}
