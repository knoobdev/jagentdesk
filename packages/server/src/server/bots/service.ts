import type { BotsSlack } from "./slack.js";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import {
  BotPatchSchema,
  BotMessageSchema,
  BotScheduleInputSchema,
  type Bot,
  type BotChatNote,
  type BotGroupReplyMode,
  type BotInput,
  type BotItemActor,
  type BotItemAsk,
  type BotItemLink,
  type BotItemStatus,
  type BotPatch,
  type BotItem,
  type BotItemPatch,
  type BotMessage,
  type BotScheduleInput,
} from "@jagentdesk/protocol/bots/types";
import type {
  BotAllowedPerson,
  BotAutomation,
  BotChatTree,
  BotNeedsYouRow,
  BotSuggestion,
  BotTemplate,
  BotTidyUpSummary,
  BotTidyUpView,
  BotUpNextState,
} from "@jagentdesk/protocol/bots/views";
import { BotTidyUpSummarySchema } from "@jagentdesk/protocol/bots/views";
import type { BotsPush, BotsRequest } from "@jagentdesk/protocol/bots/rpc-schemas";
import {
  BOT_ITEM_STATUS_LABELS,
  LOOK_AROUND_LIMITS,
  TIDY_UP_LIMITS,
  botLookAround,
  lookAroundSupported,
} from "@jagentdesk/protocol/bots/rules";
import { computeNextRunAt, validateScheduleCadence } from "../schedule/cron.js";
import type { PushNotificationSender } from "../push/notifications.js";
import { BotStorage, SAME_AS_CHATS, botIdentity } from "./storage.js";
import { type BotRuntime, type BotRuntimeEvent } from "./runtime.js";
import {
  assertReviewAllowsDone,
  assertSnooze,
  assertTransition,
  commentItem,
  journalLine,
  patchItem,
  prRefOfUrl,
  withAsk,
  withLink,
  withStatus,
  type ItemActorKind,
} from "./items.js";
import { mentionedSlugs, mentionsEveryone } from "./context.js";
import { blockingFindingCount, reviewSummary, reviewWorker } from "./review.js";
import { BotsError, assertBotAvatarImage, seedSoul, writeBotHome } from "./home.js";
import { BotMemory, writeHomeFile } from "./memory.js";
import {
  BOT_QUIET_MARKER,
  dueLookSlot,
  lookAroundPrompt,
  nextLookAt,
  parseSuggestions,
  suggestionKey,
  suggestionSource,
} from "./look-around.js";
import { applyTidyOps, nextTidyAt, parseTidyOps, tidyDue, tidyUpPrompt } from "./tidy-up.js";
import { automationRows, chatTree, needsYouRows } from "./read-models.js";
import { BOT_TEMPLATES } from "./templates/catalog.js";
import { BOT_TEMPLATE_SKILL_TEXT } from "./templates/skills.js";
import { BOT_SETUP_FILE, BOT_TEMPLATE_CATEGORY_LABELS } from "./templates/types.js";

export interface BotTrigger {
  key: string;
  text: string;
  source: "jira" | "github";
}
export interface BotTriggerSource {
  poll(bot: Bot): Promise<BotTrigger[]>;
}
/** Another lot's connector (bt4: GitHub, GitLab, Telegram) adds its "Who can ask" people here. */
export type BotAllowedSource = (bot: Bot) => Promise<BotAllowedPerson[]>;

/** Orca's turn to a bot it just created (`shared/bot-created-kickoff.ts`). */
export const BOT_CREATED_KICKOFF = "JAgentDesk: you were just created. Start your first-run setup.";
const TOOK_OVER_TURN_PREFIX = "[JAgentDesk: your owner just handed you the workspace ";
const TOOK_OVER_GOAL_HEADING = "Your owner's words:\n\n";
const DAY_MS = 24 * 60 * 60_000;
/** A tick gap this long means the host slept. */
const SLEEP_GAP_MS = 30_000;

const LookStateSchema = z.object({
  lastLookedAt_ms: z.number().optional(),
  tookMs: z.number().optional(),
  running: z.boolean(),
  runAgentId: z.string().optional(),
  lastAgentId: z.string().optional(),
  error: z.string().optional(),
  failures: z.number(),
  turnedOff: z.string().optional(),
  noteId: z.string().optional(),
});
type LookState = z.infer<typeof LookStateSchema>;
const TidyStateSchema = z.object({
  lastRunAt_ms: z.number().optional(),
  running: z.boolean(),
  runAgentId: z.string().optional(),
  error: z.string().optional(),
  failures: z.number(),
  turnedOff: z.string().optional(),
  last: BotTidyUpSummarySchema.optional(),
  /** MEMORY.md before and after the last tidy, for Undo. */
  before: z.string().optional(),
  after: z.string().optional(),
});
type TidyState = z.infer<typeof TidyStateSchema>;

/** `main/bots/bot-run-results.ts:194-202`: a reply ending with the marker posts nothing. */
function quiet(text: string): boolean {
  return text.trim().endsWith(BOT_QUIET_MARKER);
}

/** `shared/bots/bot-look-around.ts` patchLookAround: turning it on stamps when, so older slots never catch up. */
function patchedLookAround(
  bot: Bot,
  patch: NonNullable<BotPatch["lookAround"]>,
  now: number,
): Bot["lookAround"] {
  const current = botLookAround(bot);
  const on = patch.on ?? patch.enabled ?? current.on;
  const next: Bot["lookAround"] = {
    ...bot.lookAround,
    enabled: on,
    on,
    every: patch.every ?? current.every,
    weekdaysOnly: patch.weekdaysOnly ?? current.weekdaysOnly,
    focus: patch.focus ?? current.focus,
  };
  if (patch.intervalMinutes) next.intervalMinutes = patch.intervalMinutes;
  if (on && !current.on) next.since_ms = now;
  return next;
}

/** `shared/bots/bot-tidy-up.ts` patchTidyUp. */
function patchedTidyUp(
  bot: Bot,
  patch: NonNullable<BotPatch["tidyUp"]>,
  now: number,
): Bot["tidyUp"] {
  const current = bot.tidyUp ?? { on: true, every: "night" as const };
  const on = patch.on ?? current.on;
  const next: NonNullable<Bot["tidyUp"]> = { on, every: patch.every ?? current.every };
  const since = on && !current.on ? now : current.since_ms;
  if (since !== undefined) next.since_ms = since;
  return next;
}

function commentActor(author: string, botId: string): BotItemActor {
  if (author === "owner") return { kind: "owner" };
  if (author === "bot") return { kind: "bot", botId };
  return { kind: "jagentdesk", why: author };
}

const HANDOFF_VERBS = {
  status: "sent you a status",
  question: "asked you",
  handoff: "handed off",
} as const;

