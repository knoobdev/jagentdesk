import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  BotSchema,
  BotInputSchema,
  BotItemSchema,
  BotItemEventSchema,
  BotMessageSchema,
  BotRoomSchema,
  type Bot,
  type BotInput,
  type BotItem,
  type BotItemActor,
  type BotItemEvent,
  type BotMessage,
  type BotRoom,
} from "@jagentdesk/protocol/bots/types";
import { BotMemoryHistoryRowSchema, BotSuggestionSchema } from "@jagentdesk/protocol/bots/views";
import type { BotMemoryHistoryRow, BotSuggestion } from "@jagentdesk/protocol/bots/views";
import {
  BOT_MASCOT_IDS,
  DEFAULT_BOT_AVATAR_COLOR,
  PICKABLE_BOT_MASCOT_IDS,
  botFolderName,
} from "@jagentdesk/protocol/bots/rules";
import { ensurePrivateDirectory, ensurePrivateFile } from "../private-files.js";
import { BotsError } from "./home.js";

/** Seeds SOUL.md and the bot's one-line description when the owner leaves Identity empty. */
export const DEFAULT_BOT_IDENTITY =
  "A general-purpose bot: it plans the work its owner asks for, does it, and reports back.";

/** Empty identities are stored as the default so every `Bot` keeps one (older apps require it). */
export function botIdentity(identity: string | undefined): string {
  return identity?.trim() || DEFAULT_BOT_IDENTITY;
}

/** "Same as chats": the host's default mode for a new agent (spec 37.3.3). */
export const SAME_AS_CHATS = "same-as-chats";
/** Memory history rows are kept this long (`shared/bots/bot-memory-history.ts:5`). */
export const BOT_MEMORY_HISTORY_MS = 90 * 24 * 60 * 60_000;

const SCHEMA_VERSION = 2;

function randomMascot(): string {
  const id = PICKABLE_BOT_MASCOT_IDS[Math.floor(Math.random() * PICKABLE_BOT_MASCOT_IDS.length)];
  return `mascot:${id}`;
}

/**
 * The Orca-layout fields a record read from disk may lack: round-1 bots (v1 rows) and rows a
 * newer daemon wrote. Pure: anything that needs the provider (bypass mode) or the home is the
 * service's async migration.
 */
export function normalizeBot(bot: Bot, botsRoot: string): Bot {
  const folder = bot.folder ?? bot.slug;
  const on = bot.lookAround.on ?? bot.lookAround.enabled;
  return {
    ...bot,
    folder,
    slug: folder,
    home: join(botsRoot, folder),
    ...(bot.agentId ? { homeAgentId: bot.agentId } : {}),
    permissionMode: bot.permissionMode ?? (bot.unattended ? bot.modeId : SAME_AS_CHATS),
    // Round-1 rows get a random mascot once, at migration; this covers rows a migration missed.
    avatar: bot.avatar ?? `mascot:${BOT_MASCOT_IDS[0]}`,
    avatarColor: bot.avatarColor ?? DEFAULT_BOT_AVATAR_COLOR,
    notifications: bot.notifications ?? {
      needsPermission: true,
      taskComplete: true,
      couldNotFinish: true,
    },
    lookAround: {
      ...bot.lookAround,
      enabled: on,
      on,
      every: bot.lookAround.every ?? "every-4h",
      weekdaysOnly: bot.lookAround.weekdaysOnly ?? true,
      focus: bot.lookAround.focus ?? "",
    },
    tidyUp: bot.tidyUp ?? { on: true, every: "night" },
    itemsStale: bot.itemsStale ?? 5,
    reviewBeforeDone: bot.reviewBeforeDone ?? false,
  };
}

function newLookAround(input: BotInput["lookAround"]): Bot["lookAround"] {
  const on = input?.on ?? input?.enabled ?? true;
  return {
    enabled: on,
    intervalMinutes: input?.intervalMinutes ?? 240,
    on,
    every: input?.every ?? "every-4h",
    weekdaysOnly: input?.weekdaysOnly ?? true,
    focus: input?.focus ?? "",
  };
}

