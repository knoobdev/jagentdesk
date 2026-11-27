// A bot's home folder: what it is (SOUL.md), what it remembers (MEMORY.md, memory/), and the files
// that point its agent at both. Ported from Orca dfdb4fda (MIT, Copyright (c) 2026 Lovecast Inc.):
// src/main/bots/bot-home.ts:146-233, src/shared/bot-soul.ts:3-23.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import { BOT_MEMORY_SEED_INTRO } from "./memory-lines.js";

export class BotsError extends Error {
  constructor(
    readonly code: string,
    message: string = code,
  ) {
    super(message);
    this.name = "BotsError";
  }
}

export function starterSoul(name: string): string {
  return `# ${name}\n\nDescribe ${name} here: what it is for, how it talks, and what it must never do.\n`;
}

/** The New bot dialog's Identity is the first paragraph of SOUL.md; empty keeps the starter soul. */
export function seedSoul(name: string, identity: string | undefined): string {
  const text = identity?.trim();
  return text ? `# ${name}\n\n${text}\n` : starterSoul(name);
}

const STARTER_LINE =
  /^Describe .+ here: what it is for, how it talks, and what it must never do\.$/;
/** The first paragraph that isn't a heading, or null while there is none or it is the starter line. */
export function soulDescription(soul: string): string | null {
  const paragraph = soul
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .find((entry) => !entry.startsWith("#"));
  return paragraph && !STARTER_LINE.test(paragraph) ? paragraph : null;
}

export const BOT_MEMORY_SEED = `# Memory\n\n${BOT_MEMORY_SEED_INTRO}\n`;

interface BotHomeFile {
  path: string;
  text: string;
}

/** JAgentDesk owns these and rewrites them whenever they differ. */
export function generatedBotHomeFiles(bot: Bot): BotHomeFile[] {
  return [
    {
      path: "AGENTS.md",
      text: [
        `# ${bot.name}`,
        "",
        `You are ${bot.name}, a bot that runs in JAgentDesk. This folder is your home.`,
        "",
        "- SOUL.md says who you are and how you work. Change it only when your owner asks.",
        "- MEMORY.md is your memory: one line per fact, details in memory/<topic>.md.",
        '- Keep it current: date new lines, never store secrets. Remove or replace a line with the `bot_memory_forget` tool (`fact: "<its words>"`); a line taken out any other way is put back.',
        "",
        "JAgentDesk writes this file, CLAUDE.md and bot.json; edits to them are replaced.",
        "",
      ].join("\n"),
    },
    { path: "CLAUDE.md", text: "@AGENTS.md\n" },
    {
      path: "bot.json",
      text: `${JSON.stringify(
        { id: bot.id, name: bot.name, provider: bot.provider, avatar: bot.avatar ?? null },
        null,
        2,
      )}\n`,
    },
  ];
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Refuses a home whose bot.json names another bot; a missing one (new or partly removed home) is this bot's. */
export async function assertBotOwnsHome(folder: string, botId: string): Promise<void> {
  const text = await readText(join(folder, "bot.json"));
  let id: unknown;
  try {
    const record: unknown = text === null ? null : JSON.parse(text);
    id = typeof record === "object" && record !== null && "id" in record ? record.id : undefined;
  } catch {
    id = undefined;
  }
  if (typeof id === "string" && id !== botId)
    throw new BotsError("bot_folder_not_owned", "Bot folder belongs to another bot");
}

/** Safe to repeat: seeded files are never overwritten and generated ones are written only on change. */
export async function writeBotHome(folder: string, bot: Bot, soul?: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await assertBotOwnsHome(folder, bot.id);
  for (const dir of ["memory", join("memory", "journal"), "skills"])
    await mkdir(join(folder, dir), { recursive: true, mode: 0o700 });
  for (const file of [
    { path: "SOUL.md", text: soul ?? starterSoul(bot.name) },
    { path: "MEMORY.md", text: BOT_MEMORY_SEED },
  ]) {
    try {
      await writeFile(join(folder, file.path), file.text, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  for (const file of generatedBotHomeFiles(bot)) {
    const path = join(folder, file.path);
    if ((await readText(path)) !== file.text) await writeFile(path, file.text, { mode: 0o600 });
  }
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

export async function readHomeText(folder: string, file: string): Promise<string> {
  return (await readText(join(folder, file))) ?? "";
}
