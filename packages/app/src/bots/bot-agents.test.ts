import { describe, expect, it } from "vitest";
import { isBotAgent } from "./bot-agents";

const agents = new Map<string, { labels: Record<string, string> }>([
  ["home", { labels: { "jagentdesk.bot.id": "b1" } }],
  ["worker", { labels: { "jagentdesk.parent-agent-id": "home" } }],
  ["sub", { labels: { "jagentdesk.parent-agent-id": "worker" } }],
  ["mine", { labels: {} }],
  ["child", { labels: { "jagentdesk.parent-agent-id": "mine" } }],
  ["a", { labels: { "jagentdesk.parent-agent-id": "b" } }],
  ["b", { labels: { "jagentdesk.parent-agent-id": "a" } }],
]);
const lookup = (id: string) => agents.get(id);

describe("isBotAgent", () => {
  it("knows a bot's Home Chat, its workers and their workers", () => {
    expect(isBotAgent(agents.get("home")!, lookup)).toBe(true);
    expect(isBotAgent(agents.get("worker")!, lookup)).toBe(true);
    expect(isBotAgent(agents.get("sub")!, lookup)).toBe(true);
  });

  it("leaves the owner's agents, their children, unknown parents and cycles alone", () => {
    expect(isBotAgent(agents.get("mine")!, lookup)).toBe(false);
    expect(isBotAgent(agents.get("child")!, lookup)).toBe(false);
    expect(isBotAgent({ labels: { "jagentdesk.parent-agent-id": "gone" } }, lookup)).toBe(false);
    expect(isBotAgent(agents.get("a")!, lookup)).toBe(false);
    expect(isBotAgent({}, lookup)).toBe(false);
  });
});
