// Sharing a bot by link (spec 37.13, ADR-0061 §5). One link per bot: Publish makes it, Update link
// re-seals the bundle to the same shareId, Stop sharing leaves the Worker answering 410. The daemon
// builds and seals the bundle; the Worker on the owner's Cloudflare account holds ciphertext only.
// Ported in shape from Orca dfdb4fda src/main/bots/sharing/bot-share-service.ts, bot-share-receive.ts
// and bot-share-create.ts (MIT, see vendor/orca-bots/LICENSE), with Orca Cloud replaced by the relay
// Worker's `/s/<shareId>` route and its `share_create` / `share_delete` control frames.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import {
  BOT_SHARE_ERRORS,
  BotShareSelectionSchema,
  BotSharedFromSchema,
  type BotShareSelection,
  type BotShareStatus,
  type BotSharedFrom,
} from "@jagentdesk/protocol/bots/share-schemas";
import type { BotsRequest } from "@jagentdesk/protocol/bots/rpc-schemas";
import { BotAvatarSchema, type Bot, type BotInput } from "@jagentdesk/protocol/bots/types";
import {
  MAX_SHARE_BYTES,
  SHARE_SERVER_HEADER,
  SHARE_UPDATED_HEADER,
} from "@jagentdesk/relay/shares";
import type { SecretStore } from "../../database/secret-store.js";
import type { RelayControlHandler } from "../../relay-transport.js";
import type { BotsService } from "../service.js";
import { readBotPackageArchive } from "./archive.js";
import { botPackagePartOf, type BotPackageConnector } from "./package.js";
import { buildBotPackageContent } from "./content.js";
import { BotShareCandidates, candidatePartFiles, type Candidate } from "./candidates.js";
import { readBotShareable } from "./sources.js";
import {
  BOT_SHARE_MEMORY_INDEX,
  BotShareReviews,
  prepareRecipientContent,
  reviewOf,
  type BotRecipientContent,
} from "./recipient.js";
import {
  ShareSealError,
  formatShareLink,
  newShareKey,
  openShare,
  parseShareLink,
  sealShare,
  shareLinkWithoutKey,
} from "./seal.js";

const LinkState = z.object({
  shareId: z.string(),
  origin: z.string(),
  publishedAt_ms: z.number().int(),
  updatedAt_ms: z.number().int(),
  botDigest: z.string(),
  selection: BotShareSelectionSchema,
});
type LinkState = z.infer<typeof LinkState>;
const linkKey = (botId: string) => `share:link:${botId}`;
const fromKey = (botId: string) => `share:from:${botId}`;
const keySecret = (botId: string) => `bots.share.key.${botId}`;
const tokenSecret = (botId: string) => `bots.share.token.${botId}`;
const copyKeySecret = (botId: string) => `bots.share.copy-key.${botId}`;
const FRAME_TIMEOUT_MS = 10_000;
const FETCH_TIMEOUT_MS = 30_000;
const SlackConnected = z.object({ connected: z.boolean() });

export class BotShareError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BotShareError";
  }
}

type ShareRequest = Extract<BotsRequest, { type: `bots.share.${string}` }>;
interface RelayInfo {
  endpoint: string;
  useTls: boolean;
  enabled: boolean;
  serverId: string;
}

