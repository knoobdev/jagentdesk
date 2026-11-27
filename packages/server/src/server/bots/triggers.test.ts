import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { BotStorage } from "./storage.js";
import { LocalBotTriggers } from "./triggers.js";

it("delivers the other sources' triggers when one source fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "bots-trigger-"));
  const storage = new BotStorage(home);
  try {
    const bot = storage.createBot({
      slug: "builder",
      name: "Builder",
      identity: "Help",
      provider: "claude",
      model: "default",
      modeId: "default",
    });
    const source = new LocalBotTriggers({
      storage,
      sources: () => [
        { name: "jira", poll: () => Promise.reject(new Error("Jira is unavailable")) },
        {
          name: "local",
          poll: async () => [{ key: "local:1", source: "local", text: "Look at this" }],
        },
      ],
    });
    expect(await source.poll(bot)).toEqual([
      { key: "local:1", source: "local", text: "Look at this" },
    ]);
  } finally {
    storage.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("has no GitHub poll: a bot with no sources gets no triggers (spec 37.2.6, ADR-0061 §2)", async () => {
  const home = mkdtempSync(join(tmpdir(), "bots-trigger-"));
  const storage = new BotStorage(home);
  try {
    const bot = storage.createBot({
      slug: "builder",
      name: "Builder",
      identity: "Help",
      provider: "claude",
      model: "default",
      modeId: "default",
    });
    expect(await new LocalBotTriggers({ storage }).poll(bot)).toEqual([]);
    expect(storage.state(`github-poll:${bot.id}`, z.number())).toBeUndefined();
  } finally {
    storage.close();
    rmSync(home, { recursive: true, force: true });
  }
});
