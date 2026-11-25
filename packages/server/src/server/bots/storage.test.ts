import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BotStorage } from "./storage.js";
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it("persists bots, prevents duplicate slugs, and deduplicates durable wake messages", () => {
  const home = mkdtempSync(join(tmpdir(), "bots-store-"));
  homes.push(home);
  let store = new BotStorage(home);
  const bot = store.createBot({
    slug: "builder",
    name: "Builder",
    identity: "Fix bugs",
    provider: "claude",
    model: "default",
    modeId: "default",
  });
  expect(bot.unattended).toBe(false);
  expect(() => store.createBot({ ...bot, name: "Duplicate" })).toThrow();
  expect(store.enqueue(bot.id, "github:1", "Review this PR", "github")).not.toBeNull();
  expect(store.enqueue(bot.id, "github:1", "Review this PR", "github")).toBeNull();
  store.close();
  store = new BotStorage(home);
  expect(store.listBots()).toEqual([bot]);
  expect(store.pending(bot.id).map((m) => m.text)).toEqual(["Review this PR"]);
  store.close();
});

it("retains dedupe receipts outside the history page and drops pending mail for deleted rooms", () => {
  const home = mkdtempSync(join(tmpdir(), "bots-store-"));
  homes.push(home);
  const store = new BotStorage(home);
  try {
    const bot = store.createBot({
      slug: "builder",
      name: "Builder",
      identity: "Help",
      provider: "claude",
      model: "default",
      modeId: "default",
    });
    store.enqueue(bot.id, "original", "First", "chat");
    for (let i = 0; i < 205; i++) store.enqueue(bot.id, `later:${i}`, "Later", "chat");
    expect(store.history(bot.id, 200).some((m) => m.id === "original")).toBe(false);
    expect(store.message("original")?.text).toBe("First");
    store.saveRoom({ id: "room", name: "Room", memberBotIds: [bot.id], messages: [] });
    store.enqueue(bot.id, "room-mail", "@builder", "room", { roomId: "room" });
    store.deleteRoom("room");
    expect(store.pending(bot.id).some((m) => m.id === "room-mail")).toBe(false);
    expect(store.message("room-mail")?.text).toBe("@builder");
  } finally {
    store.close();
  }
});