function newNotifications(input: BotInput["notifications"]): NonNullable<Bot["notifications"]> {
  return {
    needsPermission: input?.needsPermission ?? true,
    taskComplete: input?.taskComplete ?? true,
    couldNotFinish: input?.couldNotFinish ?? true,
  };
}

/** `main/bots/bot-new-record.ts:17-42`: a new bot's record; `normalizeBot` fills the rest. */
function newBotRecord(
  input: BotInput,
  fixed: Partial<Bot> & { id: string; folder: string },
  now: number,
): Bot {
  const permissionMode = input.permissionMode ?? (input.unattended ? input.modeId : SAME_AS_CHATS);
  return {
    ...input,
    ...fixed,
    slug: fixed.folder,
    identity: botIdentity(input.identity),
    modeId: input.modeId ?? SAME_AS_CHATS,
    permissionMode,
    unattended: input.unattended ?? false,
    paused: false,
    schedules: [],
    avatar: input.avatar ?? randomMascot(),
    notifications: newNotifications(input.notifications),
    lookAround: newLookAround(input.lookAround),
    tidyUp: { on: input.tidyUp?.on ?? true, every: input.tidyUp?.every ?? "night" },
    firstRun: true,
    createdAt_ms: now,
    updatedAt_ms: now,
  };
}

export interface NewItemInput {
  botId: string;
  title: string;
  doneMeans: string;
  description?: string;
  chat?: BotItem["chat"];
  madeBy?: BotItem["madeBy"];
  status?: BotItem["status"];
}

