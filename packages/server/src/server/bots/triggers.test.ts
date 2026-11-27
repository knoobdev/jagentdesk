import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BotStorage } from "./storage.js";
import { LocalBotTriggers } from "./triggers.js";
it("does not query GitHub before auth; polls at five minutes and deduplicates across restart", async () => {
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
    let now = 1000;
    let authenticated = false;
    const calls: string[][] = [];
    const triggers = new LocalBotTriggers({
      storage,
      now: () => now,
      gh: async (args) => {
        calls.push(args);
        if (args[0] === "auth") {
          if (!authenticated) throw new Error("not logged in");
          return "";
        }
        return JSON.stringify([
          {
            url: "https://github.com/jagentdesk/jagentdesk/pull/1",
            title: "Fix",
            updatedAt: "2026-01-01",
          },
        ]);
      },
    });
    expect(await triggers.poll(bot)).toEqual([]);
    expect(calls).toEqual([["auth", "status"]]);
    authenticated = true;
    now += 299999;
    expect(await triggers.poll(bot)).toEqual([]);
    now++;
    const events = await triggers.poll(bot);
    expect(events).toHaveLength(2);
    expect(calls).toHaveLength(4);
    for (const event of events)
      expect(storage.enqueue(bot.id, event.key, event.text, event.source)).not.toBeNull();
    now += 300000;
    for (const event of await triggers.poll(bot))
      expect(storage.enqueue(bot.id, event.key, event.text, event.source)).toBeNull();
    expect(storage.pending(bot.id)).toHaveLength(2);
  } finally {
    storage.close();
    rmSync(home, { recursive: true, force: true });
  }
});

it("delivers GitHub triggers even when the configured Jira source fails", async () => {
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
        {
          name: "jira",
          poll: () => Promise.reject(new Error("Jira is unavailable")),
        },
      ],
      gh: async (args) =>
        args[0] === "auth"
          ? ""
          : JSON.stringify([
              {
                url: "https://github.com/jagentdesk/jagentdesk/pull/1",
                title: "Fix",
                updatedAt: "2026-01-01",
              },
            ]),
    });
    expect((await source.poll(bot)).map((event) => event.source)).toEqual(["github", "github"]);
  } finally {
    storage.close();
    rmSync(home, { recursive: true, force: true });
  }
});
it("does not poll gh for a bot that has a GitHub webhook (ADR-0061 §2)", async () => {
  const home = mkdtempSync(join(tmpdir(), "bots-trigger-"));
  const storage = new BotStorage(home);
  try {
    const bot = storage.createBot({
      slug: "hooked",
      name: "Hooked",
      identity: "Help",
      provider: "claude",
      model: "default",
      modeId: "default",
    });
    storage.setState(`github:connection:${bot.id}`, {
      hookId: "h",
      targets: [{ target: "octo/repo", state: "connected" }],
      allowedUsers: [],
    });
    const calls: string[][] = [];
    const triggers = new LocalBotTriggers({
      storage,
      gh: async (args) => {
        calls.push(args);
        return "[]";
      },
    });
    expect(await triggers.poll(bot)).toEqual([]);
    expect(calls).toEqual([]);
  } finally {
    storage.close();
    rmSync(home, { recursive: true, force: true });
  }
});
