import { z } from "zod";
import { BotItemPatchSchema } from "@jagentdesk/protocol/bots/types";
import type { JAgentDeskToolDefinition } from "../agent/tools/types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BotsService } from "./service.js";

export function createBotAgentTools(options: {
  service: BotsService;
  agentManager: AgentManager;
  callerAgentId: string | null;
  callerLabels?: Record<string, string>;
}): JAgentDeskToolDefinition[] {
  const { service, agentManager, callerAgentId } = options;
  if (!callerAgentId) return [];
  const labels = agentManager.getAgent(callerAgentId)?.labels ?? options.callerLabels;
  if (labels?.["jagentdesk.orchestration.role"] !== "supervisor") return [];
  const bot = service.storage.listBots().find((b) => b.id === labels?.["jagentdesk.bot.id"]);
  if (!bot) return [];
  function define<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (input: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>,
  ): JAgentDeskToolDefinition {
    const schema = z.object(shape);
    return {
      name,
      title: name,
      description,
      inputSchema: shape,
      async handler(raw) {
        try {
          const input = schema.parse(raw);
          const decision = await agentManager.requestHostToolPermission(callerAgentId!, {
            name,
            kind: "tool",
            title: description,
            description: JSON.stringify(input),
            input,
          });
          if (decision.behavior !== "allow") throw new Error("Denied by user");
          const result = await run(input);
          return { content: [{ type: "text", text: JSON.stringify(result ?? { ok: true }) }] };
        } catch (error) {
          return {
            isError: true,
            content: [
              { type: "text", text: error instanceof Error ? error.message : String(error) },
            ],
          };
        }
      },
    };
  }
  const itemId = { itemId: z.string() };
  return [
    define(
      "bot_item_add",
      "Track a commitment as a bot item",
      { title: z.string().trim().min(1).max(200), doneMeans: z.string().trim().min(1).max(2000) },
      (i) => service.addItem(bot.id, i.title, i.doneMeans),
    ),
    define(
      "bot_item_set",
      "Update an item, ask up to five questions, or wait",
      { ...itemId, patch: BotItemPatchSchema },
      (i) =>
        i.patch.status === "canceled"
          ? service.cancel(bot.id, i.itemId, "Canceled by bot")
          : service.setItem(bot.id, i.itemId, i.patch),
    ),
    define(
      "bot_item_comment",
      "Record evidence and results on an item",
      { ...itemId, text: z.string().min(1).max(40000) },
      (i) => service.comment(bot.id, i.itemId, i.text),
    ),
    define(
      "bot_item_done",
      "Close a non-worker item; worker items require daemon review",
      itemId,
      (i) => service.setItem(bot.id, i.itemId, { status: "done" }),
    ),
    define(
      "bot_worker_start",
      "Start an ORC worker in a NEW worktree; then end your turn",
      { ...itemId, repo: z.string().optional(), assignment: z.string().trim().min(1).max(20000) },
      (i) => service.startWorker(bot.id, i.itemId, i.repo, i.assignment),
    ),
    define(
      "bot_wait",
      "Set an external wait and wake deadline; then end your turn",
      { ...itemId, condition: z.string().min(1).max(2000), until_ms: z.number().int() },
      (i) => {
        if (i.until_ms <= Date.now()) throw new Error("Wait deadline must be in the future");
        return service.setItem(bot.id, i.itemId, {
          status: "waiting",
          waitFor: { condition: i.condition, until_ms: i.until_ms },
        });
      },
    ),
    define(
      "bot_handoff",
      "Hand off to another unpaused local bot",
      { botId: z.string(), text: z.string().trim().min(1).max(20000) },
      (i) => service.handoff(bot.id, i.botId, i.text),
    ),
  ];
}
