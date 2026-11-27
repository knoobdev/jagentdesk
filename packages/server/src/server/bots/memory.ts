// MEMORY.md as the daemon keeps it (spec 37.2.4): an official record per bot, a 90-day history with
// Undo, and lines a chat dropped without `bot_memory_forget` put back. After Orca dfdb4fda (MIT):
// src/main/bots/bot-memory-history*.ts, bot-memory-keep.ts, shared/bots/bot-memory-history.ts.
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type {
  BotMemoryAuthor,
  BotMemoryHistoryRow,
  BotMemoryView,
} from "@jagentdesk/protocol/bots/views";
import { BOT_MEMORY_INDEX_LINE_CAP } from "@jagentdesk/protocol/bots/rules";
import {
  addBotMemoryFact,
  applyBotMemoryChange,
  botMemoryChange,
  botMemoryDate,
  botMemoryFactKeys,
  botMemoryLineKey,
  botMemoryLineKind,
  countBotMemoryLines,
  dropBotMemoryFact,
  editBotMemoryFact,
  findBotMemoryFact,
  isEmptyBotMemoryChange,
  parseBotMemoryFacts,
  type BotMemoryChange,
} from "./memory-lines.js";
import { BotsError, contentHash, readHomeText } from "./home.js";
import type { BotStorage } from "./storage.js";

const OfficialSchema = z.string();

export async function writeHomeFile(home: string, file: string, text: string): Promise<void> {
  const path = join(home, file);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, path);
}

export class BotMemory {
  constructor(
    private readonly storage: BotStorage,
    private readonly changed: (botId: string) => void,
  ) {}

  private officialKey(botId: string): string {
    return `memory-official:${botId}`;
  }

  async text(bot: Bot): Promise<string> {
    return readHomeText(this.storage.botHome(bot), "MEMORY.md");
  }

  async view(bot: Bot): Promise<BotMemoryView> {
    const text = await this.text(bot);
    return {
      facts: parseBotMemoryFacts(text).map((fact) =>
        Object.assign(fact, { kind: botMemoryLineKind(fact.text).kind }),
      ),
      count: countBotMemoryLines(text),
      cap: BOT_MEMORY_INDEX_LINE_CAP,
    };
  }

  /** Writes MEMORY.md, records the row and makes the result official. */
  private async commit(
    bot: Bot,
    before: string,
    after: string,
    by: BotMemoryAuthor,
  ): Promise<BotMemoryHistoryRow | null> {
    const change = botMemoryChange(before, after);
    if (after !== before) await writeHomeFile(this.storage.botHome(bot), "MEMORY.md", after);
    this.storage.setState(this.officialKey(bot.id), after);
    if (isEmptyBotMemoryChange(change)) return null;
    const row = this.storage.addMemoryRow(bot.id, {
      id: randomUUID(),
      at_ms: Date.now(),
      by,
      change,
      undoable: true,
    });
    this.changed(bot.id);
    return row;
  }

  async add(bot: Bot, text: string, by: BotMemoryAuthor = { kind: "owner" }): Promise<void> {
    await this.reconcile(bot);
    const before = await this.text(bot);
    const after = addBotMemoryFact(before, text, botMemoryDate(new Date()));
    await this.commit(bot, before, after, by);
  }

  private located(text: string, line: number, expected: string) {
    const facts = parseBotMemoryFacts(text);
    const atLine = facts.find((fact) => fact.line === line && fact.text === expected);
    const fact =
      atLine ??
      (() => {
        const near = facts.find((entry) => entry.text === expected);
        return near ? findBotMemoryFact(text, near) : undefined;
      })();
    if (!fact) throw new BotsError("file_changed", "That line changed since you read it");
    return fact;
  }

  async edit(bot: Bot, line: number, expected: string, next: string): Promise<void> {
    await this.reconcile(bot);
    const before = await this.text(bot);
    const after = editBotMemoryFact(before, this.located(before, line, expected), next);
    await this.commit(bot, before, after, { kind: "owner" });
  }

  async forget(bot: Bot, line: number, expected: string): Promise<void> {
    await this.edit(bot, line, expected, "");
  }

  /** The bot's own forget command (`bot_memory_forget`): the only way a chat removes a line. */
  async forgetFact(bot: Bot, words: string, agentId: string): Promise<number> {
    await this.reconcile(bot, agentId);
    const before = await this.text(bot);
    const { text: after, dropped } = dropBotMemoryFact(before, words);
    if (dropped === 0) throw new BotsError("not_found", "No line states that fact");
    await this.commit(bot, before, after, { kind: "bot", agentId });
    return dropped;
  }

