// The one frozen value a shared bot is, on both sides of a link: built once from raw files by one
// allowlist, then read by every review page, the safety check, the archive and the recipient's writer.
// Ported from Orca dfdb4fda src/main/bots/sharing/bot-package-content.ts (MIT, see
// vendor/orca-bots/LICENSE); JAgentDesk bots have no tools, so the tool address check is dropped.
import { parseDocument, stringify } from "yaml";
import {
  BOT_PACKAGE_AVATAR_PATH,
  BOT_PACKAGE_MANIFEST_PATH,
  BOT_PACKAGE_SOUL_PATH,
  BotPackageV1Schema,
  botPackagePartOf,
  compareCodeUnits,
  type BotPackageV1,
} from "./package.js";
import { scanBotText, withoutUnsafeText, type BotTextFlagKind } from "./text-scan.js";
import { stripPngMetadata } from "./png-strip.js";
import type { BotArchiveFile } from "./archive.js";

export interface BotShareFlag {
  /** An archive path, or `bot.json#<field>` for a manifest string. */
  where: string;
  line: number | null;
  kind: BotTextFlagKind | "runnable";
}

/** A file as written, by its package path; documents only, so always text. */
export interface BotPackageFile {
  readonly path: string;
  readonly text: string;
}

export interface BotPackageContent {
  readonly bot: BotPackageV1;
  /** SOUL.md, skills/<name>/…, memory/<topic>.md: sorted by path, UTF-8, LF. */
  readonly files: readonly BotPackageFile[];
  /** The picture, validated and stripped of metadata, as base64; null for a mascot or none. */
  readonly avatarBase64: string | null;
  /** What the raw files had that the value doesn't, in the review's words; never the dropped text. */
  readonly notIncluded: readonly string[];
  /** The safety check of exactly `bot` and `files`. */
  readonly flags: readonly BotShareFlag[];
}

export interface BotPackageRawFile {
  path: string;
  bytes: Uint8Array;
}

// Plain documents a SKILL.md can point to. Scripts, data and every agent's config are left out: none
// is needed to read a skill, and each can run code or reach a server.
const SKILL_DOCUMENT = /\.(?:md|markdown|txt)$/i;
// Instruction files an agent loads by itself when it works in a folder; a skill is read only when picked.
const AUTO_LOADED = new Set(["claude.md", "agents.md", "gemini.md"]);

/** Whether a file of a shared skill (its path inside the skill folder) can be kept. */
export function isSkillDocument(path: string): boolean {
  const segments = path.split("/");
  const file = segments.at(-1)?.toLowerCase() ?? "";
  return (
    path === "SKILL.md" ||
    (SKILL_DOCUMENT.test(path) &&
      segments[0]?.toLowerCase() !== "agents" &&
      !segments.some((segment) => segment.startsWith(".")) &&
      !AUTO_LOADED.has(file))
  );
}

/** Hidden characters blanked; line breaks and tabs kept. */
export function withoutHiddenCharacters(text: string): string {
  return text.replace(/[^\n\t]+/g, (run) => withoutUnsafeText(run));
}

/** UTF-8 text with LF line ends; null for anything that isn't a plain document. */
function documentText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/\r\n?/g, "\n");
  } catch {
    return null;
  }
}

/**
 * A SKILL.md rebuilt from its frontmatter's `name` and `description` alone: what an agent reads to
 * pick the skill, which grant nothing. Every other key (`allowed-tools`, `hooks`, `model`…) is left
 * behind. Null when the frontmatter isn't one plain YAML mapping whose name is the folder's.
 */
export function skillMdFor(text: string, name: string): { text: string; dropped: string[] } | null {
  const lines = text.split("\n");
  const end =
    lines[0]?.trimEnd() === "---"
      ? lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---")
      : -1;
  if (end === -1) return null;
  let fields: [string, unknown][];
  try {
    const document = parseDocument(lines.slice(1, end).join("\n"), {
      uniqueKeys: true,
      merge: false,
      customTags: [],
    });
    const value: unknown =
      document.errors.length === 0 ? document.toJS({ maxAliasCount: 0 }) : null;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    fields = Object.entries(value);
  } catch {
    return null;
  }
  const found = new Map(fields);
  const description = found.get("description");
  if (found.get("name") !== name || (description !== undefined && typeof description !== "string"))
    return null;
  const kept = {
    name,
    ...(description
      ? { description: withoutHiddenCharacters(description).replace(/\s+/g, " ") }
      : {}),
  };
  return {
    text: `---\n${stringify(kept, { lineWidth: 0 })}---\n${lines.slice(end + 1).join("\n")}`,
    dropped: fields.map(([key]) => key).filter((key) => key !== "name" && key !== "description"),
  };
}

