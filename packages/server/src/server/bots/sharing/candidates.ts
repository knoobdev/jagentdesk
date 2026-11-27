// Sharing a bot: the one temporary candidate built from the owner's picks: the package value, the
// archive packed from it, and the summary read from it. Ported from Orca dfdb4fda
// src/main/bots/sharing/bot-package-export.ts and bot-share-available.ts (MIT, see
// vendor/orca-bots/LICENSE); held in memory, since JAgentDesk seals and uploads the archive itself.
import { randomUUID } from "node:crypto";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type {
  BotShareCandidate,
  BotSharePartFile,
  BotShareSelection,
} from "@jagentdesk/protocol/bots/share-schemas";
import {
  BOT_DISPLAY_NAME_MAX,
  BOT_PACKAGE_PURPOSE_MAX,
  BOT_PACKAGE_SCHEMA_VERSION,
  BOT_PACKAGE_SETUP_NOTE_MAX,
  BOT_PACKAGE_SOUL_PATH,
  BotPackageV1Schema,
  type BotPackageV1,
} from "./package.js";
import { landingLine, writeBotPackageArchive, type WrittenBotPackage } from "./archive.js";
import {
  buildBotPackageContent,
  contentArchiveFiles,
  withoutHiddenCharacters,
  type BotPackageContent,
} from "./content.js";
import { sharerRawFiles, type BotShareable } from "./sources.js";
import { hasUnsafeText, scanBotText, textLineCount } from "./text-scan.js";

const CANDIDATE_TTL_MS = 30 * 60 * 1000;
const MAX_CANDIDATES = 8;

/** Absent picks take every part; memory is off unless named. */
function picked<T>(
  entries: readonly T[],
  names: readonly string[] | undefined,
  key: (e: T) => string,
): T[] {
  if (names === undefined) return [...entries];
  const wanted = new Set(names);
  return entries.filter((entry) => wanted.has(key(entry)));
}

/** The note as a link carries it. */
function cleanNote(note: string): string {
  return withoutHiddenCharacters(note.trim()).slice(0, BOT_PACKAGE_SETUP_NOTE_MAX);
}

/** The bot.json for the owner's picks. */
export function botPackageFor(
  bot: Bot,
  shareable: BotShareable,
  selection: BotShareSelection,
): BotPackageV1 {
  const note = cleanNote(selection.setupNote ?? "");
  return BotPackageV1Schema.parse({
    schemaVersion: BOT_PACKAGE_SCHEMA_VERSION,
    name: bot.name,
    ...(shareable.avatar ? { avatar: shareable.avatar } : {}),
    purpose: landingLine(shareable.purpose, BOT_PACKAGE_PURPOSE_MAX),
    agentHint: bot.provider,
    skills: picked(shareable.skills, selection.skills, (entry) => entry.name).map(({ name }) => ({
      name,
    })),
    connectors: shareable.connectors.map((kind) => ({ kind })),
    schedules: picked(shareable.schedules, selection.schedules, (entry) => entry.scheduleId).map(
      ({ scheduleId: _id, ...schedule }) => schedule,
    ),
    memory: picked(shareable.memory, selection.memory ?? [], (entry) => entry.topic).map(
      ({ topic }) => ({ topic }),
    ),
    ...(note ? { setupNote: note } : {}),
  });
}

export interface Candidate {
  botId: string;
  selection: BotShareSelection;
  content: BotPackageContent;
  /** Null when the picks are over the size or file limits. */
  written: WrittenBotPackage | null;
  summary: BotShareCandidate;
  expiresAt_ms: number;
}

const isSizeError = (error: unknown) =>
  error instanceof Error && /size-limit|part-size|tar-path-limit/.test(error.message);

/** One temporary candidate per bot: built from the picks, published by its digest. */
export class BotShareCandidates {
  private readonly candidates = new Map<string, Candidate>();
  constructor(private readonly now: () => number = Date.now) {}

