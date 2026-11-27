import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import { BotConnectorThreadSchema, type BotConnectorThread } from "@jagentdesk/protocol/bots/types";
import {
  HOOK_FORWARDED_HEADERS,
  MAX_HOOK_BODY_BYTES,
  type HookDelivery,
  type HookResponse,
} from "@jagentdesk/relay/hooks";
import { FileSecretStore, type SecretStore } from "../../database/secret-store.js";
import type { RelayControlHandler } from "../../relay-transport.js";
import type { BotsService } from "../service.js";
import type { BotConnectorEvent, BotConnectorEvents } from "./events.js";

export type ConnectorKind = "github" | "gitlab" | "telegram";
export interface HookConnectorOptions {
  logger: Logger;
  relay: () => { endpoint: string; useTls: boolean; enabled: boolean; serverId: string };
  secrets?: SecretStore;
  events?: BotConnectorEvents;
  now?: () => number;
}
/** One event a delivery reserves; `data` is what `process` reads back after the 200. */
export interface AcceptedEvent {
  eventId: string;
  data: unknown;
}
export interface Accepted {
  status: number;
  body?: string;
  events?: AcceptedEvent[];
}

export const DAY_MS = 86_400_000;
const CONNECTOR_LABELS: Record<ConnectorKind, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  telegram: "Telegram",
};
export const NEEDS_YOU_TEXT = "Waiting for my owner in JAgentDesk.";
export const NOT_ALLOWED_TEXT = "I only take requests from people my owner allowed.";
const DeliverySchema = z.object({
  type: z.literal("hook_delivery"),
  v: z.literal(1),
  deliveryId: z.string(),
  hookId: z.string(),
  kind: z.string(),
  headers: z.record(z.string(), z.string()),
  bodyB64: z.string().max(1_398_104),
  receivedAt_ms: z.number(),
});

export function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The part every webhook connector shares with Slack (slack.ts): the hookId registered on the relay
 * Worker, verification before the 200, a durable 24 h receipt per source event id so retries never run
 * twice, and a reply outbox retried until the source's API takes it.
 */
export abstract class HookConnector implements RelayControlHandler {
  abstract readonly kind: ConnectorKind;
  protected send: ((frame: unknown) => void) | undefined;
  protected enabled = false;
  protected readonly secrets: SecretStore;
  private readonly acks = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly operations = new Map<string, Promise<unknown>>();
  private readonly processing = new Set<string>();
  private flushingReplies = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribers: (() => void)[] = [];
  private tablesReady = false;
  constructor(
    protected readonly bots: BotsService,
    protected readonly options: HookConnectorOptions,
  ) {
    this.secrets = options.secrets ?? new FileSecretStore(join(bots.storage.home, "bots"));
    bots.storage.db.exec(
      `CREATE TABLE IF NOT EXISTS hook_events (kind TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, event_id TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT, PRIMARY KEY(kind,bot_id,event_id));`,
    );
    bots.storage.db.exec(
      `CREATE TABLE IF NOT EXISTS hook_replies (id TEXT PRIMARY KEY, kind TEXT NOT NULL, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, expires INTEGER NOT NULL, retry_at INTEGER NOT NULL, data TEXT);`,
    );
    this.tablesReady = true;
    this.unsubscribers.push(
      bots.onReply((request, reply) => {
        if (request.connector?.kind === this.kind && reply.source === "done")
          this.launch(this.queueReply(request.botId, request.connector, reply.text, reply.id));
      }),
      bots.onEvent((event) => {
        if (event.type !== "bots.item.changed" || event.payload.item.status !== "needs_you") return;
        const item = event.payload.item;
        const origin = bots.storage.state(`connector:item:${item.id}`, BotConnectorThreadSchema);
        if (origin?.kind !== this.kind) return;
        if (bots.storage.state(`connector:needs-you:${item.id}`, z.boolean())) return;
        bots.storage.setState(`connector:needs-you:${item.id}`, true);
        this.launch(this.queueReply(item.botId, origin, NEEDS_YOU_TEXT, `needs-you:${item.id}`));
      }),
    );
  }

