import { describe, expect, it } from "vitest";
import type { Bot, BotItem } from "@jagentdesk/protocol/bots/types";
import type { AgentPermissionResponse } from "../agent/agent-sdk-types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import { createBotAgentTools } from "./agent-tools.js";
import type { BotsService } from "./service.js";

const bot = { id: "b1", name: "Sum keeper", defaultRepo: undefined } as unknown as Bot;
const item = {
  id: "i1",
  number: 1,
  title: "Fix sum()",
  status: "planned",
  workerAgentIds: [],
} as unknown as BotItem;

interface Asked {
  title?: string;
  description?: string;
  detail?: unknown;
  metadata?: Record<string, unknown>;
  answer: (response: AgentPermissionResponse) => void;
}

/** The bot's tools over the two things they read here: its item, and the owner's answers. */
function botTools() {
  const asked: Asked[] = [];
  const started: string[] = [];
  const service = {
    storage: {
      listBots: () => [bot],
      bot: () => bot,
      findItem: () => item,
    },
    startWorker: async (_botId: string, itemId: string) => {
      started.push(itemId);
      return { agentId: "worker-1" };
    },
  } as unknown as BotsService;
  const agentManager = {
    getAgent: () => ({
      labels: { "jagentdesk.orchestration.role": "supervisor", "jagentdesk.bot.id": "b1" },
    }),
    requestHostToolPermission: (_agentId: string, request: Omit<Asked, "answer">) =>
      new Promise<AgentPermissionResponse>((answer) => asked.push({ ...request, answer })),
  } as unknown as AgentManager;
  const tools = createBotAgentTools({ service, agentManager, callerAgentId: "home" });
  const tool = (name: string) => tools.find((entry) => entry.name === name)!;
  return { tool, asked, started };
}

function text(result: { content: { text?: string }[] }): string {
  return result.content[0]?.text ?? "";
}

describe("bot tool permission cards (spec 37.3.2-37.3.3)", () => {
  it("asks to start a worker in the owner's words, then starts it once allowed", async () => {
    const { tool, asked, started } = botTools();
    const run = tool("bot_worker_start").handler(
      { itemId: "#1", repo: "/code/tiny-sum", assignment: "Make sum() add. Run npm test." },
      {},
    );
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toMatchObject({
      title: "Start a worker for #1 Fix sum()?",
      description:
        "Sum keeper starts a worker in a new worktree of tiny-sum (/code/tiny-sum). The worker reports back when it is done.",
      detail: { type: "plain_text", label: "Task", text: "Make sum() add. Run npm test." },
      metadata: { botCard: { kind: "worker_start", projectName: "tiny-sum" } },
    });
    asked[0]!.answer({ behavior: "allow" });
    expect((await run).isError).toBeUndefined();
    expect(started).toEqual(["#1"]);
  });

  it("raises one card when the bot starts the same item's worker twice in a turn", async () => {
    const { tool, asked, started } = botTools();
    const input = { itemId: "#1", repo: "/code/tiny-sum", assignment: "Fix it" };
    const first = tool("bot_worker_start").handler(input, {});
    await expect.poll(() => asked.length).toBe(1);
    const second = await tool("bot_worker_start").handler(input, {});
    expect(second.isError).toBe(true);
    expect(text(second)).toBe("This is already waiting for your owner's answer; end your turn");
    expect(asked).toHaveLength(1);
    asked[0]!.answer({ behavior: "deny" });
    expect(text(await first)).toBe("Denied by user");
    // Answered, the item can be asked about again.
    void tool("bot_worker_start").handler(input, {});
    await expect.poll(() => asked.length).toBe(2);
    asked[1]!.answer({ behavior: "deny" });
    expect(started).toEqual([]);
  });

  it("asks nothing when the start can't run", async () => {
    const { tool, asked } = botTools();
    const result = await tool("bot_worker_start").handler({ itemId: "#1", assignment: "x" }, {});
    expect(text(result)).toBe("Choose a target repository");
    expect(asked).toHaveLength(0);
  });
});