/** bot.json's strings, each with its dotted path. */
function manifestStrings(value: unknown, path: string[] = []): [string, string][] {
  if (typeof value === "string") return [[path.join("."), value]];
  if (Array.isArray(value))
    return value.flatMap((entry, index) => manifestStrings(entry, [...path, String(index)]));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([key, entry]) => manifestStrings(entry, [...path, key]));
  return [];
}

/** The safety check of a manifest and files exactly as given. */
export function scanBotPackage(
  bot: BotPackageV1,
  files: readonly BotPackageFile[],
): BotShareFlag[] {
  return [
    ...manifestStrings(bot).flatMap(([field, text]) =>
      scanBotText(text).map(({ line, kind }) => ({ where: `bot.json#${field}`, line, kind })),
    ),
    ...files.flatMap((file) =>
      scanBotText(file.text).map(({ line, kind }) => ({ where: file.path, line, kind })),
    ),
  ];
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) freeze(entry);
  }
  return value;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The value of a package: the manifest's declared parts, kept only where safe and readable. */
export function buildBotPackageContent(input: {
  bot: BotPackageV1;
  files: readonly BotPackageRawFile[];
}): BotPackageContent {
  const notIncluded: string[] = [];
  const raw = new Map(input.files.map((file) => [file.path, file.bytes]));
  const files: BotPackageFile[] = [];
  const textOf = (path: string) => {
    const bytes = raw.get(path);
    return bytes ? documentText(bytes) : null;
  };

  const soul = textOf(BOT_PACKAGE_SOUL_PATH);
  if (soul === null) throw new Error("bot-package-soul-invalid");
  files.push({ path: BOT_PACKAGE_SOUL_PATH, text: withoutHiddenCharacters(soul) });

  const skills = input.bot.skills.filter(({ name }) => {
    const skillMd = textOf(`skills/${name}/SKILL.md`);
    const projected = skillMd === null ? null : skillMdFor(skillMd, name);
    if (!projected) {
      notIncluded.push(`${name} (its SKILL.md can't be read safely)`);
      return false;
    }
    files.push({ path: `skills/${name}/SKILL.md`, text: withoutHiddenCharacters(projected.text) });
    notIncluded.push(...projected.dropped.map((key) => `${key} in ${name}`));
    for (const [path] of raw) {
      const part = botPackagePartOf(path);
      if (part?.role !== "skill" || part.name !== name || part.path === "SKILL.md") continue;
      const text = isSkillDocument(part.path) ? textOf(path) : null;
      if (text === null) notIncluded.push(`${part.path} in ${name}`);
      else files.push({ path, text: withoutHiddenCharacters(text) });
    }
    return true;
  });

  const memory = input.bot.memory.filter(({ topic }) => {
    const text = textOf(`memory/${topic}.md`);
    if (text === null) {
      notIncluded.push(`memory/${topic}.md`);
      return false;
    }
    files.push({ path: `memory/${topic}.md`, text: withoutHiddenCharacters(text) });
    return true;
  });

  let avatarBase64: string | null = null;
  const image = Boolean(input.bot.avatar && "image" in input.bot.avatar);
  if (image) {
    const png = raw.get(BOT_PACKAGE_AVATAR_PATH);
    const stripped = png ? stripPngMetadata(png) : null;
    if (stripped) avatarBase64 = stripped.toString("base64");
    else notIncluded.push("the picture");
  }

  const text = (value: string) => withoutHiddenCharacters(value);
  const bot = BotPackageV1Schema.parse({
    ...input.bot,
    ...(image && !avatarBase64 ? { avatar: undefined } : {}),
    purpose: text(input.bot.purpose).replace(/\s+/g, " "),
    skills,
    memory,
    schedules: input.bot.schedules.map((entry) => ({
      ...entry,
      name: text(entry.name),
      prompt: text(entry.prompt),
    })),
    ...(input.bot.setupNote ? { setupNote: text(input.bot.setupNote) } : {}),
  });
  files.sort((left, right) => compareCodeUnits(left.path, right.path));
  return freeze({ bot, files, avatarBase64, notIncluded, flags: scanBotPackage(bot, files) });
}

/** The archive files a value is packed from: these bytes and nothing else. */
export function contentArchiveFiles(content: BotPackageContent): BotArchiveFile[] {
  return [
    {
      path: BOT_PACKAGE_MANIFEST_PATH,
      bytes: Buffer.from(`${JSON.stringify(content.bot, null, 2)}\n`, "utf8"),
    },
    ...content.files.map((file) => ({ path: file.path, bytes: Buffer.from(file.text, "utf8") })),
    ...(content.avatarBase64
      ? [{ path: BOT_PACKAGE_AVATAR_PATH, bytes: Buffer.from(content.avatarBase64, "base64") }]
      : []),
  ];
}

/** Whether bytes start like a PNG (the archive reader's avatar check). */
export function isPng(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 8)).equals(PNG_SIGNATURE);
}