  /** The bot's hookId for this connector, when it has one. */
  protected abstract hookIdOf(botId: string): string | undefined;
  /** Check the source's signature or secret on the raw body; return a status to refuse with. */
  protected abstract verify(
    botId: string,
    delivery: HookDelivery,
    body: Buffer,
  ): Promise<number | null>;
  /** Parse a verified delivery: what to answer and which events to keep. Runs before the 200. */
  protected abstract accept(botId: string, delivery: HookDelivery, body: Buffer): Accepted;
  /** Act on a kept event after the 200. */
  protected abstract process(botId: string, eventId: string, data: unknown): Promise<void>;
  /** Post one reply in the source's thread. Throwing retries it in 30 s. */
  protected abstract deliver(
    botId: string,
    origin: BotConnectorThread,
    text: string,
    id: string,
  ): Promise<void>;
  /** Runs after the relay control socket (re)connects and hooks are registered. */
  protected async afterSync(): Promise<void> {}

  protected now(): number {
    return this.options.now?.() ?? Date.now();
  }
  protected launch(job: Promise<unknown>): void {
    this.jobs.add(job);
    void job
      .catch((err: unknown) =>
        this.options.logger.warn(
          { kind: this.kind, error: err instanceof Error ? err.message : "unknown" },
          "Bot connector operation failed",
        ),
      )
      .finally(() => this.jobs.delete(job));
  }
  async settled(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled(this.jobs);
  }
  protected serial<T>(botId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(botId) ?? Promise.resolve()).catch(() => {}).then(run);
    this.operations.set(botId, next);
    void next
      .finally(() => {
        if (this.operations.get(botId) === next) this.operations.delete(botId);
      })
      .catch(() => {});
    return next;
  }
  protected emit(event: BotConnectorEvent): void {
    this.options.events?.emit(event);
  }
  protected relayConnected(): boolean {
    return Boolean(this.send && this.enabled);
  }
  protected requireRelay(): void {
    if (!this.options.relay().enabled)
      throw new Error(`Enable Relay in host Connections to use ${this.label()}`);
  }
  protected label(): string {
    return CONNECTOR_LABELS[this.kind];
  }
  hookUrl(hookId: string): string {
    const relay = this.options.relay();
    const url = new URL(
      `${relay.useTls ? "https" : "http"}://${relay.endpoint.replace(/^(?:https?|wss?):\/\//, "")}`,
    );
    url.pathname = `/hooks/${this.kind}/${relay.serverId}/${hookId}`;
    url.search = "";
    return url.toString();
  }
  protected newHookId(): string {
    return randomBytes(32).toString("base64url");
  }

  // Relay registration, as slack.ts registration()/sync().
  protected registration(hookId: string, register: boolean): Promise<void> {
    const send = this.send;
    if (!send) return Promise.resolve();
    const type = register ? "hook_registered" : "hook_unregistered";
    const key = `${type}:${hookId}`;
    return new Promise<void>((resolve, reject) => {
      const previous = this.acks.get(key);
      const timer = setTimeout(() => {
        this.acks.delete(key);
        reject(new Error("Relay hook registration timed out"));
      }, 2500);
      this.acks.set(key, {
        resolve: () => {
          previous?.resolve();
          resolve();
        },
        reject: (err) => {
          previous?.reject(err);
          reject(err);
        },
        timer,
      });
      if (previous) clearTimeout(previous.timer);
      try {
        send({
          type: register ? "hook_register" : "hook_unregister",
          v: 1,
          hookId,
          ...(register ? { kind: this.kind } : {}),
        });
      } catch {
        clearTimeout(timer);
        this.acks.delete(key);
        reject(new Error("Relay disconnected"));
      }
    });
  }
  protected async registerHook(hookId: string): Promise<void> {
    if (this.enabled) await this.registration(hookId, true);
  }
  /** Forget a hookId: the Worker answers 404 for it once the relay acknowledges. */
  protected async retireHook(hookId: string): Promise<void> {
    const key = `${this.kind}:retiredHooks`;
    const retired = this.bots.storage.state(key, z.array(z.string())) ?? [];
    this.bots.storage.setState(key, [...new Set([...retired, hookId])]);
    await this.unregisterRetired();
  }
  private async unregisterRetired(): Promise<void> {
    const key = `${this.kind}:retiredHooks`;
    for (const id of this.bots.storage.state(key, z.array(z.string())) ?? []) {
      if (!this.send) return;
      await this.registration(id, false);
      const current = this.bots.storage.state(key, z.array(z.string())) ?? [];
      this.bots.storage.setState(
        key,
        current.filter((hookId) => hookId !== id),
      );
    }
  }
  private async sync(): Promise<void> {
    await this.unregisterRetired();
    for (const bot of this.bots.storage.listBots()) {
      await this.serial(bot.id, async () => {
        const hookId = this.hookIdOf(bot.id);
        if (hookId) await this.registration(hookId, this.enabled);
      });
    }
    if (this.enabled && this.send) await this.afterSync();
  }
  ready(send: (frame: unknown) => void): void {
    this.send = send;
    this.launch(this.sync());
  }
  closed(): void {
    this.send = undefined;
    for (const ack of this.acks.values()) {
      clearTimeout(ack.timer);
      ack.reject(new Error("Relay disconnected"));
    }
    this.acks.clear();
  }
  message(frame: unknown): void {
    const ack = z
      .object({ type: z.enum(["hook_registered", "hook_unregistered"]), hookId: z.string() })
      .safeParse(frame);
    if (ack.success) {
      const key = `${ack.data.type}:${ack.data.hookId}`;
      const pending = this.acks.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.acks.delete(key);
        pending.resolve();
      }
      return;
    }
    const delivery = DeliverySchema.safeParse(frame);
    if (!delivery.success || delivery.data.kind !== this.kind) return;
    const send = this.send;
    this.launch(
      this.receive(delivery.data as HookDelivery).then((response) => {
        send?.(response);
        return;
      }),
    );
  }
  start(): void {
    this.enabled = true;
    this.launch(this.sync());
    this.timer ??= setInterval(() => {
      this.launch(this.drain());
      this.launch(this.flushReplies());
    }, 1000);
    this.timer.unref();
    this.launch(this.drain());
    this.launch(this.flushReplies());
  }
  stop(): void {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.launch(this.sync());
  }
  async dispose(): Promise<void> {
    this.enabled = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.closed();
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    await this.settled();
  }

  /** Drop every receipt and queued reply of a bot whose connector was removed. */
  protected forgetQueued(botId: string): void {
    if (!this.tablesReady) return;
    this.bots.storage.db
      .prepare("DELETE FROM hook_events WHERE kind=? AND bot_id=?")
      .run(this.kind, botId);
    this.bots.storage.db
      .prepare("DELETE FROM hook_replies WHERE kind=? AND bot_id=?")
      .run(this.kind, botId);
  }
  /** Whether this source event id was already received (24 h). */
  protected seen(botId: string, eventId: string): boolean {
    return Boolean(
      this.bots.storage.db
        .prepare("SELECT 1 FROM hook_events WHERE kind=? AND bot_id=? AND event_id=?")
        .get(this.kind, botId, eventId),
    );
  }

  async receive(delivery: HookDelivery): Promise<HookResponse> {
    const respond = (status: number, body?: string): HookResponse => ({
      type: "hook_response",
      deliveryId: delivery.deliveryId,
      status,
      ...(body === undefined ? {} : { body, contentType: "application/json" }),
    });
    if (!this.enabled) return respond(503);
    const bot = this.bots.storage.listBots().find((b) => this.hookIdOf(b.id) === delivery.hookId);
    if (!bot) return respond(404);
    const body = Buffer.from(delivery.bodyB64, "base64");
    if (body.length > MAX_HOOK_BODY_BYTES) return respond(413);
    // The Worker forwards only these; anything else on a frame is ignored, never trusted.
    const headers: Record<string, string> = {};
    for (const name of HOOK_FORWARDED_HEADERS[this.kind]) {
      const value = delivery.headers[name];
      if (value !== undefined) headers[name] = value;
    }
    const scoped = { ...delivery, headers };
    const refused = await this.verify(bot.id, scoped, body);
    if (refused !== null) {
      // Never the body or headers: they may carry the secret or someone's message.
      this.options.logger.warn({ kind: this.kind, status: refused }, "Bot hook delivery refused");
      return respond(refused);
    }
    const accepted = this.accept(bot.id, scoped, body);
    if (accepted.events?.length) {
      const now = this.now();
      this.bots.storage.db.prepare("DELETE FROM hook_events WHERE expires<=?").run(now);
      // Reserve synchronously before the 200, so a retry finds the receipt and never runs twice.
      const insert = this.bots.storage.db.prepare(
        "INSERT OR IGNORE INTO hook_events(kind,bot_id,event_id,expires,data) VALUES (?,?,?,?,?)",
      );
      for (const event of accepted.events)
        insert.run(this.kind, bot.id, event.eventId, now + DAY_MS, JSON.stringify(event.data));
      this.launch(this.drain());
    }
    return respond(accepted.status, accepted.body);
  }
  private async drain(): Promise<void> {
    if (!this.enabled) return;
    const rows = this.bots.storage.db
      .prepare(
        "SELECT bot_id,event_id,data FROM hook_events WHERE kind=? AND data IS NOT NULL ORDER BY rowid",
      )
      .all(this.kind) as { bot_id: string; event_id: string; data: string }[];
    for (const row of rows) {
      if (!this.enabled || this.processing.has(row.bot_id)) continue;
      this.processing.add(row.bot_id);
      this.launch(
        this.serial(row.bot_id, async () => {
          if (!this.enabled) return;
          try {
            await this.process(row.bot_id, row.event_id, JSON.parse(row.data));
          } finally {
            // A failing event is dropped, never retried in a loop; its receipt still blocks redelivery.
            this.bots.storage.db
              .prepare("UPDATE hook_events SET data=NULL WHERE kind=? AND bot_id=? AND event_id=?")
              .run(this.kind, row.bot_id, row.event_id);
          }
        }).finally(() => this.processing.delete(row.bot_id)),
      );
    }
  }
  protected async queueReply(
    botId: string,
    origin: BotConnectorThread,
    text: string,
    id: string = randomUUID(),
  ): Promise<void> {
    if (!text.trim()) return;
    this.bots.storage.db
      .prepare("INSERT OR IGNORE INTO hook_replies VALUES (?,?,?,?,?,?)")
      .run(
        `${this.kind}:${id}`,
        this.kind,
        botId,
        this.now() + DAY_MS,
        this.now(),
        JSON.stringify({ origin, text, id }),
      );
    this.launch(this.flushReplies());
  }
  private async flushReplies(): Promise<void> {
    if (!this.enabled || this.flushingReplies) return;
    this.flushingReplies = true;
    try {
      this.bots.storage.db.prepare("DELETE FROM hook_replies WHERE expires<=?").run(this.now());
      const rows = this.bots.storage.db
        .prepare(
          "SELECT id,bot_id,data FROM hook_replies WHERE kind=? AND data IS NOT NULL AND retry_at<=? ORDER BY rowid",
        )
        .all(this.kind, this.now()) as { id: string; bot_id: string; data: string }[];
      for (const row of rows) {
        if (!this.enabled) break;
        const payload = z
          .object({ origin: BotConnectorThreadSchema, text: z.string(), id: z.string() })
          .parse(JSON.parse(row.data));
        try {
          await this.deliver(row.bot_id, payload.origin, payload.text, payload.id);
          this.bots.storage.db.prepare("UPDATE hook_replies SET data=NULL WHERE id=?").run(row.id);
        } catch (err) {
          this.bots.storage.db
            .prepare("UPDATE hook_replies SET retry_at=? WHERE id=?")
            .run(this.now() + 30_000, row.id);
          this.options.logger.warn(
            { kind: this.kind, error: err instanceof Error ? err.message : "unknown" },
            "Bot connector reply will be retried",
          );
        }
      }
    } finally {
      this.flushingReplies = false;
    }
  }
  /** Earlier messages of this thread, for the bot's context (as slack.ts). */
  protected threadHistory(botId: string, rootId: string): string {
    return this.bots.storage
      .history(botId, 200)
      .filter((m) => m.rootId === rootId)
      .slice(-20)
      .map((m) => `${m.role}: ${m.text}`)
      .join("\n");
  }
}