export class BotsService {
  slack?: BotsSlack;
  readonly memory: BotMemory;
  readonly allowedSources: BotAllowedSource[] = [];
  private readonly replyListeners = new Set<(request: BotMessage, reply: BotMessage) => void>();
  onReply(listener: (request: BotMessage, reply: BotMessage) => void): () => void {
    this.replyListeners.add(listener);
    return () => this.replyListeners.delete(listener);
  }
  private enabled = false;
  private hasStarted = false;
  private shuttingDown = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<(event: BotsPush) => void>();
  private readonly dispatching = new Set<string>();
  private readonly reviewing = new Set<string>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly workerStarts = new Set<string>();
  private readonly unsubscribe: () => void;
  private ticking = false;
  private lastTickAt = 0;
  /** When the host last woke (or the daemon started): background runs wait 120 s after it. */
  private awakeSince = 0;
  /** SOUL.md/MEMORY.md modification times, so an outside edit reaches open editors. */
  private readonly homeFileTimes = new Map<string, number>();
  constructor(
    readonly storage: BotStorage,
    readonly runtime: BotRuntime,
    private readonly options: {
      logger: Logger;
      triggers?: BotTriggerSource;
      push?: PushNotificationSender;
      now?: () => number;
    },
  ) {
    this.memory = new BotMemory(storage, (botId) => this.activity(botId, ["memory"]));
    this.unsubscribe = runtime.onEvent((event) => this.launch(this.handleRuntimeEvent(event)));
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private launch(job: Promise<unknown>): void {
    this.jobs.add(job);
    void job
      .catch((err) => this.options.logger.error({ err }, "Bot operation failed"))
      .finally(() => this.jobs.delete(job));
  }
  async settled(): Promise<void> {
    while (this.jobs.size > 0) await Promise.allSettled(this.jobs);
  }
  onEvent(listener: (event: BotsPush) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(event: BotsPush): void {
    for (const listener of this.listeners) listener(event);
  }
  private changed(botId: string): void {
    this.emit({ type: "bots.changed", payload: { botId } });
  }
  private activity(
    botId: string,
    parts: ("needs_you" | "chats" | "automations" | "memory" | "tidy_up")[],
  ): void {
    this.emit({ type: "bots.activity_changed", payload: { botId, parts } });
  }
  private sendPush(
    bot: Bot,
    kind: "needsPermission" | "taskComplete" | "couldNotFinish",
    body: {
      title: string;
      body: string;
      data: Record<string, string>;
    },
  ): void {
    if (bot.paused || !bot.notifications?.[kind]) return;
    this.launch(this.options.push?.send(body) ?? Promise.resolve());
  }

  // ── Bots ──────────────────────────────────────────────────────────────

  /** Applies the provider's resolved mode; the round-1 `modeId`/`unattended` mirror it. */
  private async configured(bot: Bot): Promise<Bot> {
    const { modeId, unattended } = await this.runtime.configure(bot);
    return { ...bot, modeId, unattended };
  }

  async create(
    input: BotInput,
    options: { soul?: string; extra?: Partial<Bot>; kickoff?: string | null } = {},
  ): Promise<Bot> {
    const created = this.storage.createBot(input, options.extra);
    try {
      await writeBotHome(
        this.storage.botHome(created),
        created,
        options.soul ?? seedSoul(created.name, input.identity),
      );
      // COMPAT(botsRound1Unattended): a round-1 app asks for unattended with any mode id.
      const requested =
        input.unattended && !input.permissionMode
          ? {
              ...created,
              permissionMode: (await this.runtime.bypassModeId(created)) ?? created.modeId,
            }
          : created;
      const bot = this.storage.saveBot(await this.configured(requested));
      this.changed(bot.id);
      if (options.kickoff !== null)
        this.wake(
          bot.id,
          options.kickoff ?? BOT_CREATED_KICKOFF,
          "jagentdesk",
          `created:${bot.id}`,
        );
      return bot;
    } catch (err) {
      this.storage.deleteBot(created.id);
      throw err;
    }
  }

  async update(id: string, raw: BotPatch): Promise<Bot> {
    const parsed = BotPatchSchema.parse(raw);
    const bot = this.storage.bot(id);
    const now = this.now();
    const { lookAround, tidyUp, notifications, identity, ...rest } = parsed;
    let next: Bot = { ...bot, ...rest };
    if (identity !== undefined) next.identity = botIdentity(identity);
    if (notifications) next.notifications = { ...bot.notifications!, ...notifications };
    if (lookAround) next.lookAround = patchedLookAround(bot, lookAround, now);
    if (tidyUp) next.tidyUp = patchedTidyUp(bot, tidyUp, now);
    next.permissionMode = await this.round1PermissionMode(next, rest);
    const execution = [
      "provider",
      "model",
      "permissionMode",
      "unattended",
      "modeId",
      "thinkingOptionId",
    ];
    if (execution.some((key) => key in rest)) {
      if (rest.provider !== undefined && rest.provider !== bot.provider) {
        // A new provider starts a new Home Chat (spec 37.3.5); SOUL and MEMORY stay.
        await this.runtime.resetHome(bot);
        next = { ...next, agentId: undefined, homeAgentId: undefined };
      }
      next = await this.configured(next);
    }
    const saved = this.storage.saveBot(next);
    this.changed(id);
    return saved;
  }

  /** COMPAT(botsRound1Unattended): added in v0.12.0, remove after 2027-06-01 once app floor >= v0.12.0. */
  private async round1PermissionMode(
    next: Bot,
    rest: Pick<BotPatch, "unattended" | "permissionMode" | "modeId">,
  ): Promise<string | undefined> {
    if (rest.permissionMode !== undefined) return rest.permissionMode;
    if (rest.unattended === true) return (await this.runtime.bypassModeId(next)) ?? next.modeId;
    if (rest.unattended === false) return SAME_AS_CHATS;
    if (rest.modeId) return rest.modeId;
    return next.permissionMode;
  }

  async delete(id: string): Promise<void> {
    const bot = this.storage.bot(id);
    const rooms = this.storage.rooms().filter((room) => room.memberBotIds.includes(id));
    await this.slack?.disconnect(id);
    this.storage.saveBot({ ...bot, paused: true });
    for (const item of this.storage.items(id)) await this.cancel(id, item.id, "Bot deleted");
    if (bot.agentId) await this.runtime.cancel(bot.agentId);
    this.storage.deleteBot(id);
    for (const room of rooms)
      this.emit({ type: "bots.room.changed", payload: { roomId: room.id } });
    this.emit({ type: "bots.changed", payload: { botId: id, deleted: true } });
  }

  pause(id: string, paused: boolean): Bot {
    const bot = this.storage.saveBot({ ...this.storage.bot(id), paused });
    this.changed(id);
    this.activity(id, ["automations"]);
    if (!paused) this.launch(this.drain(id));
    return bot;
  }

  /** New Home Chat (spec 37.3.5): the bot keeps SOUL and MEMORY, not the conversation. */
  async resetHomeChat(id: string): Promise<Bot> {
    const bot = this.storage.bot(id);
    await this.runtime.resetHome(bot);
    this.storage.setState(`active:${id}`, null);
    const saved = this.storage.saveBot({ ...bot, agentId: undefined, homeAgentId: undefined });
    this.changed(id);
    this.activity(id, ["chats"]);
    return saved;
  }

  /**
   * Round-1 bots (spec 37.2.3): `unattended` → the provider's bypass mode; `defaultRepo` → a
   * `Fact:` line in MEMORY.md; the rest was done by the storage migration.
   */
  private async migrateRound1(bot: Bot): Promise<void> {
    if (!this.storage.state(`migrate:${bot.id}`, z.boolean())) return;
    const home = this.storage.botHome(bot);
    await writeBotHome(home, bot);
    let next = bot;
    if (bot.unattended) {
      const bypass = await this.runtime.bypassModeId(bot).catch(() => undefined);
      if (bypass) next = { ...next, permissionMode: bypass, modeId: bypass };
    }
    if (bot.defaultRepo) {
      const memory = await this.memory.text(bot);
      const fact = `Fact: default repository is ${bot.defaultRepo}`;
      if (!memory.includes(fact)) await this.memory.add(bot, fact, { kind: "owner" });
    }
    this.storage.saveBot(next);
    this.storage.deleteState(`migrate:${bot.id}`);
    this.changed(bot.id);
  }

  // ── Chat and wake queue ─────────────────────────────────────────────────

  wake(
    botId: string,
    text: string,
    source: string,
    key: string = randomUUID(),
    place: Pick<BotMessage, "roomId" | "rootId" | "slack"> = {},
  ): BotMessage | null {
    this.storage.bot(botId);
    const message = this.storage.enqueue(botId, `${botId}:${key}`, text, source, place);
    if (message) {
      this.emit({ type: "bots.chat.message", payload: { message } });
      if (source === "chat") this.storage.setState(`last-chat:${botId}`, message.createdAt_ms);
      if (this.enabled) this.launch(this.drain(botId));
    }
    return message;
  }

  /** A Home Chat line the daemon writes (not a model turn). */
  private note(
    botId: string,
    text: string,
    note: BotChatNote,
    id: string = randomUUID(),
  ): BotMessage {
    const existing = this.storage.message(`${botId}:note:${id}`);
    if (existing) {
      const message = this.storage.updateMessage({ ...existing, text, note });
      this.emit({ type: "bots.chat.message", payload: { message } });
      return message;
    }
    const message: BotMessage = {
      id: `${botId}:note:${id}`,
      botId,
      role: "system",
      text,
      source: "jagentdesk",
      createdAt_ms: this.now(),
      note,
    };
    this.storage.append(message);
    this.emit({ type: "bots.chat.message", payload: { message } });
    return message;
  }

  private async drain(botId: string): Promise<void> {
    if (!this.enabled || this.dispatching.has(botId)) return;
    this.dispatching.add(botId);
    try {
      const bot = this.storage.bot(botId);
      if (bot.paused || (bot.agentId && (await this.runtime.busy(bot.agentId)))) return;
      const message = this.storage.pending(botId)[0];
      if (!message) return;
      const agentId = await this.runtime.ensureSupervisor(bot, this.storage.botHome(bot));
      this.storage.saveBot({ ...this.storage.bot(botId), agentId });
      if (bot.agentId !== agentId) {
        this.changed(botId);
        this.activity(botId, ["chats"]);
      }
      if (!this.enabled || this.storage.bot(botId).paused) return;
      const activate = () => this.storage.setState(`active:${botId}`, message);
      if (!message.slack) activate();
      await this.runtime.send(
        agentId,
        `[${message.source}]\n${message.text}`,
        message.id,
        undefined,
        message.slack
          ? {
              senderId: `slack:${message.slack.userId}`,
              title: message.source,
              beforeDispatch: activate,
            }
          : undefined,
      );
      this.storage.delivered(message.id);
    } finally {
      this.dispatching.delete(botId);
    }
  }

  // ── Items (spec 37.2.5) ─────────────────────────────────────────────────

  private actorOf(kind: ItemActorKind, botId: string): BotItemActor {
    if (kind === "bot") return { kind: "bot", botId };
    if (kind === "owner") return { kind: "owner" };
    return { kind: "jagentdesk", why: "daemon" };
  }

  private saveItem(item: BotItem): BotItem {
    const previous = this.storage.items(item.botId, true).find((i) => i.id === item.id);
    const saved = this.storage.saveItem(item);
    this.emit({ type: "bots.item.changed", payload: { item: saved } });
    this.activity(saved.botId, ["needs_you"]);
    if (saved.status === "needs_you" && previous?.status !== "needs_you") {
      const bot = this.storage.bot(item.botId);
      this.sendPush(bot, "needsPermission", {
        title: `${bot.name} asked you`,
        body: saved.question?.decisions?.[0]?.prompt ?? saved.questions?.[0]?.text ?? saved.title,
        data: { type: "bot_needs_you", botId: saved.botId, itemId: saved.id },
      });
    }
    if (
      (saved.status === "done" || saved.status === "canceled") &&
      previous &&
      previous.status !== saved.status
    )
      this.launch(this.closed(saved));
    return saved;
  }

  /** Journal line (no model call) when an item closes. */
  private async closed(item: BotItem): Promise<void> {
    const bot = this.storage.bot(item.botId);
    const { file, line } = journalLine(item, this.now());
    await this.memory.appendJournal(bot, file, line);
    if (item.status === "done")
      this.sendPush(bot, "taskComplete", {
        title: `${bot.name} finished`,
        body: item.title,
        data: { type: "bot_item_done", botId: bot.id, itemId: item.id },
      });
  }

  private itemNote(item: BotItem, verb: string, text: string, status?: BotItemStatus): void {
    this.note(item.botId, text, {
      kind: "item",
      verb,
      itemIds: [item.id],
      ...(status ? { status } : {}),
    });
  }

  addItem(
    botId: string,
    title: string,
    doneMeans: string,
    options: { description?: string; actor?: ItemActorKind } = {},
  ): BotItem {
    this.storage.bot(botId);
    const actor = options.actor ?? "bot";
    const active = this.storage.state(`active:${botId}`, BotMessageSchema.nullable());
    const item = this.storage.newItem({
      botId,
      title,
      doneMeans,
      description: options.description,
      madeBy: actor === "daemon" ? "jagentdesk" : actor,
      chat: active?.slack
        ? {
            id: `slack:${active.slack.channel}:${active.slack.threadTs}`,
            kind: "thread",
            title: active.source,
          }
        : { id: "home", kind: "home", title: null },
    });
    if (active?.slack) this.storage.setState(`slack:item:${item.id}`, active.slack);
    const saved = this.saveItem(item);
    this.storage.addItemEvent(saved, "made", this.actorOf(actor, botId), { title });
    this.itemNote(saved, "added", `Added #${saved.number}`);
    return saved;
  }

  /** A status move by the bot or the owner ("Move to"). */
  setStatus(
    botId: string,
    itemId: string,
    status: BotItemStatus,
    actor: ItemActorKind,
    options: { waitText?: string; reason?: string; force?: boolean } = {},
  ): BotItem {
    const bot = this.storage.bot(botId);
    const item = this.storage.findItem(botId, itemId);
    if (status === item.status) return item;
    assertTransition(item, status, actor);
    if (status === "done" && !options.force)
      assertReviewAllowsDone(item, bot.reviewBeforeDone ?? false);
    if (status === "waiting" && !options.waitText && !item.wait && !item.waitFor)
      throw new BotsError("invalid_argument", "Waiting needs what it waits on");
    const next = withStatus(item, status, this.now(), {
      waitText: options.waitText,
      closeNote: options.reason,
    });
    const saved = this.saveItem(next);
    this.storage.addItemEvent(saved, "status", this.actorOf(actor, botId), {
      from: item.status,
      to: status,
      ...(options.reason ? { reason: options.reason } : {}),
    });
    if (actor === "bot") {
      if (status === "done") this.itemNote(saved, "done", `Marked #${saved.number} done`, status);
      else
        this.itemNote(
          saved,
          "moved",
          `Moved #${saved.number} to ${BOT_ITEM_STATUS_LABELS[status]}`,
          status,
        );
    }
    return saved;
  }

  setItem(botId: string, itemId: string, patch: BotItemPatch): BotItem {
    const item = this.storage.findItem(botId, itemId);
    if (patch.status && patch.status !== item.status) assertTransition(item, patch.status, "bot");
    if (patch.status === "done")
      assertReviewAllowsDone(item, this.storage.bot(botId).reviewBeforeDone ?? false);
    const next = patchItem(item, patch, this.now());
    const saved = this.saveItem(next);
    if (next.status !== item.status)
      this.storage.addItemEvent(
        saved,
        "status",
        { kind: "bot", botId },
        {
          from: item.status,
          to: next.status,
        },
      );
    const edited = (["title", "doneMeans", "description"] as const).filter(
      (k) => patch[k] !== undefined,
    );
    if (edited.length > 0)
      this.storage.addItemEvent(saved, "edited", { kind: "bot", botId }, { fields: edited });
    return saved;
  }

  ask(botId: string, itemId: string, ask: BotItemAsk): BotItem {
    const item = this.storage.findItem(botId, itemId);
    assertTransition(item, "needs_you", "bot");
    const event = this.storage.addItemEvent(
      item,
      "commented",
      { kind: "bot", botId },
      {
        text: ask.context ?? "",
        questions: ask.questions.map((q) => q.prompt),
      },
    );
    const asked = withAsk(
      commentItem(
        item,
        [ask.context, ...ask.questions.map((q) => q.prompt)].filter(Boolean).join("\n"),
        "bot",
        this.now(),
      ),
      ask,
      event.id,
    );
    const saved = this.saveItem({ ...asked, lastActivityAt_ms: this.now() });
    if (item.status !== "needs_you")
      this.storage.addItemEvent(
        saved,
        "status",
        { kind: "bot", botId },
        { from: item.status, to: "needs_you" },
      );
    this.itemNote(saved, "asked", `Asked you about #${saved.number}`, "needs_you");
    return saved;
  }

  comment(
    botId: string,
    itemId: string,
    text: string,
    author: "bot" | "owner" | "daemon" | "worker" | "review" = "bot",
  ): BotItem {
    const item = this.storage.findItem(botId, itemId);
    if (author === "bot" && (item.status === "done" || item.status === "canceled"))
      throw new BotsError("item_closed", "Item is closed");
    const saved = this.saveItem(commentItem(item, text, author, this.now()));
    this.storage.addItemEvent(saved, "commented", commentActor(author, botId), { text });
    if (author === "bot") this.itemNote(saved, "commented", `Commented on #${saved.number}`);
    return saved;
  }

  /** The owner's comment: on a Needs you item it is their answer, so the item goes back to work. */
  ownerComment(botId: string, itemId: string, text: string): BotItem {
    const item = this.comment(botId, itemId, text, "owner");
    if (item.status !== "needs_you") {
      this.wake(
        botId,
        `Your owner commented on item #${item.number} (${item.title}):\n${text}`,
        "item",
        `comment:${item.comments.at(-1)!.id}`,
      );
      return item;
    }
    const resumed = this.setStatus(botId, item.id, "working", "owner");
    this.wake(
      botId,
      `Your owner answered item #${item.number} (${item.title}):\n${text}\nResume this item's existing worker if appropriate.`,
      "answer",
      `answer:${item.comments.at(-1)!.id}`,
    );
    return resumed;
  }

  link(botId: string, itemId: string, link: BotItemLink): BotItem {
    const item = this.storage.findItem(botId, itemId);
    const saved = this.saveItem(withLink(item, link));
    this.storage.addItemEvent(saved, "linked", { kind: "bot", botId }, { link });
    return saved;
  }

  snooze(botId: string, itemId: string, until: number | null): BotItem {
    const item = this.storage.findItem(botId, itemId);
    if (item.status === "done" || item.status === "canceled")
      throw new BotsError("item_closed", "Item is closed");
    assertSnooze(until, this.now());
    const saved = this.saveItem({
      ...item,
      snoozedUntil_ms: until ?? undefined,
      lastActivityAt_ms: until === null ? this.now() : item.lastActivityAt_ms,
    });
    this.storage.addItemEvent(
      saved,
      until === null ? "unsnoozed" : "snoozed",
      { kind: "owner" },
      until === null ? {} : { until_ms: until },
    );
    return saved;
  }

  /** Owner's "Done" on an item row; "Mark done anyway" passes `force`. */
  async ownerDone(botId: string, itemId: string, force = false): Promise<BotItem> {
    const item = this.setStatus(botId, itemId, "done", "owner", { force });
    this.wake(
      botId,
      `Your owner marked item #${item.number} (${item.title}) done.`,
      "item",
      `owner-done:${item.id}`,
    );
    return item;
  }

  async cancel(
    botId: string,
    itemId: string,
    reason: string,
    actor: ItemActorKind = "owner",
  ): Promise<BotItem> {
    const item = this.storage.findItem(botId, itemId);
    const commented = this.saveItem(
      commentItem(item, reason, actor === "owner" ? "owner" : actor, this.now()),
    );
    const updated = this.setStatus(
      botId,
      commented.id,
      "canceled",
      actor === "bot" ? "bot" : "owner",
      { reason },
    );
    for (const id of item.workerAgentIds) await this.runtime.cancel(id);
    return updated;
  }

  async cancelMany(botId: string, itemIds: readonly string[], reason: string): Promise<string[]> {
    const canceled: string[] = [];
    for (const id of itemIds) {
      const item = this.storage.findItem(botId, id);
      if (item.status === "done" || item.status === "canceled") continue;
      await this.cancel(botId, item.id, reason);
      canceled.push(item.id);
    }
    if (canceled.length > 0) {
      this.emit({ type: "bots.items_changed", payload: { botId } });
      this.wake(
        botId,
        `Your owner canceled ${canceled.length} item${canceled.length === 1 ? "" : "s"}: ${reason}`,
        "item",
        `cancel-many:${canceled.join(",")}`,
      );
    }
    return canceled;
  }

  /** `bots.avatar.upload`: the picture is the home's avatar.png; the record names its hash. */
  async uploadAvatar(botId: string, base64: string): Promise<Bot> {
    const bot = this.storage.bot(botId);
    const png = Buffer.from(base64, "base64");
    assertBotAvatarImage(png);
    await writeFile(join(this.storage.botHome(bot), "avatar.png"), png, { mode: 0o600 });
    const hash = createHash("sha256").update(png).digest("hex").slice(0, 16);
    const saved = this.storage.saveBot({ ...this.storage.bot(botId), avatar: `upload:${hash}` });
    this.changed(botId);
    return saved;
  }

  async readAvatar(botId: string): Promise<string | null> {
    const bot = this.storage.bot(botId);
    if (!bot.avatar?.startsWith("upload:")) return null;
    const png = await readFile(join(this.storage.botHome(bot), "avatar.png")).catch(() => null);
    return png ? png.toString("base64") : null;
  }

  markSeen(botId: string): Bot {
    const bot = this.storage.saveBot({ ...this.storage.bot(botId), itemsSeen_ms: this.now() });
    this.changed(botId);
    return bot;
  }

  async startWorker(
    botId: string,
    itemId: string,
    repo: string | undefined,
    assignment: string,
  ): Promise<{ agentId: string; item: BotItem }> {
    const bot = this.storage.bot(botId);
    const item = this.storage.findItem(botId, itemId);
    if (
      this.workerStarts.has(item.id) ||
      item.workerAgentIds.length ||
      ["done", "canceled"].includes(item.status)
    )
      throw new Error("Item already has a worker or is closed");
    const target = repo ?? bot.defaultRepo;
    if (!target) throw new Error("Choose a target repository");
    this.workerStarts.add(item.id);
    this.setStatus(botId, item.id, "working", "bot");
    try {
      const agentId = await this.runtime.startWorker(
        bot,
        item,
        target,
        `${assignment}\nDone means: ${item.doneMeans}\nUse this worktree only. Stage new files before finishing. Report a concise summary, tests and remaining uncertainty. You own the pull request you open until it is ready to merge: watch its checks and reviews, fix what fails or is asked, then report. You are the ORC Lead; use ORC Peers for bounded assignments if needed. Do not merge without the owner's request.`,
        (id, worktree, baseCommit) => {
          const current = this.storage.item(botId, item.id);
          const linked = withLink(
            { ...current, workerAgentIds: [id], worktree, baseCommit },
            {
              kind: "dispatch",
              ref: id,
              title: item.title,
              state: "working",
              worktree,
              startedAt_ms: this.now(),
              settledAt_ms: null,
              report: null,
            },
          );
          const saved = this.saveItem(linked);
          this.storage.addItemEvent(
            saved,
            "linked",
            { kind: "bot", botId },
            { link: { kind: "dispatch", ref: id } },
          );
          this.activity(botId, ["chats"]);
        },
      );
      return { agentId, item: this.storage.item(botId, item.id) };
    } catch (err) {
      const current = this.storage.item(botId, item.id);
      this.saveItem(
        commentItem(current, `Worker could not start: ${String(err)}`, "daemon", this.now()),
      );
      this.setStatus(botId, item.id, "needs_you", "daemon");
      this.sendPush(bot, "couldNotFinish", {
        title: `${bot.name} couldn't finish`,
        body: `Worker could not start: ${item.title}`,
        data: { type: "bot_could_not_finish", botId, itemId: item.id },
      });
      throw err;
    } finally {
      this.workerStarts.delete(item.id);
    }
  }

  /** Round-1 answer by question index; the last answer moves the item back to work. */
  async answer(
    botId: string,
    itemId: string,
    answers: { questionIndex: number; text: string }[],
  ): Promise<BotItem> {
    const item = this.storage.findItem(botId, itemId);
    if (item.status !== "needs_you" || !item.questions?.length)
      throw new BotsError("invalid_argument", "Item has no unanswered questions");
    const questions = item.questions.map((q) => ({ ...q }));
    const seen = new Set<number>();
    for (const answer of answers) {
      const q = questions[answer.questionIndex];
      if (!q || q.answer !== undefined || seen.has(answer.questionIndex))
        throw new BotsError("invalid_argument", "Question already answered or missing");
      q.answer = answer.text;
      seen.add(answer.questionIndex);
    }
    // Review before done, exhausted (spec 37.3.7 step 3).
    const reviewChoice = item.review?.state === "blocked" ? answers[0]?.text : undefined;
    if (reviewChoice === "Mark done anyway") {
      this.comment(botId, item.id, "Owner: Mark done anyway", "owner");
      return this.ownerDone(botId, item.id, true);
    }
    if (reviewChoice === "Send back to the worker") {
      this.comment(botId, item.id, "Owner: Send back to the worker", "owner");
      const worked = this.saveItem({
        ...withStatus(this.storage.item(botId, item.id), "working", this.now()),
        review: { state: "pending", round: 0 },
        reviewRounds: 0,
      });
      const worker = worked.workerAgentIds[0];
      if (worker)
        await this.runtime.send(
          worker,
          `Your owner sent this back. Fix the remaining review findings and report when ready:\n${reviewSummary(worked.reviews)}`,
          undefined,
          this.storage.bot(botId).agentId,
        );
      return worked;
    }
    const allAnswered = questions.every((q) => q.answer !== undefined);
    const text = answers
      .map((a) => `${questions[a.questionIndex].text}\nOwner: ${a.text}`)
      .join("\n\n");
    const commented = this.comment(botId, item.id, text, "owner");
    if (!allAnswered) return this.saveItem({ ...commented, questions });
    const updated = this.setStatus(botId, item.id, "working", "owner");
    this.wake(
      botId,
      `Your owner answered item #${updated.number} (${updated.title}):\n${text}\nResume this item's existing worker if appropriate.`,
      "answer",
      `answer:${commented.comments.at(-1)!.id}`,
    );
    return updated;
  }

  // ── Round-1 schedules, kept as the bot's automations ─────────────────

  saveSchedule(botId: string, raw: BotScheduleInput, scheduleId?: string) {
    const input = BotScheduleInputSchema.parse(raw);
    const bot = this.storage.bot(botId);
    if (scheduleId && !bot.schedules.some((s) => s.id === scheduleId))
      throw new BotsError("not_found", "Schedule not found");
    const cadence = { type: "cron" as const, expression: input.cron, timezone: input.timezone };
    validateScheduleCadence(cadence);
    const schedule = {
      ...input,
      id: scheduleId ?? randomUUID(),
      nextRunAt_ms: computeNextRunAt(cadence, new Date(this.now())).getTime(),
    };
    this.storage.saveBot({
      ...bot,
      schedules: [...bot.schedules.filter((s) => s.id !== schedule.id), schedule],
    });
    this.changed(botId);
    this.activity(botId, ["automations"]);
    return schedule;
  }
  deleteSchedule(botId: string, scheduleId: string): void {
    const bot = this.storage.bot(botId);
    if (!bot.schedules.some((s) => s.id === scheduleId))
      throw new BotsError("not_found", "Schedule not found");
    this.storage.saveBot({ ...bot, schedules: bot.schedules.filter((s) => s.id !== scheduleId) });
    this.changed(botId);
    this.activity(botId, ["automations"]);
  }

  // ── Handoff and groups (spec 37.3.6) ───────────────────────────────────

  /** `main/bots/bot-request-policy.ts:9-13,100-130`. */
  async handoff(
    fromId: string,
    toId: string,
    text: string,
    type: "status" | "handoff" | "question" = "handoff",
  ): Promise<void> {
    if (fromId === toId) throw new BotsError("invalid_argument", "Cannot hand off to yourself");
    const from = this.storage.bot(fromId);
    const to = this.storage.bot(toId);
    if (to.paused) throw new BotsError("paused", "Target bot is paused");
    const verb = HANDOFF_VERBS[type];
    this.wake(toId, `${from.name} (@${from.slug}) ${verb}:\n${text}`, "handoff");
  }
  saveRoom(input: {
    id?: string;
    name: string;
    memberBotIds: string[];
    replyMode?: BotGroupReplyMode;
  }) {
    for (const id of input.memberBotIds) this.storage.bot(id);
    const previous = input.id ? this.storage.room(input.id) : undefined;
    const room = this.storage.saveRoom({
      ...input,
      id: input.id ?? randomUUID(),
      memberBotIds: [...new Set(input.memberBotIds)],
      messages: previous?.messages ?? [],
      replyMode: input.replyMode ?? previous?.replyMode ?? { kind: "mentions" },
      folder:
        previous?.folder ??
        `group-${
          input.name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "group"
        }`,
    });
    this.emit({ type: "bots.room.changed", payload: { roomId: room.id } });
    return room;
  }
  sendRoom(
    roomId: string,
    text: string,
    id: string = randomUUID(),
    speaker?: Bot,
    rootId?: string,
  ): BotMessage {
    const room = this.storage.room(roomId);
    const message: BotMessage = {
      id,
      botId: speaker?.id ?? "owner",
      role: speaker ? "assistant" : "user",
      text,
      source: "room",
      roomId,
      rootId: rootId ?? id,
      createdAt_ms: this.now(),
    };
    if (room.messages.some((m) => m.id === id)) return room.messages.find((m) => m.id === id)!;
    this.storage.saveRoom({ ...room, messages: [...room.messages, message] });
    this.emit({ type: "bots.room.changed", payload: { roomId } });
    const mentions = mentionedSlugs(text);
    const everyone = mentionsEveryone(text);
    const members = this.storage.listBots().filter((bot) => room.memberBotIds.includes(bot.id));
    const explicit = everyone || members.some((bot) => mentions.has(bot.slug));
    const mode = room.replyMode ?? { kind: "mentions" as const };
    for (const bot of members) {
      if (bot.id === speaker?.id || bot.paused) continue;
      const named = everyone || mentions.has(bot.slug);
      // `@Name`/`@everyone` win; without one the owner's post follows the reply mode. A bot's
      // reply wakes only the bots it names.
      const wakes = explicit
        ? named
        : !speaker && (mode.kind === "all" || (mode.kind === "bot" && mode.botId === bot.id));
      if (!wakes) continue;
      // At most one turn per member per root post bounds loops and makes replay idempotent.
      const history = this.storage
        .room(roomId)
        .messages.slice(-30)
        .map((m) => `${m.botId}: ${m.text}`)
        .join("\n");
      this.wake(
        bot.id,
        `Group ${room.name} (${roomId}), root ${message.rootId}. ${named ? "You were @mentioned." : "Your owner posted."} Reply to the group; name another member only to hand off.\n${history}`,
        "room",
        `room:${roomId}:${message.rootId}:${bot.id}`,
        { roomId, rootId: message.rootId },
      );
    }
    return message;
  }

  // ── Runtime events: replies, workers, reviews ────────────────────────────

  private async handleRuntimeEvent(event: BotRuntimeEvent): Promise<void> {
    if (this.shuttingDown) return;
    const bots = this.storage.listBots();
    if (event.kind === "resolved") {
      const owner = bots.find((b) => this.runtime.agents(b).some((a) => a.id === event.agentId));
      if (owner) this.activity(owner.id, ["needs_you"]);
      return;
    }
    const bot = bots.find((b) => b.agentId === event.agentId);
    if (bot) {
      if (event.kind === "ask") this.activity(bot.id, ["needs_you"]);
      else await this.homeTurnEnded(bot, event);
      return;
    }
    for (const owner of bots) {
      const item = this.storage
        .items(owner.id)
        .find((i) => i.workerAgentIds.includes(event.agentId));
      if (item) {
        await this.workerEvent(owner, item, event);
        return;
      }
      if (event.kind === "ask" && this.runtime.agents(owner).some((a) => a.id === event.agentId)) {
        this.activity(owner.id, ["needs_you"]);
        this.sendPush(owner, "needsPermission", {
          title: `${owner.name} needs your approval`,
          body: "A worker needs permission",
          data: { type: "bot_permission", botId: owner.id, agentId: event.agentId },
        });
      }
    }
  }

  /** The Home Chat's turn ended: post its reply where it was asked, end first run, keep memory. */
  private async homeTurnEnded(bot: Bot, event: BotRuntimeEvent): Promise<void> {
    const active = this.storage.state(`active:${bot.id}`, BotMessageSchema.nullable());
    if (!quiet(event.text)) this.postReply(bot, event, active);
    // First run ends with the owner's first turn (spec 37.4.2).
    if (bot.firstRun && active?.source === "chat") {
      this.storage.saveBot({ ...this.storage.bot(bot.id), firstRun: false });
      this.changed(bot.id);
    }
    this.storage.setState(`active:${bot.id}`, null);
    await this.memory
      .reconcile(bot, event.agentId)
      .catch((err) =>
        this.options.logger.warn({ err, botId: bot.id }, "Bot memory reconcile failed"),
      );
    this.activity(bot.id, ["chats", "needs_you"]);
  }

  private postReply(bot: Bot, event: BotRuntimeEvent, active: BotMessage | null | undefined): void {
    const message: BotMessage = {
      id: `reply:${bot.id}:${event.key}`,
      botId: bot.id,
      role: "assistant",
      text: event.text,
      source: event.kind,
      rootId: active?.rootId,
      slack: active?.slack,
      createdAt_ms: this.now(),
    };
    if (!this.storage.append(message)) return;
    this.emit({ type: "bots.chat.message", payload: { message } });
    if (!active) return;
    for (const listener of this.replyListeners) listener(active, message);
    const roomId = active.roomId;
    if (
      roomId &&
      this.storage.rooms().some((room) => room.id === roomId && room.memberBotIds.includes(bot.id))
    )
      this.sendRoom(roomId, message.text, message.id, bot, active.rootId);
  }

  private async workerEvent(owner: Bot, item: BotItem, event: BotRuntimeEvent): Promise<void> {
    const dedupe = `worker-event:${event.agentId}:${event.kind}:${event.key}`;
    if (this.storage.state(dedupe, z.boolean())) return;
    this.storage.setState(dedupe, true);
    if (event.kind === "escalation") this.workerEscalated(owner, item, event, dedupe);
    else if (event.kind === "ask") this.workerAsked(owner, item, event);
    else if (event.kind === "error") this.workerFailed(owner, item, event, dedupe);
    else await this.workerDone(owner, item, event, dedupe);
    this.activity(owner.id, ["chats", "needs_you"]);
  }

  private workerEscalated(owner: Bot, item: BotItem, event: BotRuntimeEvent, dedupe: string): void {
    const commented = this.comment(owner.id, item.id, event.text, "worker");
    this.ask(owner.id, commented.id, {
      context: "The worker escalated this to you.",
      questions: [
        {
          prompt: "How should we resolve this worker escalation?",
          options: [
            { label: "Continue with your recommendation" },
            { label: "I will investigate" },
            { label: "Cancel this item" },
          ],
        },
      ],
    });
    this.wake(
      owner.id,
      `Worker ${event.agentId} escalated item #${item.number} to your owner:\n${event.text}`,
      "worker_escalation",
      dedupe,
    );
  }

  /** The card shows in the bot's chat and in Needs you; the bot is not woken (spec 37.3.3). */
  private workerAsked(owner: Bot, item: BotItem, event: BotRuntimeEvent): void {
    this.comment(
      owner.id,
      item.id,
      `Worker asks for permission: ${event.text.slice(0, 2000)}`,
      "daemon",
    );
    this.sendPush(owner, "needsPermission", {
      title: `${owner.name} needs your approval`,
      body: `Worker on #${item.number}: ${item.title}`,
      data: { type: "bot_permission", botId: owner.id, itemId: item.id, agentId: event.agentId },
    });
  }

  private workerFailed(owner: Bot, item: BotItem, event: BotRuntimeEvent, dedupe: string): void {
    this.settleWorkerLink(item, event.agentId, "failed", event.text);
    const current = this.storage.item(owner.id, item.id);
    if (/usage limit|rate limit|quota/i.test(event.text)) {
      // The item's worker hit a usage limit (`main/bots/bot-item-usage-limit-wait.ts`).
      this.setStatus(owner.id, current.id, "waiting", "daemon", { waitText: "Usage limit reset" });
    } else {
      this.saveItem(commentItem(current, event.text, "worker", this.now()));
      this.setStatus(owner.id, current.id, "needs_you", "daemon");
      this.sendPush(owner, "couldNotFinish", {
        title: `${owner.name} couldn't finish`,
        body: item.title,
        data: { type: "bot_could_not_finish", botId: owner.id, itemId: item.id },
      });
    }
    this.wake(
      owner.id,
      `Worker ${event.agentId} failed on item #${item.number}: ${event.text}`,
      "worker_error",
      dedupe,
    );
  }

  private async workerDone(
    owner: Bot,
    item: BotItem,
    event: BotRuntimeEvent,
    dedupe: string,
  ): Promise<void> {
    this.settleWorkerLink(item, event.agentId, "completed", event.text);
    if (owner.reviewBeforeDone) {
      if (this.enabled && !owner.paused) await this.reviewItem(owner.id, item.id, event.text);
      else this.storage.setState(`review-pending:${item.id}`, event.text);
      return;
    }
    // Default (spec 37.3.2 step 5): the bot records the result on the item, then closes it.
    this.wake(
      owner.id,
      `Worker ${event.agentId} finished item #${item.number} (${item.title}). Its report:\n${event.text}\nPut the result on the item with bot_item_comment (summary and diff/PR link), then bot_item_done when "done means" is met. Reply in chat only if your owner needs to read or decide something; otherwise end with ${BOT_QUIET_MARKER}.`,
      "worker_done",
      dedupe,
    );
  }

  private settleWorkerLink(
    item: BotItem,
    agentId: string,
    state: "completed" | "failed",
    report: string,
  ): void {
    const current = this.storage.item(item.botId, item.id);
    const links = (current.links ?? []).map((link) =>
      link.kind === "dispatch" && link.ref === agentId
        ? Object.assign({}, link, {
            state,
            settledAt_ms: this.now(),
            report: report.slice(0, 8000),
          })
        : link,
    );
    const prs = [...report.matchAll(/https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)].map(
      (m) => m[0],
    );
    let next: BotItem = { ...current, links, summary: report.slice(0, 20000) };
    for (const url of prs) {
      const ref = prRefOfUrl(url);
      if (ref) next = withLink(next, { kind: "pr", ref, url });
    }
    this.saveItem(next);
  }

  /** Review before done (spec 37.3.7), round-1 behavior on this path only. */
  async reviewItem(botId: string, itemId: string, summary: string): Promise<void> {
    if (this.reviewing.has(itemId)) return;
    this.reviewing.add(itemId);
    this.storage.setState(`review-pending:${itemId}`, summary);
    let retainPending = false;
    try {
      const bot = this.storage.bot(botId);
      const item = this.storage.item(botId, itemId);
      if (["done", "canceled"].includes(item.status)) return;
      if (item.status === "needs_you" && item.questions?.some((q) => q.answer === undefined))
        return;
      const round = item.reviewRounds + 1;
      this.saveItem({ ...item, review: { state: "running", round: Math.min(round, 2) } });
      this.comment(botId, itemId, `Review round ${Math.min(round, 2)} of 2 started`, "review");
      const result = await reviewWorker(
        this.runtime,
        bot,
        this.storage.item(botId, itemId),
        () =>
          !this.shuttingDown &&
          (!this.hasStarted || this.enabled) &&
          !this.storage.bot(botId).paused,
      );
      const current = this.storage.item(botId, itemId);
      if ((this.hasStarted && !this.enabled) || this.storage.bot(botId).paused) {
        retainPending = true;
        return;
      }
      if (current.status === "canceled") return;
      const blocking = blockingFindingCount(result.reviews);
      const updated = commentItem(
        {
          ...current,
          reviews: [...current.reviews, ...result.reviews],
          summary,
          diff: result.diff,
        },
        reviewSummary(result.reviews),
        "review",
        this.now(),
      );
      if (!result.blocked)
        this.reviewPassed(botId, updated, result.hash, Math.min(round, 2), summary);
      else if (current.reviewRounds < 2)
        await this.reviewSendBack(bot, updated, blocking, result.reviews);
      else this.reviewExhausted(botId, updated, result.reviews);
    } catch (err) {
      if (
        this.shuttingDown ||
        (this.hasStarted && !this.enabled) ||
        this.storage.bot(botId).paused
      ) {
        retainPending = true;
        return;
      }
      const item = this.storage.item(botId, itemId);
      if (!["done", "canceled"].includes(item.status)) {
        this.saveItem(
          commentItem(item, `Review could not complete: ${String(err)}`, "daemon", this.now()),
        );
        this.setStatus(botId, itemId, "needs_you", "daemon");
      }
    } finally {
      this.reviewing.delete(itemId);
      if (!retainPending) this.storage.setState(`review-pending:${itemId}`, null);
    }
  }

  private reviewPassed(
    botId: string,
    updated: BotItem,
    hash: string,
    round: number,
    summary: string,
  ): void {
    const passed = this.saveItem({
      ...updated,
      reviewedDiffHash: hash,
      review: { state: "passed", round },
    });
    const diff = passed.worktree ? ` Diff: ${passed.worktree}` : "";
    this.comment(botId, passed.id, `BA, Tester and Pentester reviews passed.${diff}`, "review");
    this.setStatus(botId, passed.id, "done", "daemon");
    this.wake(
      botId,
      `Item #${passed.number} passed BA/Tester/Pentester review and is done. Summary: ${summary}`,
      "worker_done",
      `done:${passed.id}`,
    );
  }

  /** Spec 37.3.7 step 2: blocking findings go back to the same worker, at most 2 rounds. */
  private async reviewSendBack(
    bot: Bot,
    updated: BotItem,
    blocking: number,
    reviews: Parameters<typeof reviewSummary>[0],
  ): Promise<void> {
    const saved = this.saveItem({
      ...updated,
      status: "working",
      reviewRounds: updated.reviewRounds + 1,
      review: { state: "pending", round: updated.reviewRounds + 1 },
    });
    this.comment(
      bot.id,
      saved.id,
      `Review round ${saved.reviewRounds} of 2: ${blocking} blocking findings`,
      "review",
    );
    this.storage.setState(`review-pending:${saved.id}`, null);
    await this.runtime.send(
      saved.workerAgentIds[0],
      `Cross-review found blocking findings. Fix round ${saved.reviewRounds}/2. Fix in this worktree and report when ready:\n${reviewSummary(reviews)}`,
      undefined,
      bot.agentId ?? undefined,
    );
  }

  /** Spec 37.3.7 step 3: after two rounds the owner decides. */
  private reviewExhausted(
    botId: string,
    updated: BotItem,
    reviews: Parameters<typeof reviewSummary>[0],
  ): void {
    const blocked = this.saveItem({ ...updated, review: { state: "blocked", round: 2 } });
    this.ask(botId, blocked.id, {
      context: reviewSummary(reviews),
      questions: [
        {
          prompt: "Fix these or mark the item done anyway?",
          options: [{ label: "Send back to the worker" }, { label: "Mark done anyway" }],
        },
      ],
    });
    this.saveItem({
      ...this.storage.item(botId, blocked.id),
      review: { state: "blocked", round: 2 },
    });
  }

  // ── Look around and Suggestions (spec 37.2.6) ────────────────────────────

  private lookState(botId: string): LookState {
    return this.storage.state(`look:${botId}`, LookStateSchema) ?? { running: false, failures: 0 };
  }
  private setLookState(botId: string, state: LookState): void {
    this.storage.setState(`look:${botId}`, state);
  }
  upNext(bot: Bot): BotUpNextState {
    const state = this.lookState(bot.id);
    const setting = botLookAround(bot);
    const next = setting.on ? nextLookAt(setting, this.now()) : undefined;
    return {
      running: state.running,
      ...(state.lastLookedAt_ms ? { lastLookedAt_ms: state.lastLookedAt_ms } : {}),
      ...(state.tookMs ? { tookMs: state.tookMs } : {}),
      ...(next ? { nextAt_ms: next } : {}),
      ...(state.runAgentId ? { runAgentId: state.runAgentId } : {}),
      ...(state.lastAgentId ? { lastAgentId: state.lastAgentId } : {}),
      ...(state.error ? { error: state.error } : {}),
      ...(state.turnedOff ? { turnedOff: state.turnedOff } : {}),
    };
  }
  suggestions(bot: Bot): { suggestions: BotSuggestion[]; state: BotUpNextState } {
    return { suggestions: this.storage.suggestions(bot.id), state: this.upNext(bot) };
  }

  async lookAround(
    botId: string,
    manual: boolean,
  ): Promise<{ started: boolean; runAgentId?: string }> {
    const bot = this.storage.bot(botId);
    if (!lookAroundSupported(bot.provider))
      throw new BotsError("unsupported", "Look around runs on Claude and Codex bots");
    if (bot.paused) throw new BotsError("paused", "Turn the bot on to look around.");
    const state = this.lookState(botId);
    if (state.running) throw new BotsError("already_running", "Already looking around.");
    if (!manual && !botLookAround(bot).on) return { started: false };
    const started = this.now();
    const noteId = `look:${started}`;
    this.setLookState(botId, { ...state, running: true, noteId, error: undefined });
    const open = this.storage.suggestions(botId).map((s) => s.title);
    const dismissed = this.storage.db
      .prepare("SELECT data FROM suggestions WHERE bot_id=? AND dismissed_until>?")
      .all(botId, started)
      .map((row) => (JSON.parse((row as { data: string }).data) as BotSuggestion).title);
    const startedTitles = this.storage.state(`look-started:${botId}`, z.array(z.string())) ?? [];
    // The line shows at once (spec A37.7.36); it gains the run's conversation once that exists.
    this.note(botId, "Looking around", { kind: "look_around", state: "running" }, noteId);
    this.activity(botId, ["automations"]);
    try {
      const run = await this.runtime.runBackground(bot, this.storage.botHome(bot), {
        kind: "look_around",
        title: "Look around",
        prompt: lookAroundPrompt({
          focus: botLookAround(bot).focus,
          open,
          started: startedTitles,
          dismissed,
        }),
        policy: "look-around",
        timeoutMs: LOOK_AROUND_LIMITS.timeoutMs,
      });
      this.setLookState(botId, { ...this.lookState(botId), runAgentId: run.agentId });
      this.note(
        botId,
        "Looking around",
        { kind: "look_around", state: "running", runAgentId: run.agentId },
        noteId,
      );
      this.activity(botId, ["chats", "automations"]);
      this.emit({ type: "bots.suggestions_changed", payload: { botId } });
      this.launch(this.finishLook(botId, run.agentId, run.done, started, noteId));
      return { started: true, runAgentId: run.agentId };
    } catch (err) {
      this.failLook(botId, String(err), started, noteId, undefined);
      throw err;
    }
  }

  private async finishLook(
    botId: string,
    agentId: string,
    done: Promise<string>,
    started: number,
    noteId: string,
  ): Promise<void> {
    try {
      const reply = await done;
      const drafts = parseSuggestions(reply);
      const blocked = this.storage.suggestionKeysBlocked(botId, this.now());
      let count = 0;
      for (const draft of drafts) {
        const key = suggestionKey(draft);
        if (blocked.has(key)) continue;
        blocked.add(key);
        count += 1;
        this.storage.saveSuggestion(botId, key, {
          id: randomUUID(),
          title: draft.title,
          why: draft.why,
          ask: draft.ask,
          ...(draft.link ? { link: draft.link } : {}),
          ...(suggestionSource(draft.link) ? { source: suggestionSource(draft.link) } : {}),
          createdAt_ms: this.now(),
        });
      }
      this.setLookState(botId, {
        ...this.lookState(botId),
        running: false,
        runAgentId: undefined,
        lastAgentId: agentId,
        lastLookedAt_ms: started,
        tookMs: this.now() - started,
        failures: 0,
        error: undefined,
      });
      this.note(
        botId,
        `Looked around · ${count} suggestions`,
        { kind: "look_around", state: "done", count, runAgentId: agentId },
        noteId,
      );
    } catch (err) {
      this.failLook(
        botId,
        err instanceof Error ? err.message : String(err),
        started,
        noteId,
        agentId,
      );
    } finally {
      this.emit({ type: "bots.suggestions_changed", payload: { botId } });
      this.activity(botId, ["chats", "automations"]);
    }
  }

  private failLook(
    botId: string,
    error: string,
    started: number,
    noteId: string,
    agentId: string | undefined,
  ): void {
    const state = this.lookState(botId);
    const failures = state.failures + 1;
    const turnedOff =
      failures >= LOOK_AROUND_LIMITS.failuresBeforeOff
        ? `Look around failed ${failures} times in a row`
        : undefined;
    this.setLookState(botId, {
      ...state,
      running: false,
      runAgentId: undefined,
      ...(agentId ? { lastAgentId: agentId } : {}),
      lastLookedAt_ms: started,
      failures,
      error,
      ...(turnedOff ? { turnedOff } : {}),
    });
    if (turnedOff) {
      const bot = this.storage.bot(botId);
      this.storage.saveBot({
        ...bot,
        lookAround: { ...bot.lookAround, on: false, enabled: false },
      });
      this.changed(botId);
    }
    this.note(
      botId,
      "Look around failed",
      { kind: "look_around", state: "failed", ...(agentId ? { runAgentId: agentId } : {}) },
      noteId,
    );
  }

  startSuggestion(botId: string, suggestionId: string): BotMessage {
    const suggestion = this.storage.suggestion(botId, suggestionId);
    this.storage.deleteSuggestion(botId, suggestionId);
    const started = this.storage.state(`look-started:${botId}`, z.array(z.string())) ?? [];
    this.storage.setState(`look-started:${botId}`, [suggestion.title, ...started].slice(0, 10));
    const message = this.wake(botId, suggestion.ask, "chat", `suggestion:${suggestionId}`);
    this.emit({ type: "bots.suggestions_changed", payload: { botId } });
    return message ?? this.storage.message(`${botId}:suggestion:${suggestionId}`)!;
  }

  dismissSuggestion(botId: string, suggestionId: string): void {
    this.storage.dismissSuggestion(
      botId,
      suggestionId,
      this.now() + LOOK_AROUND_LIMITS.dismissHiddenMs,
    );
    this.emit({ type: "bots.suggestions_changed", payload: { botId } });
  }

  // ── Tidy memory (spec 37.2.6) ────────────────────────────────────────────

  private tidyState(botId: string): TidyState {
    return this.storage.state(`tidy:${botId}`, TidyStateSchema) ?? { running: false, failures: 0 };
  }
  tidyView(bot: Bot): BotTidyUpView {
    const state = this.tidyState(bot.id);
    const setting = bot.tidyUp ?? { on: true, every: "night" as const };
    return {
      setting: { on: setting.on, every: setting.every },
      running: state.running,
      ...(state.last ? { last: state.last } : {}),
      ...(setting.on ? { nextAt_ms: nextTidyAt(this.now()) } : {}),
      ...(state.turnedOff ? { turnedOff: state.turnedOff } : {}),
      ...(state.error ? { error: state.error } : {}),
    };
  }

  private async tidyChats(bot: Bot, since: number) {
    const lines = this.storage
      .history(bot.id, 400)
      .filter(
        (m) => m.createdAt_ms > since && !m.note && (m.role === "user" || m.role === "assistant"),
      )
      .map((m) => ({
        by: m.role === "user" ? ("owner" as const) : ("bot" as const),
        text: m.text,
      }));
    return lines.length ? [{ title: "Home Chat", lines }] : [];
  }

  private async memoryFiles(bot: Bot): Promise<{ topics: string; archive: string }> {
    const dir = join(this.storage.botHome(bot), "memory");
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md"));
    let topics = "";
    let archive = "";
    for (const name of names.sort()) {
      const text = await readFile(join(dir, name), "utf8").catch(() => "");
      if (name === "archive.md") archive = text.slice(-6_000);
      else if (topics.length < 12_000) topics += `## ${name}\n${text.slice(0, 3_000)}\n\n`;
    }
    return { topics: topics.trim(), archive };
  }

  async tidyUp(botId: string, manual: boolean): Promise<{ started: boolean }> {
    const bot = this.storage.bot(botId);
    if (!lookAroundSupported(bot.provider))
      throw new BotsError("unsupported", "Tidy memory runs on Claude and Codex bots");
    if (bot.paused) throw new BotsError("paused", "Turn the bot on to tidy its memory.");
    const state = this.tidyState(botId);
    if (state.running) throw new BotsError("already_running", "Already tidying.");
    if (!manual && !(bot.tidyUp?.on ?? true)) return { started: false };
    const started = this.now();
    const noteId = `tidy:${started}`;
    const before = await this.memory.text(bot);
    const files = await this.memoryFiles(bot);
    const chats = await this.tidyChats(bot, state.lastRunAt_ms ?? started - DAY_MS);
    this.storage.setState(`tidy:${botId}`, { ...state, running: true, error: undefined });
    this.note(botId, "Tidying…", { kind: "tidy_up", state: "running" }, noteId);
    this.activity(botId, ["automations", "tidy_up"]);
    try {
      const run = await this.runtime.runBackground(bot, this.storage.botHome(bot), {
        kind: "tidy_up",
        title: "Tidy memory",
        prompt: tidyUpPrompt({
          memory: before,
          topics: files.topics,
          archive: files.archive,
          chats,
        }),
        policy: "reply-only",
        timeoutMs: TIDY_UP_LIMITS.timeoutMs,
      });
      this.storage.setState(`tidy:${botId}`, { ...this.tidyState(botId), runAgentId: run.agentId });
      this.note(
        botId,
        "Tidying…",
        { kind: "tidy_up", state: "running", runAgentId: run.agentId },
        noteId,
      );
      this.activity(botId, ["chats", "automations", "tidy_up"]);
      this.launch(this.finishTidy(botId, run.agentId, run.done, started, before, noteId));
      return { started: true };
    } catch (err) {
      this.failTidy(botId, String(err), started, noteId, undefined);
      throw err;
    }
  }

  private async finishTidy(
    botId: string,
    agentId: string,
    done: Promise<string>,
    started: number,
    before: string,
    noteId: string,
  ): Promise<void> {
    try {
      const reply = await done;
      const bot = this.storage.bot(botId);
      const current = await this.memory.text(bot);
      // A write since the run read MEMORY.md wins; the draft is dropped.
      if (current !== before) throw new Error("MEMORY.md changed during the tidy-up");
      const result = applyTidyOps(before, parseTidyOps(reply));
      const home = this.storage.botHome(bot);
      if (result.archiveLines.length > 0)
        await appendFile(
          join(home, "memory", "archive.md"),
          `${result.archiveLines.join("\n")}\n`,
          { mode: 0o600 },
        );
      for (const [topic, lines] of result.topics) {
        await mkdir(join(home, "memory"), { recursive: true });
        await appendFile(join(home, "memory", `${topic}.md`), `${lines.join("\n")}\n`, {
          mode: 0o600,
        });
      }
      const rowId = await this.memory.applyTidy(bot, before, result.memory);
      const changes =
        result.replaced.length +
        result.filed.reduce((s, f) => s + f.count, 0) +
        result.moved +
        result.merged;
      const summary: BotTidyUpSummary = {
        runId: noteId,
        at_ms: started,
        tookMs: this.now() - started,
        ...(rowId ? { rowId } : {}),
        learned: [],
        replaced: result.replaced,
        filed: result.filed,
        moved: result.moved,
        merged: result.merged,
        changes,
        undone: false,
        runAgentId: agentId,
      };
      this.storage.setState(`tidy:${botId}`, {
        running: false,
        failures: 0,
        lastRunAt_ms: started,
        last: summary,
        before,
        after: result.memory,
      });
      this.note(
        botId,
        `Tidied memory · ${changes} changes`,
        { kind: "tidy_up", state: "done", count: changes, runAgentId: agentId },
        noteId,
      );
    } catch (err) {
      this.failTidy(
        botId,
        err instanceof Error ? err.message : String(err),
        started,
        noteId,
        agentId,
      );
    } finally {
      this.activity(botId, ["chats", "automations", "tidy_up", "memory"]);
    }
  }

  private failTidy(
    botId: string,
    error: string,
    started: number,
    noteId: string,
    agentId: string | undefined,
  ): void {
    const state = this.tidyState(botId);
    const failures = state.failures + 1;
    const turnedOff =
      failures >= TIDY_UP_LIMITS.failuresBeforeOff
        ? `Tidy memory failed ${failures} times in a row`
        : undefined;
    this.storage.setState(`tidy:${botId}`, {
      ...state,
      running: false,
      runAgentId: undefined,
      lastRunAt_ms: started,
      failures,
      error,
      ...(turnedOff ? { turnedOff } : {}),
    });
    if (turnedOff) {
      const bot = this.storage.bot(botId);
      this.storage.saveBot({ ...bot, tidyUp: { on: false, every: bot.tidyUp?.every ?? "night" } });
      this.changed(botId);
    }
    this.note(
      botId,
      "Tidy memory failed",
      { kind: "tidy_up", state: "failed", ...(agentId ? { runAgentId: agentId } : {}) },
      noteId,
    );
  }

  /** "Undo tidy-up": MEMORY.md back to before that tidy-up, if nothing changed it since. */
  async undoTidy(botId: string, runId: string): Promise<boolean> {
    const bot = this.storage.bot(botId);
    const state = this.tidyState(botId);
    if (
      !state.last ||
      state.last.runId !== runId ||
      state.last.undone ||
      state.before === undefined
    )
      throw new BotsError("superseded", "Nothing left to undo: those lines changed since.");
    const current = await this.memory.text(bot);
    if (current !== state.after) {
      if (!state.last.rowId)
        throw new BotsError("superseded", "Nothing left to undo: those lines changed since.");
      await this.memory.undo(bot, state.last.rowId);
    } else {
      await writeHomeFile(this.storage.botHome(bot), "MEMORY.md", state.before);
      await this.memory.writeAll(bot, state.before);
    }
    this.storage.setState(`tidy:${botId}`, { ...state, last: { ...state.last, undone: true } });
    this.activity(botId, ["tidy_up", "memory"]);
    return true;
  }

  // ── Read models (spec 37.4) ──────────────────────────────────────────────

  needsYou(botId: string): BotNeedsYouRow[] {
    const bot = this.storage.bot(botId);
    return needsYouRows(bot, this.runtime.agents(bot), this.storage.items(botId), this.now());
  }

  chatsTree(botId: string, query?: string): BotChatTree {
    const bot = this.storage.bot(botId);
    return chatTree({
      bot,
      agents: this.runtime.agents(bot),
      items: this.storage.items(botId, true),
      runs: { look: this.lookState(botId), tidy: this.tidyState(botId) },
      ...(query ? { query } : {}),
      workspaceTitle: (id) => this.storage.state(`workspace-title:${id}`, z.string()) ?? id,
    });
  }

  automations(botId: string): { automations: BotAutomation[]; total: number } {
    const bot = this.storage.bot(botId);
    const setting = botLookAround(bot);
    const running = new Set(
      bot.schedules
        .filter((s) => this.storage.state(`schedule-running:${s.id}`, z.boolean()))
        .map((s) => s.id),
    );
    const automations = automationRows({
      bot,
      items: this.storage.items(botId),
      runs: { look: this.lookState(botId), tidy: this.tidyState(botId) },
      nextLookAt: nextLookAt(setting, this.now()),
      nextTidyAt: nextTidyAt(this.now()),
      runningSchedules: running,
    });
    return { automations, total: bot.schedules.length };
  }

  async runAutomationNow(botId: string, automationId: string): Promise<boolean> {
    if (automationId === "look_around") return (await this.lookAround(botId, true)).started;
    if (automationId === "tidy_up") return (await this.tidyUp(botId, true)).started;
    const bot = this.storage.bot(botId);
    if (bot.paused) throw new BotsError("paused", "Turn the bot on to run its automations.");
    const schedule = bot.schedules.find((s) => s.id === automationId);
    if (!schedule) throw new BotsError("not_found", "Automation not found");
    this.runSchedule(bot, schedule, `manual:${this.now()}`);
    return true;
  }

  cancelWait(botId: string, itemId: string): BotItem {
    const item = this.storage.findItem(botId, itemId);
    if (item.status !== "waiting") throw new BotsError("invalid_argument", "Item is not waiting");
    const saved = this.setStatus(botId, item.id, "working", "owner");
    this.wake(
      botId,
      `Your owner canceled the wait on item #${saved.number} (${item.wait?.text ?? ""}). Recheck it.`,
      "wait",
      `wait-cancel:${item.id}:${this.now()}`,
    );
    return saved;
  }

  async allowed(botId: string): Promise<BotAllowedPerson[]> {
    const bot = this.storage.bot(botId);
    const people: BotAllowedPerson[] = [];
    if (this.slack) {
      const status = await this.slack.handle({
        type: "bots.slack.status.request",
        requestId: "allowed",
        botId,
      });
      const allowed =
        (status as { status?: { allowedUsers?: { id: string; name: string }[] } }).status
          ?.allowedUsers ?? [];
      people.push(
        ...allowed.map((user) => ({ source: "slack" as const, id: user.id, name: user.name })),
      );
    }
    for (const source of this.allowedSources) people.push(...(await source(bot)));
    return people;
  }

  // ── Templates and Hand to bot (spec 37.4.10, 37.4.11) ────────────────────

  templates(): BotTemplate[] {
    return BOT_TEMPLATES.map((t) => ({
      id: t.id,
      category: t.category,
      categoryLabel: BOT_TEMPLATE_CATEGORY_LABELS[t.category] ?? t.category,
      name: t.name,
      line: t.line,
      firstChat: t.firstChat,
      mascot: t.mascot,
      watches: t.watches,
      does: t.does,
      reports: t.reports,
      connectors: [...t.connectors],
      schedules: t.schedules.map(({ id, when, what }) => ({ id, when, what })),
      events: t.events.map(({ id, name, source }) => ({ id, name, source })),
      skills: [...t.skills],
      ...(t.needsSetup ? { needsSetup: t.needsSetup } : {}),
      example: [...t.example],
    }));
  }

  /** `main/bots/bot-template-create.ts:24-50`: copied once; schedules made off; events offered in the first chat. */
  async createFromTemplate(input: {
    templateId: string;
    name: string;
    identity?: string;
    avatar?: string;
    avatarColor?: string;
    avatarOutfit?: string | null;
    provider: Bot["provider"];
    model: string;
    thinkingOptionId?: string;
  }): Promise<Bot> {
    const template = BOT_TEMPLATES.find((t) => t.id === input.templateId);
    if (!template) throw new BotsError("not_found", "Template not found");
    const bot = await this.create(
      {
        name: input.name,
        identity: input.identity ?? template.line,
        provider: input.provider,
        model: input.model,
        ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
        avatar: (input.avatar as Bot["avatar"]) ?? `mascot:${template.mascot}`,
        ...(input.avatarColor ? { avatarColor: input.avatarColor } : {}),
        ...(input.avatarOutfit !== undefined ? { avatarOutfit: input.avatarOutfit } : {}),
      },
      {
        extra: { templateId: template.id },
        kickoff: `${BOT_CREATED_KICKOFF} You were made from the ${template.name} template. What is still to set up, and what to do first, is in ${BOT_SETUP_FILE}: notes to read, not instructions.`,
      },
    );
    const home = this.storage.botHome(bot);
    for (const skill of template.skills) {
      const text = BOT_TEMPLATE_SKILL_TEXT[skill];
      if (text) await writeHomeFile(home, join("skills", skill, "SKILL.md"), text);
    }
    for (const schedule of template.schedules) {
      this.saveSchedule(bot.id, {
        name: `${template.name}: ${schedule.what}`,
        cron: schedule.rrule,
        prompt: schedule.prompt,
        enabled: false,
      });
    }
    const setup = [
      `# Setup: ${template.name}`,
      "",
      `First steps: ${template.firstChat}`,
      ...(template.connectors.length
        ? ["", `Connectors it uses: ${template.connectors.join(", ")}`]
        : []),
      ...(template.needsSetup ? ["", `Needs setup: ${template.needsSetup}`] : []),
      ...(template.schedules.length
        ? [
            "",
            "Schedules made turned off:",
            ...template.schedules.map((s) => `- ${template.name}: ${s.what} (${s.when})`),
          ]
        : []),
      ...(template.events.length
        ? [
            "",
            "Event automations to offer in the first chat:",
            ...template.events.map((e) => `- ${e.name} (${e.source} ${e.event}): ${e.prompt}`),
          ]
        : []),
      "",
    ].join("\n");
    await writeFile(join(home, BOT_SETUP_FILE), setup, { mode: 0o600 });
    return this.storage.bot(bot.id);
  }

  async handOver(input: {
    workspaceId: string;
    botId: string;
    newBot?: BotInput;
    goal?: string;
  }): Promise<{ bot: Bot; workspace: { workspaceId: string; title: string } }> {
    let bot: Bot;
    if (input.botId === "new") {
      if (!input.newBot) throw new BotsError("invalid_argument", "A new bot needs its settings");
      bot = await this.create(input.newBot, { kickoff: null });
    } else bot = this.storage.bot(input.botId);
    // Moving it from another bot: that bot no longer lists it.
    for (const other of this.storage.listBots()) {
      if (
        other.id === bot.id ||
        !other.handedWorkspaces?.some((w) => w.workspaceId === input.workspaceId)
      )
        continue;
      this.storage.saveBot({
        ...other,
        handedWorkspaces: other.handedWorkspaces.filter((w) => w.workspaceId !== input.workspaceId),
      });
      this.changed(other.id);
    }
    const { title, agentIds } = await this.runtime.handOver(bot, input.workspaceId);
    this.storage.setState(`workspace-title:${input.workspaceId}`, title);
    const handed = [
      ...(bot.handedWorkspaces ?? []).filter((w) => w.workspaceId !== input.workspaceId),
      { workspaceId: input.workspaceId, at_ms: this.now() },
    ];
    bot = this.storage.saveBot({
      ...this.storage.bot(bot.id),
      handedWorkspaces: handed.slice(-50),
    });
    const count = agentIds.length;
    const agents = count === 0 ? "" : ` (${count} ${count === 1 ? "agent" : "agents"})`;
    const askLine = `I've taken over ${title}${agents}. What should I do with it?`;
    const team =
      count === 0
        ? "It has no agents open."
        : `Its agents keep running and now work for you: ${agentIds.join(", ")}.`;
    const lines = [
      `${TOOK_OVER_TURN_PREFIX}${title} (id:${input.workspaceId}). JAgentDesk already moved it under your home, so don't move it. ${team}]`,
    ];
    if (!input.goal?.trim()) {
      lines.push(
        `Your owner gave no goal for it yet. Run no commands and don't contact its agents. Reply with exactly this one line and nothing else, then wait: "${askLine}"`,
      );
    } else {
      lines.push(
        count === 0
          ? "With no agent to ask, read its pull request and commits to see where things stand."
          : "Ask each of its agents where things stand.",
        "Then tell your owner in a few lines where things stand, and start on what they asked.",
        `${TOOK_OVER_GOAL_HEADING}${input.goal.trim()}`,
      );
    }
    this.note(
      bot.id,
      input.goal?.trim() ?? "",
      { kind: "hand_over" },
      `hand-over:${input.workspaceId}:${this.now()}`,
    );
    this.wake(
      bot.id,
      lines.join("\n\n"),
      "jagentdesk",
      `hand-over:${input.workspaceId}:${this.now()}`,
    );
    this.changed(bot.id);
    this.activity(bot.id, ["chats"]);
    return { bot, workspace: { workspaceId: input.workspaceId, title } };
  }

  // ── Timers ───────────────────────────────────────────────────────────────

  private runSchedule(entry: Bot, schedule: Bot["schedules"][number], key: string): void {
    this.wake(entry.id, schedule.prompt, "schedule", `schedule:${schedule.id}:${key}`);
    this.note(entry.id, schedule.name, { kind: "automation", state: "done" });
  }

  private processSchedules(entry: Bot, now: number): void {
    for (const schedule of entry.schedules) {
      if (!schedule.enabled || schedule.nextRunAt_ms > now) continue;
      this.storage.transaction(() => {
        this.runSchedule(entry, schedule, String(schedule.nextRunAt_ms));
        const current = this.storage.bot(entry.id);
        const nextRunAt_ms = computeNextRunAt(
          { type: "cron", expression: schedule.cron, timezone: schedule.timezone },
          new Date(now),
        ).getTime();
        this.storage.saveBot({
          ...current,
          schedules: current.schedules.map((s) =>
            s.id === schedule.id ? Object.assign({}, s, { nextRunAt_ms }) : s,
          ),
        });
      });
      this.activity(entry.id, ["automations"]);
    }
  }

  private processBackground(entry: Bot, now: number): void {
    if (!lookAroundSupported(entry.provider) || now - this.awakeSince < LOOK_AROUND_LIMITS.awakeMs)
      return;
    const setting = botLookAround(entry);
    const look = this.lookState(entry.id);
    const firstChatAt = this.storage.state(`first-chat:${entry.id}`, z.number());
    if (setting.on && !look.running && !look.turnedOff) {
      const slot = dueLookSlot(setting, {
        now,
        lastLookedAt: look.lastLookedAt_ms,
        since: entry.lookAround.since_ms,
        firstChatAt,
      });
      if (slot !== undefined) this.launch(this.lookAround(entry.id, false));
    }
    const tidySetting = entry.tidyUp ?? { on: true, every: "night" as const };
    const tidy = this.tidyState(entry.id);
    if (
      tidySetting.on &&
      !tidy.running &&
      !tidy.turnedOff &&
      tidyDue({
        every: tidySetting.every,
        now,
        lastRunAt: tidy.lastRunAt_ms,
        lastChatAt: this.storage.state(`last-chat:${entry.id}`, z.number()),
        since: tidySetting.since_ms,
      })
    )
      this.launch(this.tidyUp(entry.id, false));
  }

  private processWaits(entry: Bot, now: number): void {
    for (const item of this.storage.items(entry.id)) {
      if (item.status === "waiting" && item.waitFor && item.waitFor.until_ms <= now) {
        const wait = item.waitFor;
        this.storage.transaction(() => {
          this.setStatus(entry.id, item.id, "working", "daemon");
          this.note(entry.id, `Wait ended: ${wait.condition}`, {
            kind: "wait_ended",
            itemIds: [item.id],
          });
          this.wake(
            entry.id,
            `Wait ended on item #${item.number}: ${wait.condition}. Recheck the condition before acting.`,
            "wait",
            `wait:${item.id}:${wait.until_ms}`,
          );
        });
      }
      const pending = this.storage.state(`review-pending:${item.id}`, z.string().nullable());
      if (pending && entry.reviewBeforeDone)
        this.launch(this.reviewItem(entry.id, item.id, pending));
    }
  }

  private async pollTriggers(entry: Bot): Promise<void> {
    if (!this.options.triggers) return;
    try {
      const events = await this.options.triggers.poll(entry);
      if (!this.enabled || !this.storage.listBots().some((b) => b.id === entry.id && !b.paused))
        return;
      for (const event of events) this.wake(entry.id, event.text, event.source, event.key);
    } catch (err) {
      this.options.logger.warn({ err, botId: entry.id }, "Bot trigger polling failed");
    }
  }

  /** Pushes `bots.home_file_changed` when SOUL.md or MEMORY.md changed on disk (spec 37.4.9). */
  private async watchHomeFiles(entry: Bot): Promise<void> {
    for (const file of ["SOUL.md", "MEMORY.md"] as const) {
      const key = `${entry.id}:${file}`;
      const info = await stat(join(this.storage.botHome(entry), file)).catch(() => null);
      const mtime = info?.mtimeMs ?? 0;
      const seen = this.homeFileTimes.get(key);
      this.homeFileTimes.set(key, mtime);
      if (seen === undefined || seen === mtime) continue;
      const { hash } = await this.memory.readFile(entry, file);
      this.emit({ type: "bots.home_file_changed", payload: { botId: entry.id, file, hash } });
    }
  }

  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (this.lastTickAt !== 0 && now - this.lastTickAt > SLEEP_GAP_MS) this.awakeSince = now;
      this.lastTickAt = now;
      for (const entry of this.storage.listBots()) {
        if (!this.enabled) break;
        if (entry.paused) continue;
        if (!this.storage.state(`first-chat:${entry.id}`, z.number())) {
          const last = this.storage.state(`last-chat:${entry.id}`, z.number());
          if (last) this.storage.setState(`first-chat:${entry.id}`, last);
        }
        this.launch(this.watchHomeFiles(entry));
        this.processSchedules(entry, now);
        this.processWaits(entry, now);
        this.processBackground(entry, now);
        this.launch(this.drain(entry.id));
        this.launch(this.pollTriggers(entry));
      }
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (this.enabled) return;
    const firstStart = !this.hasStarted;
    this.enabled = true;
    this.hasStarted = true;
    this.awakeSince = this.now();
    if (firstStart) {
      for (const bot of this.storage.listBots()) {
        this.launch(this.migrateRound1(bot));
        // Runs cut by a restart are not failures; they are not running any more.
        const look = this.lookState(bot.id);
        if (look.running)
          this.setLookState(bot.id, { ...look, running: false, runAgentId: undefined });
        const tidy = this.tidyState(bot.id);
        if (tidy.running)
          this.storage.setState(`tidy:${bot.id}`, {
            ...tidy,
            running: false,
            runAgentId: undefined,
          });
        const active = this.storage.state(`active:${bot.id}`, BotMessageSchema.nullable());
        // An undelivered wake already owns its retry. Otherwise the active receipt
        // survives a crash even when a chat turn has not created an item yet.
        const retryPending = active && this.storage.pending(bot.id).some((m) => m.id === active.id);
        if (!retryPending && (active || this.storage.items(bot.id).length > 0))
          this.wake(
            bot.id,
            "The daemon resumed. Reconcile your open items with their existing workers and pending questions. Never create a replacement worker for an existing item; inspect or message its worker first.",
            "resume",
            active ? `resume:${active.id}` : undefined,
          );
      }
    }
    this.timer = setInterval(() => this.launch(this.tick()), 1000);
    this.timer.unref();
    this.launch(this.tick());
  }
  stop(): void {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  suspendForShutdown(): void {
    this.shuttingDown = true;
    this.stop();
    this.unsubscribe();
    this.runtime.dispose();
  }
  async dispose(): Promise<void> {
    this.suspendForShutdown();
    await this.settled();
    this.storage.close();
  }

  private handleSlack(
    msg: Extract<BotsRequest, { type: `bots.slack.${string}` }>,
  ): Promise<Record<string, unknown>> {
    if (!this.slack) throw new Error("Slack is unavailable");
    return this.slack.handle(msg);
  }

  private itemsList(botId: string, includeClosed?: boolean) {
    const bot = this.storage.bot(botId);
    const items = this.storage.items(botId, includeClosed);
    const counts: Partial<Record<BotItemStatus, number>> = {};
    for (const item of this.storage.items(botId, true))
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    void bot;
    return { items, counts };
  }

  /** One handler per request type; the session parses each result with its response schema. */
  private readonly handlers: {
    [T in BotsRequest["type"]]?: (
      msg: Extract<BotsRequest, { type: T }>,
    ) => Promise<Record<string, unknown>>;
  } = {
    "bots.list.request": async () => {
      return { bots: this.storage.listBots() };
    },
    "bots.create.request": async (msg) => {
      return { bot: await this.create(msg.bot) };
    },
    "bots.update.request": async (msg) => {
      return { bot: await this.update(msg.botId, msg.patch) };
    },
    "bots.delete.request": async (msg) => {
      await this.delete(msg.botId);
      return {};
    },
    "bots.pause.request": async (msg) => {
      return { bot: this.pause(msg.botId, msg.paused) };
    },
    "bots.chat.send.request": async (msg) => {
      const message = this.wake(msg.botId, msg.text, "chat", msg.messageId);
      return {
        message: message ?? this.storage.message(`${msg.botId}:${msg.messageId}`),
      };
    },
    "bots.chat.history.request": async (msg) => {
      this.storage.bot(msg.botId);
      return { messages: this.storage.history(msg.botId, msg.limit, msg.before_ms) };
    },
    "bots.chat.reset.request": async (msg) => {
      return { bot: await this.resetHomeChat(msg.botId) };
    },
    "bots.items.list.request": async (msg) => {
      return this.itemsList(msg.botId, msg.includeClosed);
    },
    "bots.items.show.request": async (msg) => {
      const item = this.storage.findItem(msg.botId, msg.itemId);
      return { item, events: this.storage.itemEvents(item.id) };
    },
    "bots.items.answer.request": async (msg) => {
      return { item: await this.answer(msg.botId, msg.itemId, msg.answers) };
    },
    "bots.items.cancel.request": async (msg) => {
      return { item: await this.cancel(msg.botId, msg.itemId, msg.reason) };
    },
    "bots.items.cancel_many.request": async (msg) => {
      return { canceled: await this.cancelMany(msg.botId, msg.itemUids, msg.reason) };
    },
    "bots.items.snooze.request": async (msg) => {
      return { item: this.snooze(msg.botId, msg.itemUid, msg.until_ms) };
    },
    "bots.items.set_status.request": async (msg) => {
      return { item: this.setStatus(msg.botId, msg.itemId, msg.status, "owner") };
    },
    "bots.items.done.request": async (msg) => {
      return { item: await this.ownerDone(msg.botId, msg.itemId, msg.force) };
    },
    "bots.items.comment.request": async (msg) => {
      return { item: this.ownerComment(msg.botId, msg.itemId, msg.text) };
    },
    "bots.items.mark_seen.request": async (msg) => {
      return { bot: this.markSeen(msg.botId) };
    },
    "bots.needs_you.list.request": async (msg) => {
      return { rows: this.needsYou(msg.botId) };
    },
    "bots.chats.tree.request": async (msg) => {
      return this.chatsTree(msg.botId, msg.query);
    },
    "bots.suggestions.list.request": async (msg) => {
      return this.suggestions(this.storage.bot(msg.botId));
    },
    "bots.suggestions.start.request": async (msg) => {
      const message = this.startSuggestion(msg.botId, msg.suggestionId);
      return { ...this.suggestions(this.storage.bot(msg.botId)), message };
    },
    "bots.suggestions.dismiss.request": async (msg) => {
      this.dismissSuggestion(msg.botId, msg.suggestionId);
      return this.suggestions(this.storage.bot(msg.botId));
    },
    "bots.look_around.run_now.request": async (msg) => {
      return this.lookAround(msg.botId, true);
    },
    "bots.tidy_up.status.request": async (msg) => {
      return { tidyUp: this.tidyView(this.storage.bot(msg.botId)) };
    },
    "bots.tidy_up.run_now.request": async (msg) => {
      return this.tidyUp(msg.botId, true);
    },
    "bots.tidy_up.undo.request": async (msg) => {
      return { undone: await this.undoTidy(msg.botId, msg.runId) };
    },
    "bots.memory.read.request": async (msg) => {
      return { memory: await this.memory.view(this.storage.bot(msg.botId)) };
    },
    "bots.memory.history.request": async (msg) => {
      return { history: this.memory.history(this.storage.bot(msg.botId)) };
    },
    "bots.memory.add.request": async (msg) => {
      const bot = this.storage.bot(msg.botId);
      await this.memory.add(bot, msg.text);
      return { memory: await this.memory.view(bot) };
    },
    "bots.memory.edit.request": async (msg) => {
      const bot = this.storage.bot(msg.botId);
      await this.memory.edit(bot, msg.line, msg.expected, msg.text);
      return { memory: await this.memory.view(bot) };
    },
    "bots.memory.forget.request": async (msg) => {
      const bot = this.storage.bot(msg.botId);
      await this.memory.forget(bot, msg.line, msg.expected);
      return { memory: await this.memory.view(bot) };
    },
    "bots.memory.undo.request": async (msg) => {
      const bot = this.storage.bot(msg.botId);
      await this.memory.undo(bot, msg.rowId);
      return { memory: await this.memory.view(bot), history: this.memory.history(bot) };
    },
    "bots.home_file.read.request": async (msg) => {
      return this.memory.readFile(this.storage.bot(msg.botId), msg.file);
    },
    "bots.home_file.write.request": async (msg) => {
      const bot = this.storage.bot(msg.botId);
      const result = await this.memory.writeFile(bot, msg.file, msg.content, msg.baseHash);
      this.emit({
        type: "bots.home_file_changed",
        payload: { botId: bot.id, file: msg.file, hash: result.hash },
      });
      return result;
    },
    "bots.templates.list.request": async () => {
      return { templates: this.templates() };
    },
    "bots.create_from_template.request": async (msg) => {
      return {
        bot: await this.createFromTemplate({
          templateId: msg.templateId,
          name: msg.name,
          ...(msg.identity ? { identity: msg.identity } : {}),
          ...(msg.avatar ? { avatar: msg.avatar } : {}),
          ...(msg.avatarColor ? { avatarColor: msg.avatarColor } : {}),
          ...(msg.avatarOutfit !== undefined ? { avatarOutfit: msg.avatarOutfit } : {}),
          provider: msg.provider,
          model: msg.model,
          ...(msg.thinkingOptionId ? { thinkingOptionId: msg.thinkingOptionId } : {}),
        }),
      };
    },
    "bots.hand_over.request": async (msg) => {
      return this.handOver(msg);
    },
    "bots.automations.list.request": async (msg) => {
      return this.automations(msg.botId);
    },
    "bots.automations.run_now.request": async (msg) => {
      return { started: await this.runAutomationNow(msg.botId, msg.automationId) };
    },
    "bots.automations.cancel_wait.request": async (msg) => {
      return { item: this.cancelWait(msg.botId, msg.itemId) };
    },
    "bots.first_screen.scan.request": async (msg) => {
      this.storage.bot(msg.botId);
      return { scan: await this.runtime.firstScreen() };
    },
    "bots.allowed.list.request": async (msg) => {
      return { people: await this.allowed(msg.botId) };
    },
    "bots.avatar.upload.request": async (msg) => {
      return { bot: await this.uploadAvatar(msg.botId, msg.png) };
    },
    "bots.avatar.read.request": async (msg) => {
      return { png: await this.readAvatar(msg.botId) };
    },
    "bots.rooms.list.request": async () => {
      return { rooms: this.storage.rooms() };
    },
    "bots.rooms.save.request": async (msg) => {
      return { room: this.saveRoom(msg.room) };
    },
    "bots.rooms.delete.request": async (msg) => {
      this.storage.room(msg.roomId);
      this.storage.deleteRoom(msg.roomId);
      this.emit({ type: "bots.room.changed", payload: { roomId: msg.roomId, deleted: true } });
      return {};
    },
    "bots.rooms.send.request": async (msg) => {
      return { message: this.sendRoom(msg.roomId, msg.text, msg.messageId) };
    },
    "bots.schedules.list.request": async (msg) => {
      return { schedules: this.storage.bot(msg.botId).schedules };
    },
    "bots.schedules.save.request": async (msg) => {
      return { schedule: this.saveSchedule(msg.botId, msg.schedule, msg.scheduleId) };
    },
    "bots.schedules.delete.request": async (msg) => {
      this.deleteSchedule(msg.botId, msg.scheduleId);
      return {};
    },
  };

  // Successful results are parsed by the matching protocol schema at the session boundary.
  async handle(msg: BotsRequest): Promise<Record<string, unknown>> {
    if (msg.type.startsWith("bots.slack.")) {
      return this.handleSlack(msg as Extract<BotsRequest, { type: `bots.slack.${string}` }>);
    }
    const handler = this.handlers[msg.type] as
      | ((msg: BotsRequest) => Promise<Record<string, unknown>>)
      | undefined;
    if (!handler) throw new Error("Unknown bots method");
    return handler(msg);
  }
}