export class BotStorage {
  readonly db: Database.Database;
  readonly botsRoot: string;
  constructor(readonly home: string) {
    this.botsRoot = join(home, "bots");
    ensurePrivateDirectory(this.botsRoot);
    const path = join(this.botsRoot, "bots.sqlite");
    this.db = new Database(path);
    ensurePrivateFile(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    const version = this.db.pragma("user_version", { simple: true });
    if (typeof version === "number" && version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error("Bots database is from a newer daemon");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bots (id TEXT PRIMARY KEY, slug TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS items_bot ON items(bot_id);
      CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, data TEXT NOT NULL, pending INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS messages_pending ON messages(bot_id,pending,created);
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS folders (folder TEXT PRIMARY KEY, bot_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS item_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, bot_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS item_events_item ON item_events(item_id, seq);
      CREATE TABLE IF NOT EXISTS memory_history (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_history_bot ON memory_history(bot_id, at);
      CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, key TEXT NOT NULL, data TEXT NOT NULL, dismissed_until INTEGER);
      CREATE INDEX IF NOT EXISTS suggestions_bot ON suggestions(bot_id, key);
    `);
    if (version !== SCHEMA_VERSION) this.migrate(typeof version === "number" ? version : 0);
  }
  /**
   * v1 → v2: round-1 rows gain the Orca fields, their folder is reserved, and items get numbers.
   * Steps that need the provider or the home (bypass mode, `defaultRepo` fact, schedules → core
   * schedules) are flagged `migrate:<botId>` for the service.
   */
  private migrate(from: number): void {
    this.transaction(() => {
      if (from === 1) {
        for (const row of this.db.prepare("SELECT data FROM bots").all() as { data: string }[]) {
          const bot = BotSchema.parse(JSON.parse(row.data));
          const next = normalizeBot(
            { ...bot, reviewBeforeDone: false, avatar: bot.avatar ?? randomMascot() },
            this.botsRoot,
          );
          this.db.prepare("UPDATE bots SET data=? WHERE id=?").run(JSON.stringify(next), next.id);
          this.db.prepare("INSERT OR IGNORE INTO folders VALUES (?,?)").run(next.folder, next.id);
          this.setState(`migrate:${next.id}`, true);
          let number = 0;
          for (const item of this.items(next.id, true)) {
            number += 1;
            this.db.prepare("UPDATE items SET data=? WHERE id=?").run(
              JSON.stringify({
                ...item,
                uid: item.id,
                number,
                chat: item.chat ?? { id: "home", kind: "home", title: null },
                lastActivityAt_ms: item.lastActivityAt_ms ?? item.updatedAt_ms,
              }),
              item.id,
            );
          }
          this.setState(`item-seq:${next.id}`, number);
        }
      }
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    });
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(run: () => T): T {
    return this.db.transaction(run)();
  }
  private rows<T>(sql: string, schema: z.ZodType<T>, ...params: (string | number)[]): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => schema.parse(JSON.parse((row as { data: string }).data)));
  }
  listBots(): Bot[] {
    return this.rows("SELECT data FROM bots ORDER BY slug", BotSchema).map((bot) =>
      normalizeBot(bot, this.botsRoot),
    );
  }
  bot(id: string): Bot {
    const bot = this.rows("SELECT data FROM bots WHERE id=?", BotSchema, id)[0];
    if (!bot) throw new BotsError("not_found", "Bot not found");
    return normalizeBot(bot, this.botsRoot);
  }
  botHome(bot: Pick<Bot, "slug" | "folder">): string {
    return join(this.botsRoot, bot.folder ?? bot.slug);
  }
  /**
   * `main/bots/bot-home-workspace.ts:51-62`: the name's slug, then `-2`, `-3`…; a folder a bot ever
   * held, or one already on disk, is never handed out again.
   */
  private reserveFolder(name: string, requested: string | undefined, botId: string): string {
    const slug = requested ?? botFolderName(name);
    for (let suffix = 1; ; suffix++) {
      const folder = suffix === 1 ? slug : `${slug}-${suffix}`;
      if (requested && suffix > 1) throw new Error("Bot slug already exists");
      if (this.db.prepare("SELECT 1 FROM folders WHERE folder=?").get(folder)) continue;
      if (this.db.prepare("SELECT 1 FROM bots WHERE slug=?").get(folder)) continue;
      const path = join(this.botsRoot, folder);
      if (existsSync(path)) continue;
      mkdirSync(path, { mode: 0o700 });
      this.db.prepare("INSERT INTO folders VALUES (?,?)").run(folder, botId);
      return folder;
    }
  }
  /** `main/bots/bot-new-record.ts:17-42` defaults. The caller writes the home files. */
  createBot(raw: BotInput, extra: Partial<Bot> = {}): Bot {
    const input = BotInputSchema.parse(raw);
    const id = randomUUID();
    return this.transaction(() => {
      const folder = this.reserveFolder(input.name, input.slug, id);
      const bot = normalizeBot(
        BotSchema.parse(newBotRecord(input, { ...extra, id, folder }, Date.now())),
        this.botsRoot,
      );
      this.db.prepare("INSERT INTO bots VALUES (?,?,?)").run(bot.id, bot.slug, JSON.stringify(bot));
      return bot;
    });
  }
  saveBot(bot: Bot): Bot {
    const parsed = normalizeBot(
      BotSchema.parse({ ...bot, updatedAt_ms: Date.now() }),
      this.botsRoot,
    );
    this.db.prepare("UPDATE bots SET data=? WHERE id=?").run(JSON.stringify(parsed), parsed.id);
    return parsed;
  }
  deleteBot(id: string): void {
    this.transaction(() => {
      this.bot(id);
      for (const room of this.rooms()) {
        if (room.memberBotIds.includes(id))
          this.saveRoom({
            ...room,
            memberBotIds: room.memberBotIds.filter((member) => member !== id),
          });
      }
      this.db.prepare("DELETE FROM messages WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM item_events WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM memory_history WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM suggestions WHERE bot_id=?").run(id);
      this.db.prepare("DELETE FROM bots WHERE id=?").run(id);
      // The folder row stays: a folder is never handed out again.
    });
  }
  items(botId: string, includeClosed = false): BotItem[] {
    return this.rows(
      "SELECT data FROM items WHERE bot_id=? ORDER BY rowid",
      BotItemSchema,
      botId,
    ).filter((i) => includeClosed || !["done", "canceled"].includes(i.status));
  }
  item(botId: string, id: string): BotItem {
    const item = this.rows(
      "SELECT data FROM items WHERE id=? AND bot_id=?",
      BotItemSchema,
      id,
      botId,
    )[0];
    if (!item) throw new BotsError("not_found", "Item not found for bot");
    return item;
  }
  /** Finds an item by id, uid or `#N`/`N`. */
  findItem(botId: string, ref: string): BotItem {
    const number = /^#?(\d+)$/.exec(ref.trim())?.[1];
    if (number) {
      const found = this.items(botId, true).find((item) => item.number === Number(number));
      if (found) return found;
    }
    return this.item(botId, ref);
  }
  newItem(input: NewItemInput): BotItem {
    return this.transaction(() => {
      const now = Date.now();
      const number = (this.state(`item-seq:${input.botId}`, z.number()) ?? 0) + 1;
      this.setState(`item-seq:${input.botId}`, number);
      const id = randomUUID();
      return BotItemSchema.parse({
        id,
        uid: id,
        number,
        botId: input.botId,
        title: input.title,
        doneMeans: input.doneMeans,
        ...(input.description ? { description: input.description } : {}),
        status: input.status ?? "planned",
        chat: input.chat ?? { id: "home", kind: "home", title: null },
        madeBy: input.madeBy ?? "bot",
        workerAgentIds: [],
        comments: [],
        reviews: [],
        reviewRounds: 0,
        links: [],
        lastActivityAt_ms: now,
        createdAt_ms: now,
        updatedAt_ms: now,
      });
    });
  }
  saveItem(item: BotItem): BotItem {
    const parsed = BotItemSchema.parse({ ...item, uid: item.id, updatedAt_ms: Date.now() });
    this.db
      .prepare("INSERT INTO items VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(parsed.id, parsed.botId, JSON.stringify(parsed));
    return parsed;
  }
  addItemEvent(
    item: Pick<BotItem, "id" | "botId">,
    kind: BotItemEvent["kind"],
    actor: BotItemActor,
    data: Record<string, unknown>,
  ): BotItemEvent {
    const event = BotItemEventSchema.parse({
      id: randomUUID(),
      itemId: item.id,
      kind,
      actor,
      data,
      at_ms: Date.now(),
    });
    this.db
      .prepare("INSERT INTO item_events (item_id, bot_id, data) VALUES (?,?,?)")
      .run(item.id, item.botId, JSON.stringify(event));
    return event;
  }
  itemEvents(itemId: string): BotItemEvent[] {
    return this.rows(
      "SELECT data FROM item_events WHERE item_id=? ORDER BY seq",
      BotItemEventSchema,
      itemId,
    );
  }
  rooms(): BotRoom[] {
    return this.rows("SELECT data FROM rooms ORDER BY rowid", BotRoomSchema);
  }
  room(id: string): BotRoom {
    const room = this.rooms().find((entry) => entry.id === id);
    if (!room) throw new BotsError("not_found", "Room not found");
    return room;
  }
  saveRoom(room: BotRoom): BotRoom {
    const parsed = BotRoomSchema.parse(room);
    this.db
      .prepare("INSERT INTO rooms VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(parsed.id, JSON.stringify(parsed));
    return parsed;
  }
  deleteRoom(id: string): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE messages SET pending=0 WHERE json_extract(data, '$.roomId')=?")
        .run(id);
      this.db.prepare("DELETE FROM rooms WHERE id=?").run(id);
    });
  }
  message(id: string): BotMessage | undefined {
    return this.rows("SELECT data FROM messages WHERE id=?", BotMessageSchema, id)[0];
  }
  append(message: BotMessage, pending = false): boolean {
    return (
      this.db
        .prepare("INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?)")
        .run(
          message.id,
          message.botId,
          JSON.stringify(BotMessageSchema.parse(message)),
          pending ? 1 : 0,
          message.createdAt_ms,
        ).changes === 1
    );
  }
  /** Rewrites a delivered line in place (a running note that finished). */
  updateMessage(message: BotMessage): BotMessage {
    const parsed = BotMessageSchema.parse({ ...message, updatedAt_ms: Date.now() });
    this.db.prepare("UPDATE messages SET data=? WHERE id=?").run(JSON.stringify(parsed), parsed.id);
    return parsed;
  }
  enqueue(
    botId: string,
    id: string,
    text: string,
    source: string,
    place: Pick<BotMessage, "roomId" | "rootId" | "slack"> = {},
  ): BotMessage | null {
    const message: BotMessage = {
      id,
      botId,
      text,
      role: source === "chat" ? "user" : "system",
      source,
      createdAt_ms: Date.now(),
      ...place,
    };
    return this.append(message, true) ? message : null;
  }
  pending(botId: string): BotMessage[] {
    return this.rows(
      "SELECT data FROM messages WHERE bot_id=? AND pending=1 ORDER BY created,rowid",
      BotMessageSchema,
      botId,
    );
  }
  delivered(id: string): void {
    this.db.prepare("UPDATE messages SET pending=0 WHERE id=?").run(id);
  }
  history(botId: string, limit = 100, before = Number.MAX_SAFE_INTEGER): BotMessage[] {
    return this.db
      .prepare(
        "SELECT data FROM messages WHERE bot_id=? AND created<? ORDER BY created DESC,rowid DESC LIMIT ?",
      )
      .all(botId, before, limit)
      .map((row) => BotMessageSchema.parse(JSON.parse((row as { data: string }).data)))
      .toReversed();
  }
  addMemoryRow(botId: string, row: BotMemoryHistoryRow): BotMemoryHistoryRow {
    const parsed = BotMemoryHistoryRowSchema.parse(row);
    this.db
      .prepare("INSERT INTO memory_history VALUES (?,?,?,?)")
      .run(parsed.id, botId, parsed.at_ms, JSON.stringify(parsed));
    this.db
      .prepare("DELETE FROM memory_history WHERE bot_id=? AND at<?")
      .run(botId, parsed.at_ms - BOT_MEMORY_HISTORY_MS);
    return parsed;
  }
  memoryHistory(botId: string): BotMemoryHistoryRow[] {
    return this.rows(
      "SELECT data FROM memory_history WHERE bot_id=? AND at>=? ORDER BY at DESC, rowid DESC",
      BotMemoryHistoryRowSchema,
      botId,
      Date.now() - BOT_MEMORY_HISTORY_MS,
    );
  }
  saveSuggestion(botId: string, key: string, suggestion: BotSuggestion): void {
    this.db
      .prepare(
        "INSERT INTO suggestions VALUES (?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(suggestion.id, botId, key, JSON.stringify(BotSuggestionSchema.parse(suggestion)));
  }
  /** Suggestions not dismissed (or whose 30-day dismissal ran out), newest first. */
  suggestions(botId: string): BotSuggestion[] {
    return this.rows(
      "SELECT data FROM suggestions WHERE bot_id=? AND (dismissed_until IS NULL) ORDER BY rowid DESC",
      BotSuggestionSchema,
      botId,
    );
  }
  /** Keys a new look must not suggest again: dismissed within the window, or still listed. */
  suggestionKeysBlocked(botId: string, now: number): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            "SELECT key FROM suggestions WHERE bot_id=? AND (dismissed_until IS NULL OR dismissed_until>?)",
          )
          .all(botId, now) as { key: string }[]
      ).map((row) => row.key),
    );
  }
  dismissSuggestion(botId: string, id: string, until: number): void {
    const result = this.db
      .prepare("UPDATE suggestions SET dismissed_until=? WHERE bot_id=? AND id=?")
      .run(until, botId, id);
    if (result.changes === 0) throw new BotsError("not_found", "Suggestion not found");
  }
  deleteSuggestion(botId: string, id: string): void {
    this.db.prepare("DELETE FROM suggestions WHERE bot_id=? AND id=?").run(botId, id);
  }
  suggestion(botId: string, id: string): BotSuggestion {
    const found = this.rows(
      "SELECT data FROM suggestions WHERE bot_id=? AND id=?",
      BotSuggestionSchema,
      botId,
      id,
    )[0];
    if (!found) throw new BotsError("not_found", "Suggestion not found");
    return found;
  }
  state<T>(key: string, schema: z.ZodType<T>): T | undefined {
    const row = this.db.prepare("SELECT data FROM state WHERE key=?").get(key) as
      | { data: string }
      | undefined;
    return row ? schema.parse(JSON.parse(row.data)) : undefined;
  }
  setState(key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO state VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data")
      .run(key, JSON.stringify(value));
  }
  deleteState(key: string): void {
    this.db.prepare("DELETE FROM state WHERE key=?").run(key);
  }
}
