import { describe, expect, it } from "vitest";
import type { BotChat, BotChatWorker } from "@jagentdesk/protocol/bots/views";
import {
  botChatKindKey,
  chatWorkersShown,
  orderChatWorkers,
  orderChatsTab,
} from "./chat-tree-view";

const chat = (id: string, kind: BotChat["kind"], at: number): BotChat => ({
  id,
  kind,
  title: id,
  live: "idle",
  lastActiveAt_ms: at,
  workers: [],
  runningTotal: 0,
  waitingTotal: 0,
});
const worker = (agentId: string, state: BotChatWorker["state"], at: number): BotChatWorker => ({
  agentId,
  title: agentId,
  state,
  startedAt_ms: at,
});

describe("chats tab", () => {
  it("labels every kind, GitLab and Telegram with JAgentDesk's strings", () => {
    expect(botChatKindKey("side")).toBe("bots.chats.kindSide");
    expect(botChatKindKey("gitlab")).toBe("bots.jad.panels.chats.kindGitlab");
    expect(botChatKindKey("telegram")).toBe("bots.jad.panels.chats.kindTelegram");
    expect(botChatKindKey("automation")).toBe("bots.chats.kindAutomation");
  });

  it("puts Home Chat first, then newest", () => {
    const home = chat("home", "home", 1);
    const tree = { home, chats: [chat("a", "side", 5), chat("b", "slack", 9)], workspaces: [] };
    expect(orderChatsTab(tree).map((entry) => entry.id)).toEqual(["home", "b", "a"]);
  });

  it("lists asking, running, then settled workers", () => {
    const rows = [
      worker("done", "done", 9),
      worker("run", "running", 1),
      worker("ask", "needs-you", 2),
    ];
    expect(orderChatWorkers(rows).map((entry) => entry.agentId)).toEqual(["ask", "run", "done"]);
  });

  it("steps workers by eight", () => {
    expect(chatWorkersShown(20, 0)).toEqual({ shown: 8, hidden: 12, next: 8 });
    expect(chatWorkersShown(20, 1)).toEqual({ shown: 16, hidden: 4, next: 4 });
    expect(chatWorkersShown(5, 0)).toEqual({ shown: 5, hidden: 0, next: 0 });
  });
});
