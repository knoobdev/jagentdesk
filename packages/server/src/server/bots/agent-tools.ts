// The bot's tools, the JAgentDesk side of Orca's `orca bot …` commands (dfdb4fda, MIT:
// src/main/bots/bot-preamble.ts:17-88). Item, memory and automation bookkeeping stays in the
// daemon and needs no card; tools that start or reach other agents ask through the permission
// gate (ADR-0046), which an unattended mode answers itself.
import { z } from "zod";
import { BotItemAskSchema, BotItemPatchSchema } from "@jagentdesk/protocol/bots/types";
import {
  botPermissionRequestText,
  botProjectName,
  type BotPermissionCard,
} from "@jagentdesk/protocol/bots/permission-cards";
import type { JAgentDeskToolDefinition } from "../agent/tools/types.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { BotsService } from "./service.js";
import { BOT_ID_LABEL } from "./runtime.js";
import { BOT_EVENT_AUTOMATION_SOURCES } from "./event-automations.js";

/** What a gated tool asks: its card, and `once`, a key no second ask may share while it waits. */
interface BotToolAsk {
  card: BotPermissionCard;
  once?: string;
}

// Asks waiting for the owner, by `once`: a model that calls bot_worker_start twice in one turn gets
// one card, not two for the same item (the second could only fail once the first was allowed).
const waitingAsks = new Set<string>();

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
  const bot = service.storage.listBots().find((b) => b.id === labels?.[BOT_ID_LABEL]);
  if (!bot) return [];
  /** `ask`: the tool asks the owner first, with this card. */
  function define<S extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: S,
    run: (input: z.infer<z.ZodObject<S>>) => unknown | Promise<unknown>,
    ask?: (input: z.infer<z.ZodObject<S>>) => BotToolAsk,
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
          if (ask) {
            const { card, once } = ask(input);
            if (once && waitingAsks.has(once))
              throw new Error("This is already waiting for your owner's answer; end your turn");
            if (once) waitingAsks.add(once);
            try {
              // The owner reads what will happen, not the tool's instructions to the model.
              const text = botPermissionRequestText(card);
              const decision = await agentManager.requestHostToolPermission(callerAgentId!, {
                name,
                kind: "tool",
                title: text.title,
                description: text.description,
                detail: text.detail,
                metadata: text.metadata,
                input,
              });
              if (decision.behavior !== "allow") throw new Error("Denied by user");
            } finally {
              if (once) waitingAsks.delete(once);
            }
          }
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
  const itemId = { itemId: z.string().describe("Item id or number (#N)") };
  return [
    define(
      "bot_item_add",
      "Track a commitment as a bot item before working on it",
      {
        title: z.string().trim().min(1).max(200),
        doneMeans: z.string().trim().min(1).max(2000),
        description: z.string().max(20000).optional(),
      },
      (i) => service.addItem(bot.id, i.title, i.doneMeans, { description: i.description }),
    ),
    define(
      "bot_item_list",
      "List your open items (all: include closed ones)",
      { all: z.boolean().optional() },
      (i) => service.storage.items(bot.id, i.all ?? false),
    ),
    define(
      "bot_item_set",
      "Change an item's title, description, done means or status",
      { ...itemId, patch: BotItemPatchSchema },
      (i) =>
        i.patch.status === "canceled"
          ? service.cancel(bot.id, i.itemId, "Canceled by bot", "bot")
          : service.setItem(bot.id, i.itemId, i.patch),
    ),
    define(
      "bot_item_ask",
      "Set an item to Needs you with up to 5 questions, each with up to 8 quick replies",
      { ...itemId, ask: BotItemAskSchema },
      (i) => service.ask(bot.id, i.itemId, i.ask),
    ),
    define(
      "bot_item_comment",
      "Record evidence and results on an item",
      { ...itemId, text: z.string().min(1).max(8000) },
      (i) => service.comment(bot.id, i.itemId, i.text),
    ),
    define(
      "bot_item_link",
      "Link a pull request, URL or file to an item",
      { ...itemId, kind: z.enum(["pr", "url", "file"]), ref: z.string().min(1).max(2000) },
      (i) =>
        service.link(
          bot.id,
          i.itemId,
          i.kind === "pr"
            ? { kind: "pr", ref: i.ref, ...(i.ref.startsWith("http") ? { url: i.ref } : {}) }
            : { kind: i.kind, ref: i.ref },
        ),
    ),
    define("bot_item_done", "Close an item whose done means is met", itemId, (i) =>
      service.setStatus(bot.id, i.itemId, "done", "bot"),
    ),
    define(
      "bot_item_cancel",
      "Drop an item, with the reason",
      { ...itemId, reason: z.string().trim().min(1).max(4000) },
      (i) => service.cancel(bot.id, i.itemId, i.reason, "bot"),
    ),
    define(
      "bot_worker_start",
      "Start an ORC worker in a NEW worktree of the project for an item; then end your turn",
      {
        ...itemId,
        repo: z.string().optional(),
        assignment: z.string().trim().min(1).max(20000),
      },
      (i) => service.startWorker(bot.id, i.itemId, i.repo, i.assignment),
      (i) => {
        // The same checks startWorker makes, before the owner is asked about a start that can't run.
        const item = service.storage.findItem(bot.id, i.itemId);
        if (item.workerAgentIds.length || item.status === "done" || item.status === "canceled")
          throw new Error("Item already has a worker or is closed");
        const projectPath = i.repo ?? service.storage.bot(bot.id).defaultRepo;
        if (!projectPath) throw new Error("Choose a target repository");
        return {
          once: `worker-start:${item.id}`,
          card: {
            kind: "worker_start",
            botName: bot.name,
            itemNumber: item.number ?? null,
            itemTitle: item.title,
            projectPath,
            projectName: botProjectName(projectPath),
            task: i.assignment,
          },
        };
      },
    ),
    define(
      "bot_wait",
      "Set an item to Waiting on something outside you, with a wake deadline; then end your turn",
      {
        ...itemId,
        condition: z.string().min(1).max(200),
        until_ms: z.number().int(),
      },
      (i) => {
        if (i.until_ms <= Date.now()) throw new Error("Wait deadline must be in the future");
        return service.setItem(bot.id, i.itemId, {
          status: "waiting",
          waitFor: { condition: i.condition, until_ms: i.until_ms },
        });
      },
    ),
    define(
      "bot_memory_forget",
      "Remove a MEMORY.md line by its words (the only way to remove or replace one)",
      { fact: z.string().trim().min(1).max(2000) },
      async (i) => ({
        dropped: await service.memory.forgetFact(
          service.storage.bot(bot.id),
          i.fact,
          callerAgentId,
        ),
      }),
    ),
    define(
      "bot_automation_save",
      "Create or change an automation that runs a prompt in your Home Chat on a cron schedule",
      {
        automationId: z.string().optional(),
        name: z.string().trim().min(1).max(100),
        cron: z.string().min(1).max(100),
        timezone: z.string().optional(),
        prompt: z.string().trim().min(1).max(20000),
        enabled: z.boolean().optional(),
      },
      (i) =>
        service.saveSchedule(
          bot.id,
          {
            name: i.name,
            cron: i.cron,
            ...(i.timezone ? { timezone: i.timezone } : {}),
            prompt: i.prompt,
            enabled: i.enabled ?? true,
          },
          i.automationId,
        ),
    ),
    define(
      "bot_event_automation_save",
      "Create or change an automation that runs a prompt in your Home Chat when a GitHub, GitLab or Telegram event of yours happens (for example github ci_failed, gitlab ci_failed, github comment). It runs whoever caused the event",
      {
        automationId: z.string().optional(),
        name: z.string().trim().min(1).max(100),
        source: z.enum(BOT_EVENT_AUTOMATION_SOURCES),
        event: z.string().min(1).max(64),
        prompt: z.string().trim().min(1).max(20000),
        enabled: z.boolean().optional(),
      },
      (i) =>
        service.saveEventAutomation(
          bot.id,
          {
            name: i.name,
            source: i.source,
            event: i.event,
            prompt: i.prompt,
            enabled: i.enabled ?? true,
          },
          i.automationId,
        ),
    ),
    define("bot_automation_list", "List your automations", {}, () => service.automations(bot.id)),
    define("bot_automation_delete", "Remove an automation", { automationId: z.string() }, (i) =>
      service.deleteSchedule(bot.id, i.automationId),
    ),
    define("bot_list", "Other bots on this computer and what each is for", {}, () =>
      service.storage
        .listBots()
        .filter((b) => b.id !== bot.id)
        .map((b) => ({
          id: b.id,
          name: b.name,
          folder: b.folder,
          paused: b.paused,
          identity: b.identity,
        })),
    ),
    define(
      "bot_handoff",
      "Send another unpaused local bot a status, a handoff or a question",
      {
        botId: z.string(),
        type: z.enum(["status", "handoff", "question"]).optional(),
        text: z.string().trim().min(1).max(20000),
      },
      (i) => service.handoff(bot.id, i.botId, i.text, i.type ?? "handoff"),
      (i) => ({
        card: {
          kind: "handoff",
          botName: bot.name,
          toBotName: service.storage.bot(i.botId).name,
          type: i.type ?? "handoff",
          text: i.text,
        },
      }),
    ),
  ];
}
