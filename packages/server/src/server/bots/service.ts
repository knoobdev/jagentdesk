import type { BotsSlack } from "./slack.js";
import { isBotsHookRequest, type BotsHookConnectors } from "./hooks/connectors.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import {
  BotPatchSchema,
  BotMessageSchema,
  BotScheduleInputSchema,
  type Bot,
  type BotInput,
  type BotPatch,
  type BotItem,
  type BotItemPatch,
  type BotMessage,
  type BotScheduleInput,
} from "@jagentdesk/protocol/bots/types";
import type { BotsPush, BotsRequest } from "@jagentdesk/protocol/bots/rpc-schemas";
import { computeNextRunAt, validateScheduleCadence } from "../schedule/cron.js";
import type { PushNotificationSender } from "../push/notifications.js";
import { BotStorage, botIdentity } from "./storage.js";
import type { BotRuntime, BotRuntimeEvent } from "./runtime.js";
import { commentItem, patchItem } from "./items.js";
import { mentionedSlugs } from "./context.js";
import { reviewSummary, reviewWorker } from "./review.js";

/** Who sent a message from outside JAgentDesk (Slack, GitHub, GitLab, Telegram). */
function externalSenderId(message: BotMessage): string | undefined {
  if (message.slack) return `slack:${message.slack.userId}`;
  if (message.connector) return `${message.connector.kind}:${message.connector.userId}`;
  return undefined;
}
export interface BotTrigger {
  key: string;
  text: string;
  source: "jira" | "github";
}
export interface BotTriggerSource {
  poll(bot: Bot): Promise<BotTrigger[]>;
}
export class BotsService {
  slack?: BotsSlack;
  /** GitHub, GitLab and Telegram (spec 37.10–37.12). */
  hooks?: BotsHookConnectors;
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
  private saveItem(item: BotItem): BotItem {
    const previous = this.storage.items(item.botId, true).find((i) => i.id === item.id);
    const saved = this.storage.saveItem(item);
    this.emit({ type: "bots.item.changed", payload: { item: saved } });
    if (saved.status === "needs_you" && previous?.status !== "needs_you") {
      this.launch(
        this.options.push?.send({
          title: `${this.storage.bot(item.botId).name} needs you`,
          body: saved.questions?.[0]?.text ?? saved.title,
          data: { type: "bot_needs_you", botId: saved.botId, itemId: saved.id },
        }) ?? Promise.resolve(),
      );
    }
    return saved;
  }
  async create(input: BotInput): Promise<Bot> {
    const bot = this.storage.createBot(input);
    try {
      await this.runtime.configure(bot);
    } catch (err) {
      this.storage.deleteBot(bot.id);
      throw err;
    }
    this.changed(bot.id);
    return bot;
  }
  async update(id: string, raw: BotPatch): Promise<Bot> {
    const parsed = BotPatchSchema.parse(raw);
    const patch =
      parsed.identity === undefined
        ? parsed
        : { ...parsed, identity: botIdentity(parsed.identity) };
    const bot = this.storage.bot(id);
    if (
      Object.keys(patch).some((k) => ["unattended", "provider", "model", "modeId"].includes(k)) &&
      this.storage.items(id).some((i) => i.workerAgentIds.length > 0)
    )
      throw new Error(
        "Finish or cancel active worker items before changing bot execution settings",
      );
    const next = { ...bot, ...patch };
    await this.runtime.configure(next);
    this.storage.saveBot({ ...this.storage.bot(id), ...patch });
    this.changed(id);
    return this.storage.bot(id);
  }
  async delete(id: string): Promise<void> {
    const bot = this.storage.bot(id);
    const rooms = this.storage.rooms().filter((room) => room.memberBotIds.includes(id));
    await this.slack?.disconnect(id);
    await this.hooks?.disconnect(id);
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
    if (!paused) this.launch(this.drain(id));
    return bot;
  }
  wake(
    botId: string,
    text: string,
    source: string,
    key: string = randomUUID(),
    place: Pick<BotMessage, "roomId" | "rootId" | "slack" | "connector"> = {},
  ): BotMessage | null {
    this.storage.bot(botId);
    const message = this.storage.enqueue(botId, `${botId}:${key}`, text, source, place);
    if (message) {
      this.emit({ type: "bots.chat.message", payload: { message } });
      if (this.enabled) this.launch(this.drain(botId));
    }
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
      if (bot.agentId !== agentId) this.changed(botId);
      if (!this.enabled || this.storage.bot(botId).paused) return;
      const activate = () => this.storage.setState(`active:${botId}`, message);
      const senderId = externalSenderId(message);
      if (!senderId) activate();
      await this.runtime.send(
        agentId,
        `[${message.source}]\n${message.text}`,
        message.id,
        undefined,
        senderId ? { senderId, title: message.source, beforeDispatch: activate } : undefined,
      );

      this.storage.delivered(message.id);
    } finally {
      this.dispatching.delete(botId);
    }
  }
  addItem(botId: string, title: string, doneMeans: string): BotItem {
    this.storage.bot(botId);
    const now = this.now();
    const id = randomUUID();
    const active = this.storage.state(`active:${botId}`, BotMessageSchema.nullable());
    if (active?.slack) this.storage.setState(`slack:item:${id}`, active.slack);
    if (active?.connector) this.storage.setState(`connector:item:${id}`, active.connector);
    return this.saveItem({
      id,
      botId,
      title,
      doneMeans,
      status: "planned",
      workerAgentIds: [],
      comments: [],
      reviews: [],
      reviewRounds: 0,
      createdAt_ms: now,
      updatedAt_ms: now,
    });
  }
  setItem(botId: string, itemId: string, patch: BotItemPatch): BotItem {
    return this.saveItem(patchItem(this.storage.item(botId, itemId), patch));
  }
  comment(botId: string, itemId: string, text: string, author = "bot"): BotItem {
    return this.saveItem(commentItem(this.storage.item(botId, itemId), text, author));
  }
  async startWorker(
    botId: string,
    itemId: string,
    repo: string | undefined,
    assignment: string,
  ): Promise<{ agentId: string; item: BotItem }> {
    const bot = this.storage.bot(botId);
    const item = this.storage.item(botId, itemId);
    if (
      this.workerStarts.has(itemId) ||
      item.workerAgentIds.length ||
      ["done", "canceled"].includes(item.status)
    )
      throw new Error("Item already has a worker or is closed");
    const target = repo ?? bot.defaultRepo;
    if (!target) throw new Error("Choose a target repository");
    this.workerStarts.add(itemId);
    this.saveItem(patchItem(item, { status: "working" }));
    try {
      const agentId = await this.runtime.startWorker(
        bot,
        item,
        target,
        `${assignment}\nDone means: ${item.doneMeans}\nUse this worktree only. Stage new files before finishing. Report a concise summary, tests and remaining uncertainty. You are the ORC Lead; use ORC Peers for bounded assignments if needed. Do not merge/push without the owner's request.`,
        (id, worktree, baseCommit) => {
          const current = this.storage.item(botId, itemId);
          this.saveItem({ ...current, workerAgentIds: [id], worktree, baseCommit });
        },
      );
      return { agentId, item: this.storage.item(botId, itemId) };
    } catch (err) {
      const current = this.storage.item(botId, itemId);
      this.saveItem(
        patchItem(commentItem(current, `Worker could not start: ${String(err)}`, "daemon"), {
          status: "needs_you",
        }),
      );
      throw err;
    } finally {
      this.workerStarts.delete(itemId);
    }
  }
  async answer(
    botId: string,
    itemId: string,
    answers: { questionIndex: number; text: string }[],
  ): Promise<BotItem> {
    const item = this.storage.item(botId, itemId);
    if (item.status !== "needs_you" || !item.questions?.length)
      throw new Error("Item has no unanswered questions");
    const questions = item.questions.map((q) => ({ ...q }));
    const seen = new Set<number>();
    for (const answer of answers) {
      const q = questions[answer.questionIndex];
      if (!q || q.answer !== undefined || seen.has(answer.questionIndex))
        throw new Error("Question already answered or missing");
      q.answer = answer.text;
      seen.add(answer.questionIndex);
    }
    const allAnswered = questions.every((q) => q.answer !== undefined);
    const text = answers
      .map((a) => `${questions[a.questionIndex].text}\nOwner: ${a.text}`)
      .join("\n\n");
    const updated = this.saveItem({
      ...commentItem(item, text, "owner"),
      questions,
      status: allAnswered ? "working" : "needs_you",
    });
    if (allAnswered)
      this.wake(
        botId,
        `Owner answered item ${itemId}:\n${text}\nResume this item's existing worker if appropriate.`,
        "answer",
        `answer:${updated.comments.at(-1)!.id}`,
      );
    return updated;
  }
  async cancel(botId: string, itemId: string, reason: string): Promise<BotItem> {
    const item = this.storage.item(botId, itemId);
    const updated = this.saveItem(
      patchItem(commentItem(item, reason, "owner"), { status: "canceled" }),
    );
    for (const id of item.workerAgentIds) await this.runtime.cancel(id);
    return updated;
  }
  saveSchedule(botId: string, raw: BotScheduleInput, scheduleId?: string) {
    const input = BotScheduleInputSchema.parse(raw);
    const bot = this.storage.bot(botId);
    if (scheduleId && !bot.schedules.some((s) => s.id === scheduleId))
      throw new Error("Schedule not found");
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
    return schedule;
  }
  deleteSchedule(botId: string, scheduleId: string): void {
    const bot = this.storage.bot(botId);
    if (!bot.schedules.some((s) => s.id === scheduleId)) throw new Error("Schedule not found");
    this.storage.saveBot({ ...bot, schedules: bot.schedules.filter((s) => s.id !== scheduleId) });
    this.changed(botId);
  }
  async handoff(fromId: string, toId: string, text: string): Promise<void> {
    if (fromId === toId) throw new Error("Cannot hand off to yourself");
    const from = this.storage.bot(fromId);
    const to = this.storage.bot(toId);
    if (to.paused) throw new Error("Target bot is paused");
    this.wake(toId, `${from.name} (@${from.slug}) handed off:\n${text}`, "handoff");
  }
  saveRoom(input: { id?: string; name: string; memberBotIds: string[] }) {
    for (const id of input.memberBotIds) this.storage.bot(id);
    const room = this.storage.saveRoom({
      ...input,
      id: input.id ?? randomUUID(),
      memberBotIds: [...new Set(input.memberBotIds)],
      messages: input.id ? this.storage.room(input.id).messages : [],
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
    for (const bot of this.storage.listBots()) {
      if (
        !room.memberBotIds.includes(bot.id) ||
        bot.id === speaker?.id ||
        bot.paused ||
        !mentions.has(bot.slug)
      )
        continue;
      // At most one turn per member per root post bounds loops and makes replay idempotent.
      const history = this.storage
        .room(roomId)
        .messages.slice(-30)
        .map((m) => `${m.botId}: ${m.text}`)
        .join("\n");
      this.wake(
        bot.id,
        `Room ${room.name} (${roomId}), root ${message.rootId}. You were @mentioned. Reply to the room; name another member only to hand off.\n${history}`,
        "room",
        `room:${roomId}:${message.rootId}:${bot.id}`,
        { roomId, rootId: message.rootId },
      );
    }
    return message;
  }
  private async handleRuntimeEvent(event: BotRuntimeEvent): Promise<void> {
    if (this.shuttingDown) return;
    const bot = this.storage.listBots().find((b) => b.agentId === event.agentId);
    if (bot && event.kind !== "ask") {
      const active = this.storage.state(`active:${bot.id}`, BotMessageSchema.nullable());
      const message: BotMessage = {
        id: `reply:${bot.id}:${event.key}`,
        botId: bot.id,
        role: "assistant",
        text: event.text,
        source: event.kind,
        ...(active
          ? { rootId: active.rootId, slack: active.slack, connector: active.connector }
          : {}),
        createdAt_ms: this.now(),
      };
      if (this.storage.append(message)) {
        this.emit({ type: "bots.chat.message", payload: { message } });
        if (active) for (const listener of this.replyListeners) listener(active, message);
        if (
          active?.roomId &&
          this.storage
            .rooms()
            .some((room) => room.id === active.roomId && room.memberBotIds.includes(bot.id))
        )
          this.sendRoom(active.roomId, event.text, message.id, bot, active.rootId);
      }
      this.storage.setState(`active:${bot.id}`, null);
      // AgentManager publishes turn_completed just before settling its run. Drain on the next tick.
      return;
    }
    for (const owner of this.storage.listBots()) {
      const item = this.storage
        .items(owner.id)
        .find((i) => i.workerAgentIds.includes(event.agentId));
      if (!item) continue;
      const dedupe = `worker-event:${event.agentId}:${event.kind}:${event.key}`;
      if (this.storage.state(dedupe, z.boolean())) return;
      this.storage.setState(dedupe, true);
      if (event.kind === "escalation") {
        this.saveItem(
          patchItem(commentItem(item, event.text, "worker"), {
            status: "needs_you",
            questions: [
              {
                text: "How should we resolve this worker escalation?",
                options: [
                  "Continue with your recommendation",
                  "I will investigate",
                  "Cancel this item",
                ],
              },
            ],
          }),
        );
        this.wake(
          owner.id,
          `Worker ${event.agentId} escalated item ${item.id} to the owner:\n${event.text}`,
          "worker_escalation",
          dedupe,
        );
      } else if (event.kind === "ask") {
        this.comment(owner.id, item.id, `Worker asks for permission: ${event.text}`, "daemon");
        this.wake(
          owner.id,
          `Worker ${event.agentId} on item ${item.id} needs permission. The owner must answer its permission card; never approve it yourself.`,
          "worker_ask",
          dedupe,
        );
      } else if (event.kind === "error") {
        this.saveItem(patchItem(commentItem(item, event.text, "worker"), { status: "needs_you" }));
        this.wake(
          owner.id,
          `Worker ${event.agentId} failed on item ${item.id}: ${event.text}`,
          "worker_error",
          dedupe,
        );
      } else if (this.enabled && !owner.paused) {
        await this.reviewItem(owner.id, item.id, event.text);
      } else {
        this.storage.setState(`review-pending:${item.id}`, event.text);
      }
      return;
    }
  }
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
      const result = await reviewWorker(
        this.runtime,
        bot,
        item,
        () =>
          !this.shuttingDown &&
          (!this.hasStarted || this.enabled) &&
          !this.storage.bot(botId).paused,
      );
      const current = this.storage.item(botId, itemId);
      if (this.hasStarted && !this.enabled) {
        retainPending = true;
        return;
      }
      if (this.storage.bot(botId).paused) {
        retainPending = true;
        return;
      }
      if (current.status === "canceled") return;
      const updated = commentItem(
        {
          ...current,
          reviews: [...current.reviews, ...result.reviews],
          summary,
          diff: result.diff,
        },
        reviewSummary(result.reviews),
        "review",
      );
      if (!result.blocked) {
        this.saveItem(
          patchItem({ ...updated, reviewedDiffHash: result.hash }, { status: "done" }, true),
        );
        this.wake(
          botId,
          `Item ${itemId} passed BA/Tester/Pentester review and is done. Summary: ${summary}\nDiff worktree: ${item.worktree}`,
          "worker_done",
          `done:${itemId}`,
        );
      } else if (current.reviewRounds < 2) {
        const saved = this.saveItem({
          ...updated,
          status: "working",
          reviewRounds: current.reviewRounds + 1,
        });
        this.storage.setState(`review-pending:${itemId}`, null);
        await this.runtime.send(
          saved.workerAgentIds[0],
          `Cross-review found blocking findings. Fix round ${saved.reviewRounds}/2. Fix in this worktree and report when ready:\n${reviewSummary(result.reviews)}`,
          undefined,
          bot.agentId ?? undefined,
        );
      } else {
        this.saveItem(
          patchItem(updated, {
            status: "needs_you",
            questions: [
              {
                text: "Blocking review findings remain after two fix rounds. How should we proceed?",
                options: ["I will fix the findings", "Cancel this item"],
                recommended: 0,
              },
            ],
          }),
        );
        this.wake(
          botId,
          `Item ${itemId} needs the owner: blocking findings remain after two fix rounds.\n${reviewSummary(result.reviews)}`,
          "worker_escalation",
          `review-exhausted:${itemId}`,
        );
      }
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
      if (!["done", "canceled"].includes(item.status))
        this.saveItem(
          patchItem(commentItem(item, `Review could not complete: ${String(err)}`, "daemon"), {
            status: "needs_you",
          }),
        );
    } finally {
      this.reviewing.delete(itemId);
      if (!retainPending) this.storage.setState(`review-pending:${itemId}`, null);
    }
  }
  private processSchedules(entry: Bot, now: number): void {
    for (const schedule of entry.schedules) {
      if (!schedule.enabled || schedule.nextRunAt_ms > now) continue;
      this.storage.transaction(() => {
        this.wake(
          entry.id,
          schedule.prompt,
          "schedule",
          `schedule:${schedule.id}:${schedule.nextRunAt_ms}`,
        );
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
    }
  }
  private processWaitsAndLooks(entry: Bot, now: number): void {
    const looked = this.storage.state(`look:${entry.id}`, z.number()) ?? entry.createdAt_ms;
    if (entry.lookAround.enabled && now - looked >= entry.lookAround.intervalMinutes * 60000) {
      this.storage.transaction(() => {
        this.wake(
          entry.id,
          "Look around your open items and recent context. Suggest useful next steps to your owner; do not start work without authorization.",
          "look_around",
          `look:${Math.floor(now / (entry.lookAround.intervalMinutes * 60000))}`,
        );
        this.storage.setState(`look:${entry.id}`, now);
      });
    }
    for (const item of this.storage.items(entry.id)) {
      if (item.status === "waiting" && item.waitFor && item.waitFor.until_ms <= now) {
        const wait = item.waitFor;
        this.storage.transaction(() => {
          this.saveItem(patchItem(item, { status: "working" }));
          this.wake(
            entry.id,
            `Wait ended on item ${item.id}: ${wait.condition}. Recheck the condition before acting.`,
            "wait",
            `wait:${item.id}:${wait.until_ms}`,
          );
        });
      }
      const pending = this.storage.state(`review-pending:${item.id}`, z.string().nullable());
      if (pending) this.launch(this.reviewItem(entry.id, item.id, pending));
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
  async tick(): Promise<void> {
    if (!this.enabled || this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const entry of this.storage.listBots()) {
        if (!this.enabled) break;
        if (entry.paused) continue;
        this.processSchedules(entry, now);
        this.processWaitsAndLooks(entry, now);
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
    if (firstStart) {
      for (const bot of this.storage.listBots()) {
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
  /** Slack, GitHub, GitLab and Telegram requests, or undefined for the rest. */
  private routeConnector(msg: BotsRequest): Promise<Record<string, unknown>> | undefined {
    if (msg.type.startsWith("bots.slack."))
      return this.handleSlack(msg as Extract<BotsRequest, { type: `bots.slack.${string}` }>);
    if (!isBotsHookRequest(msg)) return undefined;
    if (!this.hooks) throw new Error("Bot connectors are unavailable");
    return this.hooks.handle(msg);
  }
  // Successful results are parsed by the matching protocol schema at the session boundary.
  async handle(msg: BotsRequest): Promise<Record<string, unknown>> {
    const connector = this.routeConnector(msg);
    if (connector) return connector;
    switch (msg.type) {
      case "bots.list.request":
        return { bots: this.storage.listBots() };
      case "bots.create.request":
        return { bot: await this.create(msg.bot) };
      case "bots.update.request":
        return { bot: await this.update(msg.botId, msg.patch) };
      case "bots.delete.request":
        await this.delete(msg.botId);
        return {};
      case "bots.pause.request":
        return { bot: this.pause(msg.botId, msg.paused) };
      case "bots.chat.send.request": {
        const message = this.wake(msg.botId, msg.text, "chat", msg.messageId);
        return {
          message: message ?? this.storage.message(`${msg.botId}:${msg.messageId}`),
        };
      }
      case "bots.chat.history.request":
        this.storage.bot(msg.botId);
        return { messages: this.storage.history(msg.botId, msg.limit, msg.before_ms) };
      case "bots.items.list.request":
        this.storage.bot(msg.botId);
        return { items: this.storage.items(msg.botId, msg.includeClosed) };
      case "bots.items.answer.request":
        return { item: await this.answer(msg.botId, msg.itemId, msg.answers) };
      case "bots.items.cancel.request":
        return { item: await this.cancel(msg.botId, msg.itemId, msg.reason) };
      case "bots.rooms.list.request":
        return { rooms: this.storage.rooms() };
      case "bots.rooms.save.request":
        return { room: this.saveRoom(msg.room) };
      case "bots.rooms.delete.request":
        this.storage.room(msg.roomId);
        this.storage.deleteRoom(msg.roomId);
        this.emit({ type: "bots.room.changed", payload: { roomId: msg.roomId, deleted: true } });
        return {};
      case "bots.rooms.send.request":
        return { message: this.sendRoom(msg.roomId, msg.text, msg.messageId) };
      case "bots.schedules.list.request":
        return { schedules: this.storage.bot(msg.botId).schedules };
      case "bots.schedules.save.request":
        return { schedule: this.saveSchedule(msg.botId, msg.schedule, msg.scheduleId) };
      case "bots.schedules.delete.request":
        this.deleteSchedule(msg.botId, msg.scheduleId);
        return {};
      default:
        throw new Error("Unknown bots method");
    }
  }
}