export class BotsSharing implements RelayControlHandler {
  private send: ((frame: unknown) => void) | undefined;
  private readonly waiters = new Map<
    string,
    { resolve: (frame: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly candidates: BotShareCandidates;
  private readonly reviews: BotShareReviews;
  private readonly operations = new Map<string, Promise<unknown>>();
  constructor(
    private readonly bots: BotsService,
    private readonly options: {
      logger: Logger;
      relay: () => RelayInfo;
      secrets: SecretStore;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.candidates = new BotShareCandidates(options.now);
    this.reviews = new BotShareReviews(options.now);
  }

  // ---- relay control socket ----

  ready(send: (frame: unknown) => void): void {
    this.send = send;
  }
  closed(): void {
    this.send = undefined;
    for (const [id, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ type: "share_error", code: "disconnected" });
      this.waiters.delete(id);
    }
  }
  message(frame: unknown): void {
    const parsed = z
      .object({ type: z.string(), requestId: z.string() })
      .passthrough()
      .safeParse(frame);
    if (!parsed.success || !parsed.data.type.startsWith("share_")) return;
    const waiter = this.waiters.get(parsed.data.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiters.delete(parsed.data.requestId);
    waiter.resolve(parsed.data);
  }
  private relayConnected(): boolean {
    return Boolean(this.send && this.options.relay().enabled);
  }
  private control(frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const send = this.send;
    if (!send || !this.options.relay().enabled)
      return Promise.reject(new BotShareError(BOT_SHARE_ERRORS.relayOff));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(requestId);
        reject(new BotShareError(BOT_SHARE_ERRORS.unavailable));
      }, FRAME_TIMEOUT_MS);
      this.waiters.set(requestId, { resolve, timer });
      try {
        send({ ...frame, v: 1, requestId });
      } catch {
        clearTimeout(timer);
        this.waiters.delete(requestId);
        reject(new BotShareError(BOT_SHARE_ERRORS.relayOff));
      }
    });
  }
  /** The Worker's own origin, `https://<endpoint>` (or http for a local relay). */
  private relayOrigin(): string {
    const relay = this.options.relay();
    const host = relay.endpoint.replace(/^(?:https?|wss?):\/\//, "").replace(/\/.*$/, "");
    return new URL(`${relay.useTls ? "https" : "http"}://${host}`).origin;
  }
  private fetch(url: string, init: RequestInit): Promise<Response> {
    return (this.options.fetch ?? fetch)(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  private serial<T>(botId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(botId) ?? Promise.resolve()).catch(() => {}).then(run);
    this.operations.set(botId, next);
    void next
      .finally(() => {
        if (this.operations.get(botId) === next) this.operations.delete(botId);
      })
      .catch(() => {});
    return next;
  }

  // ---- sharer ----

  private connectors(bot: Bot): BotPackageConnector[] {
    const kinds = new Set<BotPackageConnector>();
    if (this.bots.storage.state(`slack:connection:${bot.id}`, SlackConnected)?.connected)
      kinds.add("slack");
    if (bot.jiraAccounts?.length) kinds.add("jira");
    if (bot.githubLogin) kinds.add("github");
    const hooks = this.bots.hooks?.summaries(bot.id);
    if (hooks?.github.connected) kinds.add("github");
    if (hooks?.gitlab.connected) kinds.add("gitlab");
    if (hooks?.telegram.connected) kinds.add("telegram");
    return [...kinds];
  }
  private async build(bot: Bot, selection: BotShareSelection): Promise<Candidate> {
    const shareable = await readBotShareable({
      bot,
      home: this.bots.storage.botHome(bot),
      connectors: this.connectors(bot),
      schedules: await this.bots.schedulesOf(bot.id),
    });
    return this.candidates.prepare({ bot, shareable, selection });
  }
  private link(botId: string): LinkState | undefined {
    return this.bots.storage.state(linkKey(botId), LinkState);
  }

  /** `Bot.share` on the bot record (bots contract), from the stored link; no network. */
  summary(botId: string): { shared: boolean; updatedAt_ms?: number } {
    const link = this.link(botId);
    return link ? { shared: true, updatedAt_ms: link.updatedAt_ms } : { shared: false };
  }

  async status(botId: string): Promise<BotShareStatus> {
    const bot = this.bots.storage.bot(botId);
    const status: BotShareStatus = { relayConnected: this.relayConnected() };
    const from = this.bots.storage.state(fromKey(botId), BotSharedFromSchema);
    if (from) {
      status.sharedFrom = from;
      const head = await this.fetch(from.link, { method: "HEAD" }).catch(() => null);
      if (head?.status === 410) status.originalGone = true;
    }
    const link = this.link(botId);
    if (!link) return status;
    const key = await this.options.secrets.get(keySecret(botId));
    if (!key) return status;
    status.link = formatShareLink({
      origin: link.origin,
      shareId: link.shareId,
      key: Buffer.from(key, "base64url"),
    });
    status.publishedAt_ms = link.publishedAt_ms;
    status.updatedAt_ms = link.updatedAt_ms;
    try {
      const current = await this.build(bot, link.selection);
      status.changedSince = current.summary.botDigest !== link.botDigest;
      this.candidates.release(current.summary.previewId);
    } catch {
      status.changedSince = true;
    }
    return status;
  }

  async prepare(botId: string, selection: BotShareSelection, last?: boolean) {
    const bot = this.bots.storage.bot(botId);
    const saved = last ? this.link(botId)?.selection : undefined;
    const candidate = await this.build(bot, saved ?? selection);
    return saved ? { candidate: candidate.summary, last: saved } : { candidate: candidate.summary };
  }

  private candidateFor(botId: string, previewId: string): Candidate {
    const candidate = this.candidates.get(previewId);
    if (!candidate || candidate.botId !== botId) throw new BotShareError(BOT_SHARE_ERRORS.expired);
    return candidate;
  }

  publish(botId: string, previewId: string): Promise<BotShareStatus> {
    return this.serial(botId, async () => {
      this.bots.storage.bot(botId);
      const candidate = this.candidateFor(botId, previewId);
      const secrets = candidate.content.flags.filter((flag) => flag.kind === "secret");
      if (secrets.length > 0)
        throw new BotShareError(
          secrets.every((flag) => flag.where === "bot.json#setupNote")
            ? BOT_SHARE_ERRORS.noteSecret
            : BOT_SHARE_ERRORS.blocked,
        );
      if (!candidate.written) throw new BotShareError(BOT_SHARE_ERRORS.tooLarge);
      if (!this.relayConnected()) throw new BotShareError(BOT_SHARE_ERRORS.relayOff);
      let link = this.link(botId);
      let key = await this.options.secrets.get(keySecret(botId));
      let token = await this.options.secrets.get(tokenSecret(botId));
      if (!link || !key || !token) {
        const created = await this.control({ type: "share_create" });
        if (created.type !== "share_created") {
          throw new BotShareError(
            created.code === "limit" ? BOT_SHARE_ERRORS.limit : BOT_SHARE_ERRORS.unavailable,
          );
        }
        const fields = z.object({ shareId: z.string(), writeToken: z.string() }).parse(created);
        key = newShareKey().toString("base64url");
        token = fields.writeToken;
        await this.options.secrets.set(keySecret(botId), key);
        await this.options.secrets.set(tokenSecret(botId), token);
        link = {
          shareId: fields.shareId,
          origin: this.relayOrigin(),
          publishedAt_ms: this.now(),
          updatedAt_ms: 0,
          botDigest: "",
          selection: candidate.selection,
        };
        this.bots.storage.setState(linkKey(botId), link);
      }
      const sealed = sealShare({
        key: Buffer.from(key, "base64url"),
        shareId: link.shareId,
        plaintext: candidate.written.archive,
      });
      const response = await this.fetch(`${link.origin}/s/${link.shareId}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          [SHARE_SERVER_HEADER]: this.options.relay().serverId,
          "content-type": "application/octet-stream",
        },
        body: new Uint8Array(sealed),
      }).catch(() => null);
      if (!response) throw new BotShareError(BOT_SHARE_ERRORS.unavailable);
      if (response.status === 404 || response.status === 410) {
        // Stopped elsewhere: this link is gone; the next publish makes a new one.
        await this.forget(botId);
        throw new BotShareError(BOT_SHARE_ERRORS.stopped);
      }
      if (response.status === 413) throw new BotShareError(BOT_SHARE_ERRORS.tooLarge);
      if (!response.ok) throw new BotShareError(BOT_SHARE_ERRORS.unavailable);
      const updatedAt_ms = z
        .object({ updatedAt_ms: z.number().int() })
        .parse(await response.json()).updatedAt_ms;
      this.bots.storage.setState(linkKey(botId), {
        ...link,
        updatedAt_ms,
        botDigest: candidate.summary.botDigest,
        selection: candidate.selection,
      });
      this.candidates.release(previewId);
      this.options.logger.info({ botId }, "Bot share link published");
      return this.status(botId);
    });
  }

  private async forget(botId: string): Promise<void> {
    this.bots.storage.db.prepare("DELETE FROM state WHERE key=?").run(linkKey(botId));
    await this.options.secrets.delete(keySecret(botId));
    await this.options.secrets.delete(tokenSecret(botId));
  }

  stop(botId: string): Promise<BotShareStatus> {
    return this.serial(botId, async () => {
      await this.stopLink(botId);
      return this.status(botId);
    });
  }

  private async stopLink(botId: string): Promise<void> {
    const link = this.link(botId);
    if (!link) return;
    const token = await this.options.secrets.get(tokenSecret(botId));
    if (this.relayConnected()) {
      const reply = await this.control({ type: "share_delete", shareId: link.shareId });
      if (reply.type !== "share_deleted") throw new BotShareError(BOT_SHARE_ERRORS.unavailable);
    } else if (token) {
      const response = await this.fetch(`${link.origin}/s/${link.shareId}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${token}`,
          [SHARE_SERVER_HEADER]: this.options.relay().serverId,
        },
      }).catch(() => null);
      if (!response || (response.status !== 204 && response.status !== 404))
        throw new BotShareError(BOT_SHARE_ERRORS.relayOff);
    } else {
      throw new BotShareError(BOT_SHARE_ERRORS.relayOff);
    }
    await this.forget(botId);
    this.options.logger.info({ botId }, "Bot share link stopped");
  }

  /** A deleted bot's link stops with it; a copy forgets its original's key. */
  async botDeleted(botId: string): Promise<void> {
    await this.serial(botId, () => this.stopLink(botId)).catch((err) =>
      this.options.logger.warn({ err, botId }, "Could not stop a deleted bot's share link"),
    );
    this.bots.storage.db.prepare("DELETE FROM state WHERE key=?").run(fromKey(botId));
    await this.options.secrets.delete(copyKeySecret(botId));
  }

  // ---- recipient ----

  /** Downloads and verifies a link: sealed bytes within the limit, from https or this daemon's relay. */
  private async download(parsed: {
    origin: string;
    shareId: string;
    url: string;
  }): Promise<{ sealed: Buffer; updatedAt_ms: number }> {
    const sameRelay = parsed.origin === this.relayOrigin();
    if (!parsed.url.startsWith("https://") && !sameRelay)
      throw new BotShareError(BOT_SHARE_ERRORS.badLink);
    const response = await this.fetch(parsed.url, { method: "GET" }).catch(() => null);
    if (!response) throw new BotShareError(BOT_SHARE_ERRORS.unavailable);
    if (response.status === 410 || response.status === 404)
      throw new BotShareError(BOT_SHARE_ERRORS.stopped);
    if (!response.ok || !response.body) throw new BotShareError(BOT_SHARE_ERRORS.unavailable);
    if (Number(response.headers.get("content-length")) > MAX_SHARE_BYTES)
      throw new BotShareError(BOT_SHARE_ERRORS.tooLarge);
    const chunks: Buffer[] = [];
    let length = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.length;
        if (length > MAX_SHARE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new BotShareError(BOT_SHARE_ERRORS.tooLarge);
        }
        chunks.push(Buffer.from(part.value));
      }
    } finally {
      reader.releaseLock();
    }
    return {
      sealed: Buffer.concat(chunks),
      updatedAt_ms: Number(response.headers.get(SHARE_UPDATED_HEADER) ?? 0) || 0,
    };
  }

  private existing(shareId: string) {
    for (const bot of this.bots.storage.listBots()) {
      const from = this.bots.storage.state(fromKey(bot.id), BotSharedFromSchema);
      if (from?.shareId === shareId)
        return { botId: bot.id, name: bot.name, createdAt_ms: bot.createdAt_ms };
    }
    return undefined;
  }

  async open(link: string, options: { original?: boolean } = {}) {
    const parsed = parseShareLink(link);
    if (!parsed) throw new BotShareError(BOT_SHARE_ERRORS.badLink);
    const existing = options.original ? undefined : this.existing(parsed.shareId);
    if (existing) return { existing };
    const { sealed, updatedAt_ms } = await this.download(parsed);
    let read;
    try {
      read = readBotPackageArchive(openShare({ key: parsed.key, shareId: parsed.shareId, sealed }));
    } catch (error) {
      if (!(error instanceof ShareSealError) && !(error instanceof Error)) throw error;
      throw new BotShareError(BOT_SHARE_ERRORS.invalid);
    }
    const content = buildBotPackageContent({
      bot: read.bot,
      files: [...read.files].map(([path, bytes]) => ({ path, bytes })),
    });
    const sharedAt = Date.parse(read.transport.createdAt);
    const recipient = prepareRecipientContent(
      content,
      {
        shareId: parsed.shareId,
        link: parsed.url,
        origin: parsed.origin,
        botDigest: read.transport.botDigest,
        updatedAt_ms,
        publisher: null,
        sharedAt_ms: Number.isFinite(sharedAt) ? sharedAt : updatedAt_ms,
      },
      read.droppedKeys,
      parsed.key,
    );
    return { review: reviewOf(recipient, this.reviews.put(recipient)) };
  }

  /** Creates the reviewed bot, once the link is checked to still serve the reviewed version. The bot
   *  is made the normal way first, so any failure after it deletes it by its record. */
  async create(reviewId: string, input: BotInput): Promise<Bot> {
    const recipient = this.reviews.get(reviewId);
    if (!recipient) throw new BotShareError(BOT_SHARE_ERRORS.reviewExpired);
    const head = await this.fetch(recipient.source.link, { method: "HEAD" }).catch(() => null);
    if (!head) throw new BotShareError(BOT_SHARE_ERRORS.unavailable);
    if (head.status === 410 || head.status === 404)
      throw new BotShareError(BOT_SHARE_ERRORS.stopped);
    if (!head.ok) throw new BotShareError(BOT_SHARE_ERRORS.unavailable);
    if (Number(head.headers.get(SHARE_UPDATED_HEADER) ?? 0) !== recipient.source.updatedAt_ms)
      throw new BotShareError(BOT_SHARE_ERRORS.updated);
    const bot = await this.bots.create(input);
    try {
      await this.writeHome(this.bots.storage.botHome(bot), recipient);
      if (!input.avatar) await this.applyAvatar(bot.id, recipient);
      // Shared automations arrive off (ADR-0061 §5), as the bot's core schedules.
      for (const schedule of recipient.bot.schedules)
        await this.bots.saveSchedule(bot.id, {
          name: schedule.name,
          cron: schedule.cron,
          ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
          prompt: schedule.prompt,
          enabled: false,
        });
      const sharedFrom: BotSharedFrom = {
        shareId: recipient.source.shareId,
        link: shareLinkWithoutKey(recipient.source.origin, recipient.source.shareId),
        sharedBy: recipient.source.publisher,
        sharedAt_ms: recipient.source.sharedAt_ms,
        updatedAt_ms: recipient.source.updatedAt_ms,
      };
      this.bots.storage.setState(fromKey(bot.id), sharedFrom);
      await this.options.secrets.set(copyKeySecret(bot.id), recipient.key.toString("base64url"));
    } catch (error) {
      await this.bots.delete(bot.id).catch(() => {});
      throw error;
    }
    this.reviews.delete(reviewId);
    this.options.logger.info({ botId: bot.id }, "Bot created from a share link");
    return this.bots.storage.bot(bot.id);
  }

  /** A copy's original as its link serves it now, with the key the copy kept ("View original"). */
  async original(botId: string) {
    const from = this.bots.storage.state(fromKey(botId), BotSharedFromSchema);
    const key = await this.options.secrets.get(copyKeySecret(botId));
    if (!from || !key) throw new BotShareError(BOT_SHARE_ERRORS.stopped);
    return this.open(`${from.link}#k=${key}`, { original: true });
  }

  private async writeHome(home: string, recipient: BotRecipientContent): Promise<void> {
    const write = async (path: string, bytes: string | Buffer) => {
      const target = join(home, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, bytes, { mode: 0o600 });
    };
    for (const file of recipient.files) {
      if (file.path !== BOT_SHARE_MEMORY_INDEX && !botPackagePartOf(file.path))
        throw new BotShareError(BOT_SHARE_ERRORS.invalid);
      await write(file.path, file.text);
    }
  }

  /** The shared look on the new record (bt1): a mascot id, or the picture through bots.avatar.upload. */
  private async applyAvatar(botId: string, recipient: BotRecipientContent): Promise<void> {
    if (recipient.avatarBase64) {
      // A picture bt1 would refuse (size, shape) leaves the recipient's default mascot.
      await this.bots
        .uploadAvatar(botId, recipient.avatarBase64)
        .catch((err) =>
          this.options.logger.warn(
            { err, botId },
            "Shared bot picture not usable; kept the default",
          ),
        );
      return;
    }
    const shared = recipient.bot.avatar;
    if (!shared || !("mascot" in shared)) return;
    const avatar = BotAvatarSchema.safeParse(`mascot:${shared.mascot}`);
    if (avatar.success) await this.bots.update(botId, { avatar: avatar.data });
  }

  async handle(msg: ShareRequest): Promise<Record<string, unknown>> {
    switch (msg.type) {
      case "bots.share.status.request":
        return { status: await this.status(msg.botId) };
      case "bots.share.prepare.request":
        return this.prepare(msg.botId, msg.selection, msg.last);
      case "bots.share.view.request":
        return { files: candidatePartFiles(this.candidateFor(msg.botId, msg.previewId), msg.part) };
      case "bots.share.publish.request":
        return { status: await this.publish(msg.botId, msg.previewId) };
      case "bots.share.stop.request":
        return { status: await this.stop(msg.botId) };
      case "bots.share.open.request":
        return this.open(msg.link);
      case "bots.share.original.request":
        return this.original(msg.botId);
      case "bots.share.create.request":
        return { bot: await this.create(msg.reviewId, msg.bot) };
      default:
        throw new Error("Unknown bots method");
    }
  }
}