  /** The owner's whole-file write (Soul and Memory editor). */
  async writeAll(bot: Bot, after: string): Promise<void> {
    await this.reconcile(bot);
    const before = await this.text(bot);
    await this.commit(bot, before, after, { kind: "owner" });
  }

  /** Tidy memory's applied draft; returns its History row id. */
  async applyTidy(bot: Bot, before: string, after: string): Promise<string | undefined> {
    const row = await this.commit(bot, before, after, { kind: "tidy-up" });
    return row?.id;
  }

  /**
   * Compares MEMORY.md with the official record after a chat's turn: lines it added are recorded
   * as that chat's; lines it dropped without the forget tool are put back (`kept`).
   */
  async reconcile(bot: Bot, agentId?: string): Promise<void> {
    const official = this.storage.state(this.officialKey(bot.id), OfficialSchema);
    const current = await this.text(bot);
    if (official === undefined) {
      this.storage.setState(this.officialKey(bot.id), current);
      return;
    }
    if (official === current) return;
    const change = botMemoryChange(official, current);
    let next = current;
    const by: BotMemoryAuthor = agentId ? { kind: "chat", agentId } : { kind: "owner" };
    if (change.added.length > 0) {
      this.storage.addMemoryRow(bot.id, {
        id: randomUUID(),
        at_ms: Date.now(),
        by,
        change: { added: change.added, removed: [] },
        undoable: true,
      });
    }
    if (change.removed.length > 0) {
      next = applyBotMemoryChange(current, { added: change.removed, removed: [] });
      await writeHomeFile(this.storage.botHome(bot), "MEMORY.md", next);
      this.storage.addMemoryRow(bot.id, {
        id: randomUUID(),
        at_ms: Date.now(),
        by: { kind: "kept", agentId: agentId ?? "unknown" },
        change: { added: change.removed, removed: [] },
        undoable: false,
      });
    }
    this.storage.setState(this.officialKey(bot.id), next);
    this.changed(bot.id);
  }

  history(bot: Bot): BotMemoryHistoryRow[] {
    return this.storage.memoryHistory(bot.id);
  }

  /** Reverts one row's change; `superseded` when none of its lines are as it left them. */
  async undo(bot: Bot, rowId: string): Promise<void> {
    const row = this.history(bot).find((entry) => entry.id === rowId);
    if (!row) throw new BotsError("not_found", "History row not found");
    if (!row.undoable)
      throw new BotsError("superseded", "Nothing left to undo: those lines changed since.");
    await this.reconcile(bot);
    const before = await this.text(bot);
    const keys = botMemoryFactKeys(before);
    const inverse: BotMemoryChange = {
      added: row.change.removed.filter((line) => !keys.has(botMemoryLineKey(line) ?? "")),
      removed: row.change.added.filter((line) => keys.has(botMemoryLineKey(line) ?? "")),
    };
    if (isEmptyBotMemoryChange(inverse))
      throw new BotsError("superseded", "Nothing left to undo: those lines changed since.");
    const after = applyBotMemoryChange(before, inverse);
    await this.commit(bot, before, after, { kind: "undo", of: rowId });
  }

  async readFile(
    bot: Bot,
    file: "SOUL.md" | "MEMORY.md",
  ): Promise<{ content: string; hash: string }> {
    const content = await readHomeText(this.storage.botHome(bot), file);
    return { content, hash: contentHash(content) };
  }

  /** `bots.home_file.write`: a stale `baseHash` fails with `file_changed`. */
  async writeFile(
    bot: Bot,
    file: "SOUL.md" | "MEMORY.md",
    content: string,
    baseHash: string | undefined,
  ): Promise<{ content: string; hash: string }> {
    const current = await this.readFile(bot, file);
    if (baseHash !== undefined && baseHash !== current.hash)
      throw new BotsError("file_changed", `${file} changed on disk.`);
    if (file === "MEMORY.md") await this.writeAll(bot, content);
    else await writeHomeFile(this.storage.botHome(bot), file, content);
    return { content, hash: contentHash(content) };
  }

  /** The daemon's journal line for a closed item (`memory/journal/YYYY-MM.md`). */
  async appendJournal(bot: Bot, file: string, line: string): Promise<void> {
    const path = join(this.storage.botHome(bot), "memory", "journal", file);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await appendFile(path, `${line}\n`, { mode: 0o600 });
  }
}