  async prepare(input: {
    bot: Bot;
    shareable: BotShareable;
    selection: BotShareSelection;
  }): Promise<Candidate> {
    this.prune();
    for (const [id, entry] of this.candidates)
      if (entry.botId === input.bot.id) this.candidates.delete(id);
    if (
      input.bot.name !== input.bot.name.trim() ||
      hasUnsafeText(input.bot.name) ||
      input.bot.name.length > BOT_DISPLAY_NAME_MAX
    )
      throw new Error(
        "The bot's name has characters a link page can't show. Rename it to share it.",
      );
    const { files: raw, refused } = await sharerRawFiles(
      input.shareable,
      botPackageFor(input.bot, input.shareable, input.selection),
    );
    // A picked skill that couldn't be read goes out of the manifest and the choices, with why.
    const refusedNames = new Set(refused.map((entry) => entry.name));
    const packed: BotShareable = {
      ...input.shareable,
      skills: input.shareable.skills.filter((skill) => !refusedNames.has(skill.name)),
      leftOut: [...input.shareable.leftOut, ...refused],
    };
    const content = buildBotPackageContent({
      bot: botPackageFor(input.bot, packed, input.selection),
      files: raw,
    });
    let written: WrittenBotPackage | null = null;
    try {
      written = writeBotPackageArchive({
        files: contentArchiveFiles(content),
        versionId: randomUUID(),
        displayName: content.bot.name,
        description: content.bot.purpose,
        createdAt: new Date(this.now()).toISOString(),
      });
    } catch (error) {
      if (!isSizeError(error)) throw error;
    }
    if (this.candidates.size >= MAX_CANDIDATES) {
      const [oldest] = this.candidates.keys();
      this.candidates.delete(oldest);
    }
    const previewId = randomUUID();
    const expiresAt_ms = this.now() + CANDIDATE_TTL_MS;
    const files = written
      ? written.transport.files.map(({ path, role, size }) => ({ path, role, size }))
      : contentArchiveFiles(content).map((file) => ({
          path: file.path,
          role: file.path.split("/")[0] ?? file.path,
          size: file.bytes.length,
        }));
    const summary: BotShareCandidate = {
      previewId,
      botDigest: written?.transport.botDigest ?? "",
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      bot: content.bot,
      files,
      leftOut: packed.leftOut,
      notIncluded: [...content.notIncluded],
      available: {
        soulLines: textLineCount(input.shareable.soul),
        skills: packed.skills.map(({ name, description }) => ({ name, description })),
        schedules: packed.schedules.map(({ scheduleId, name, cron }) => ({
          scheduleId,
          name,
          cron,
        })),
        memory: await Promise.all(
          packed.memory.map(async ({ topic }) => {
            const file = content.files.find((entry) => entry.path === `memory/${topic}.md`);
            const rawFile = raw.find((entry) => entry.path === `memory/${topic}.md`);
            const text = file?.text ?? (rawFile ? Buffer.from(rawFile.bytes).toString("utf8") : "");
            return { topic, lines: text ? textLineCount(text) : 0 };
          }),
        ),
      },
      flags: [...content.flags],
      blocked: content.flags.some((flag) => flag.kind === "secret"),
      tooLarge: written === null,
      expiresAt_ms,
    };
    const candidate: Candidate = {
      botId: input.bot.id,
      selection: input.selection,
      content,
      written,
      summary,
      expiresAt_ms,
    };
    this.candidates.set(previewId, candidate);
    return candidate;
  }

  /** The live candidate; null once released or expired. */
  get(previewId: string): Candidate | null {
    this.prune();
    return this.candidates.get(previewId) ?? null;
  }

  release(previewId: string): void {
    this.candidates.delete(previewId);
  }

  private prune(): void {
    for (const [id, candidate] of this.candidates)
      if (candidate.expiresAt_ms <= this.now()) this.candidates.delete(id);
  }
}

/** `soul`, `skill:<name>` (its folder, ending in `/`), `memory:<topic>` or a package path. */
function partPrefix(part: string): string {
  if (part === "soul") return BOT_PACKAGE_SOUL_PATH;
  if (part.startsWith("skill:")) return `skills/${part.slice("skill:".length)}/`;
  if (part.startsWith("memory:")) return `memory/${part.slice("memory:".length)}.md`;
  return part;
}

/** The exact text of one part of the candidate, as the archive carries it, with its flagged lines. */
export function candidatePartFiles(candidate: Candidate, part: string): BotSharePartFile[] {
  const { content } = candidate;
  const asFile = (path: string, text: string): BotSharePartFile => ({
    path,
    text,
    flags: scanBotText(text).map(({ line, kind }) => ({ line, kind })),
  });
  if (part === "note") return [asFile("bot.json#setupNote", content.bot.setupNote ?? "")];
  const prefix = partPrefix(part);
  return content.files
    .filter((file) => (prefix.endsWith("/") ? file.path.startsWith(prefix) : file.path === prefix))
    .map((file) => asFile(file.path, file.text));
}
