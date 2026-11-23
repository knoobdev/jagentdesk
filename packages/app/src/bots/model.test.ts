import { describe, expect, it } from "vitest";
import { BotItemSchema, type BotMessage } from "@jagentdesk/protocol/bots/types";
import { sortItems, mergeMessages, buildBotsRoute } from "./model";
function item(id: string, status: "working" | "done" | "needs_you", updatedAt_ms: number) {
  return BotItemSchema.parse({
    id,
    botId: "bot",
    title: id,
    doneMeans: "Tests pass",
    status,
    workerAgentIds: [],
    comments: [],
    reviews: [],
    reviewRounds: 0,
    createdAt_ms: 0,
    updatedAt_ms,
  });
}
function message(id: string, createdAt_ms: number, text = id): BotMessage {
  return { id, createdAt_ms, botId: "bot", text, role: "assistant", source: "chat" };
}
describe("Bots presentation", () => {
  it("puts Needs you before newer working and closed items without mutating cached data", () => {
    const items = [
      item("done", "done", 100),
      item("working", "working", 200),
      item("need-old", "needs_you", 1),
      item("need-new", "needs_you", 2),
    ];
    expect(sortItems(items).map((entry) => entry.id)).toEqual([
      "need-new",
      "need-old",
      "working",
      "done",
    ]);
    expect(items[0].id).toBe("done");
  });
  it("deduplicates overlapping history and pushes, replacing a repeated id", () => {
    const history = [message("b", 2), message("a", 1)];
    expect(mergeMessages(history, [message("b", 2, "updated"), message("c", 3)])).toEqual([
      message("a", 1),
      message("b", 2, "updated"),
      message("c", 3),
    ]);
    expect(history[0].text).toBe("b");
  });
  it("keeps bot and room targets scoped to the encoded host route", () => {
    expect(buildBotsRoute("host/one", { botId: "bot id" })).toBe("/h/host%2Fone/bots?botId=bot+id");
    expect(buildBotsRoute("host", { roomId: "r&1" })).toBe("/h/host/bots?roomId=r%261");
    expect(buildBotsRoute("host", { botId: "bot", itemId: "item" })).toBe(
      "/h/host/bots?botId=bot&tab=items&itemId=item",
    );
  });
});
