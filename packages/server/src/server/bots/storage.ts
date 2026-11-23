import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  BotSchema,
  BotInputSchema,
  BotItemSchema,
  BotMessageSchema,
  BotRoomSchema,
  type Bot,
  type BotInput,
  type BotItem,
  type BotMessage,
  type BotRoom,
} from "@jagentdesk/protocol/bots/types";
import { ensurePrivateDirectory, ensurePrivateFile } from "../private-files.js";

export class BotStorage {
  readonly db: Database.Database;
  constructor(readonly home: string) {
    ensurePrivateDirectory(join(home, "bots"));
    const path = join(home, "bots", "bots.sqlite");
    this.db = new Database(path);
    ensurePrivateFile(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    const version = this.db.pragma("user_version", { simple: true });
    if (typeof version === "number" && version > 1) {
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
      PRAGMA user_version = 1;
    `);
  }
  close(): void {
    this.db.close();
  }
  transaction<T>(run: () => T): T {
    return this.db.transaction(run)();
  }
  private rows<T>(sql: string, schema: z.ZodType<T>, ...params: string[]): T[] {
    return this.db
      .prepare(sql)
      .all(...params)
      .map((row) => schema.parse(JSON.parse((row as { data: string }).data)));
  }
  listBots(): Bot[] {
    return this.rows("SELECT data FROM bots ORDER BY slug", BotSchema);
  }
  bot(id: string): Bot {
    const bot = this.rows("SELECT data FROM bots WHERE id=?", BotSchema, id)[0];
    if (!bot) throw new Error("Bot not found");
    return bot;
  }
  botHome(bot: Bot): string {
    return join(this.home, "bots", bot.slug);
  }
  createBot(raw: BotInput): Bot {
    const input = BotInputSchema.parse(raw);
    if (this.db.prepare("SELECT id FROM bots WHERE slug=?").get(input.slug))
      throw new Error("Bot slug already exists");
    const now = Date.now();
    const bot: Bot = {
      ...input,
      id: randomUUID(),
      unattended: input.unattended ?? false,
      paused: false,
      schedules: [],
      lookAround: input.lookAround ?? { enabled: false, intervalMinutes: 60 },
      createdAt_ms: now,
      updatedAt_ms: now,
    };
    this.transaction(() => {
      this.db.prepare("INSERT INTO bots VALUES (?,?,?)").run(bot.id, bot.slug, JSON.stringify(bot));
      const home = this.botHome(bot);
      ensurePrivateDirectory(home);
      for (const dir of ["memory", "skills"])
        mkdirSync(join(home, dir), { recursive: true, mode: 0o700 });
      for (const [file, text] of [
        ["SOUL.md", `# ${bot.name}\n\n${bot.identity}\n`],
        ["MEMORY.md", "# Memory\n"],
      ]) {
        try {
          writeFileSync(join(home, file), text, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    });
    return bot;
  }
  saveBot(bot: Bot): Bot {
    const parsed = BotSchema.parse({ ...bot, updatedAt_ms: Date.now() });
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
      this.db.prepare("DELETE FROM bots WHERE id=?").run(id);
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
    if (!item) throw new Error("Item not found for bot");
    return item;
  }
  saveItem(item: BotItem): BotItem {
    const parsed = BotItemSchema.parse({ ...item, updatedAt_ms: Date.now() });
    this.db
      .prepare("INSERT INTO items VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data")
      .run(parsed.id, parsed.botId, JSON.stringify(parsed));
    return parsed;
  }
  rooms(): BotRoom[] {
    return this.rows("SELECT data FROM rooms ORDER BY rowid", BotRoomSchema);
  }
  room(id: string): BotRoom {
    const room = this.rooms().find((entry) => entry.id === id);
    if (!room) throw new Error("Room not found");
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
  enqueue(
    botId: string,
    id: string,
    text: string,
    source: string,
    place: { roomId?: string; rootId?: string } = {},
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
}
