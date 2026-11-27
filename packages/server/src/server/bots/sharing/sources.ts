// What a bot could share, read from its record and home: the parts a Share dialog offers, and the
// ones that never go out. Ported from Orca dfdb4fda src/main/bots/sharing/bot-share-sources.ts,
// bot-share-own-path.ts, bot-share-skills.ts and bot-package-content-files.ts (MIT, see
// vendor/orca-bots/LICENSE) onto JAgentDesk's bot home: SOUL.md, memory/<topic>.md, skills/<name>/
// and avatar.png. Connectors, tokens, allow-lists, MEMORY.md, its history and the journal never go.
import { lstat, open, readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { Bot } from "@jagentdesk/protocol/bots/types";
import type { BotShareLeftOut } from "@jagentdesk/protocol/bots/share-schemas";
import {
  BOT_PACKAGE_AVATAR_PATH,
  BOT_PACKAGE_MAX_FILE_BYTES,
  BOT_PACKAGE_MAX_FILES,
  BOT_PACKAGE_MAX_TOTAL_BYTES,
  BOT_PACKAGE_PURPOSE_MAX,
  BOT_PACKAGE_SKILLS_MAX,
  BOT_PACKAGE_SOUL_PATH,
  compareCodeUnits,
  validPartName,
  validPackagePath,
  type BotPackageConnector,
  type BotPackageV1,
} from "./package.js";
import { landingLine } from "./archive.js";
import { stripPngMetadata } from "./png-strip.js";
import type { BotPackageRawFile } from "./content.js";

export interface BotShareSkill {
  name: string;
  description: string;
  directory: string;
}

/** Everything the bot could share, before the owner picks. */
export interface BotShareable {
  soul: string;
  purpose: string;
  avatar: BotPackageV1["avatar"];
  avatarImage: Buffer | null;
  skills: BotShareSkill[];
  schedules: (BotPackageV1["schedules"][number] & { scheduleId: string })[];
  memory: { topic: string; path: string }[];
  leftOut: BotShareLeftOut[];
  connectors: BotPackageConnector[];
}

interface Home {
  path: string;
  real: string;
}

/** The bot's own file or folder at this path, `linked` when any part of it is a link, null when missing. */
async function ownPath(
  home: Home,
  ...segments: string[]
): Promise<{ own: string } | "linked" | null> {
  const path = join(home.path, ...segments);
  const real = await realpath(path).catch(() => null);
  if (real !== null && real === join(home.real, ...segments)) return { own: real };
  return real !== null || (await lstat(path).catch(() => null)) ? "linked" : null;
}

class SkillRefused extends Error {
  constructor(readonly why: "link" | "size" | "unreadable") {
    super(`bot-share-skill-${why}`);
  }
}

// Plain OS metadata never counts as part of a skill.
const OS_METADATA = new Set([".ds_store", "thumbs.db", "ehthumbs.db", "desktop.ini"]);
const isOsMetadata = (name: string) => {
  const folded = name.toLowerCase();
  return OS_METADATA.has(folded) || folded.startsWith("._");
};

/** A skill folder's own files: no links or hard links, within Orca's skill limits; a nested folder
 *  with its own SKILL.md is another skill and stays out unread. */
async function ownSkillFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  let total = 0;
  let entries = 0;
  async function walk(relative: string[], depth: number): Promise<void> {
    if (depth > 16) throw new SkillRefused("size");
    const folder = join(directory, ...relative);
    let listing;
    try {
      listing = await readdir(folder, { withFileTypes: true });
    } catch {
      throw new SkillRefused("unreadable");
    }
    for (const entry of listing.sort((a, b) => compareCodeUnits(a.name, b.name))) {
      if (++entries > 2048) throw new SkillRefused("size");
      if (isOsMetadata(entry.name)) continue;
      const path = [...relative, entry.name];
      const absolute = join(directory, ...path);
      const stat = await lstat(absolute).catch(() => null);
      if (!stat) throw new SkillRefused("unreadable");
      if (stat.isSymbolicLink()) throw new SkillRefused("link");
      if (stat.isDirectory()) {
        const nested = await lstat(join(absolute, "SKILL.md")).catch(() => null);
        if (nested?.isFile()) continue;
        await walk(path, depth + 1);
        continue;
      }
      if (!stat.isFile()) throw new SkillRefused("unreadable");
      if (stat.nlink !== 1) throw new SkillRefused("link");
      if (stat.size > BOT_PACKAGE_MAX_FILE_BYTES) throw new SkillRefused("size");
      total += stat.size;
      if (total > BOT_PACKAGE_MAX_TOTAL_BYTES || files.length >= BOT_PACKAGE_MAX_FILES)
        throw new SkillRefused("size");
      const relativePath = path.join("/");
      if (!validPackagePath(relativePath)) throw new SkillRefused("unreadable");
      files.push(relativePath);
    }
  }
  await walk([], 1);
  return files;
}

/** A SKILL.md's frontmatter name and description; null without a readable mapping. */
function skillHeader(text: string): { name: string; description: string } | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trimEnd() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return null;
  try {
    const document = parseDocument(lines.slice(1, end).join("\n"), { uniqueKeys: true });
    if (document.errors.length > 0) return null;
    const parsed = z
      .object({ name: z.string(), description: z.string().optional() })
      .safeParse(document.toJS({ maxAliasCount: 0 }));
    return parsed.success
      ? { name: parsed.data.name, description: parsed.data.description ?? "" }
      : null;
  } catch {
    return null;
  }
}

async function readSkills(home: Home, leftOut: BotShareLeftOut[]): Promise<BotShareSkill[]> {
  const root = await ownPath(home, "skills");
  if (root === "linked") leftOut.push({ kind: "skill", name: "skills", why: "linked" });
  if (root === null || root === "linked") return [];
  const entries = await readdir(root.own, { withFileTypes: true });
  const skills: BotShareSkill[] = [];
  for (const entry of entries.sort((a, b) => compareCodeUnits(a.name, b.name))) {
    if (isOsMetadata(entry.name)) continue;
    const folder = await ownPath(home, "skills", entry.name);
    if (folder === "linked") {
      leftOut.push({ kind: "skill", name: entry.name, why: "linked" });
      continue;
    }
    if (folder === null || !entry.isDirectory()) continue;
    const skillMd = await readFile(join(folder.own, "SKILL.md"), "utf8").catch(() => null);
    if (skillMd === null) continue;
    const header = skillHeader(skillMd);
    if (!header || header.name !== entry.name || !validPartName(entry.name)) {
      leftOut.push({ kind: "skill", name: entry.name, why: "name" });
      continue;
    }
    if (skills.length >= BOT_PACKAGE_SKILLS_MAX) {
      leftOut.push({ kind: "skill", name: entry.name, why: "limit" });
      continue;
    }
    try {
      await ownSkillFiles(folder.own);
      skills.push({ name: entry.name, description: header.description, directory: folder.own });
    } catch (error) {
      leftOut.push({
        kind: "skill",
        name: entry.name,
        why: error instanceof SkillRefused ? error.why : "unreadable",
      });
    }
  }
  return skills;
}

async function readMemory(home: Home, leftOut: BotShareLeftOut[]): Promise<BotShareable["memory"]> {
  const folder = await ownPath(home, "memory");
  if (folder === "linked") leftOut.push({ kind: "memory", name: "memory", why: "linked" });
  if (folder === null || folder === "linked") return [];
  const entries = await readdir(folder.own, { withFileTypes: true });
  const notes: BotShareable["memory"] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
    const topic = entry.name.slice(0, -".md".length);
    const path = await ownPath(home, "memory", entry.name);
    // Notes an import brought in are the old app's, never the sharer's to pass on.
    let why: string | null = null;
    if (path === "linked") why = "linked";
    else if (topic.startsWith("imported-")) why = "imported";
    else if (!validPartName(topic)) why = "name";
    else if (path === null) why = "missing";
    else {
      const stat = await lstat(path.own);
      if (stat.nlink !== 1) why = "linked";
      else if (stat.size > BOT_PACKAGE_MAX_FILE_BYTES) why = "size";
    }
    if (why || path === null || path === "linked") {
      leftOut.push({ kind: "memory", name: topic, why: why ?? "missing" });
      continue;
    }
    notes.push({ topic, path: path.own });
  }
  return notes.sort((left, right) => left.topic.localeCompare(right.topic, "en-US"));
}

const MascotAvatar = z.object({ avatar: z.string().regex(/^mascot:[A-Za-z0-9_-]{1,32}$/) });

/** A mascot record goes by id; an uploaded `avatar.png` goes stripped of metadata. */
async function readAvatar(
  bot: Bot,
  home: Home,
  leftOut: BotShareLeftOut[],
): Promise<Pick<BotShareable, "avatar" | "avatarImage">> {
  const mascot = MascotAvatar.safeParse(bot);
  if (mascot.success)
    return { avatar: { mascot: mascot.data.avatar.slice("mascot:".length) }, avatarImage: null };
  const path = await ownPath(home, BOT_PACKAGE_AVATAR_PATH);
  if (path === null) return { avatar: undefined, avatarImage: null };
  const png = path === "linked" ? null : await readFile(path.own).catch(() => null);
  const stripped = png ? stripPngMetadata(png) : null;
  if (stripped) return { avatar: { image: BOT_PACKAGE_AVATAR_PATH }, avatarImage: stripped };
  leftOut.push({
    kind: "avatar",
    name: BOT_PACKAGE_AVATAR_PATH,
    why: path === "linked" ? "linked" : "invalid",
  });
  return { avatar: undefined, avatarImage: null };
}

/** SOUL.md's description: its first paragraph that isn't a heading. */
function soulDescription(soul: string): string {
  const paragraph = soul
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith("#"));
  return paragraph ?? "";
}

export async function readBotShareable(input: {
  bot: Bot;
  home: string;
  connectors: readonly BotPackageConnector[];
}): Promise<BotShareable> {
  const leftOut: BotShareLeftOut[] = [];
  const home: Home = { path: input.home, real: await realpath(input.home) };
  const soulPath = await ownPath(home, BOT_PACKAGE_SOUL_PATH);
  if (soulPath === null || soulPath === "linked")
    throw new Error("SOUL.md is missing or is a link; JAgentDesk shares only the bot's own files.");
  const soul = await readFile(soulPath.own, "utf8");
  const [skills, memory, avatar] = await Promise.all([
    readSkills(home, leftOut),
    readMemory(home, leftOut),
    readAvatar(input.bot, home, leftOut),
  ]);
  return {
    soul,
    purpose: landingLine(soulDescription(soul), BOT_PACKAGE_PURPOSE_MAX),
    ...avatar,
    skills,
    schedules: input.bot.schedules.map((schedule, index) => ({
      scheduleId: schedule.id,
      id: `s${index + 1}`,
      name: schedule.name,
      prompt: schedule.prompt,
      cron: schedule.cron,
      ...(schedule.timezone ? { timezone: schedule.timezone } : {}),
    })),
    memory,
    leftOut,
    connectors: [...input.connectors].sort(),
  };
}

/** The picked parts of a bot's home, as they are now. A picked skill whose files can't all be read is
 *  refused whole, with why, so it never stops the rest from going out. */
export async function sharerRawFiles(
  shareable: BotShareable,
  bot: BotPackageV1,
): Promise<{ files: BotPackageRawFile[]; refused: BotShareLeftOut[] }> {
  const files: BotPackageRawFile[] = [
    { path: BOT_PACKAGE_SOUL_PATH, bytes: Buffer.from(shareable.soul, "utf8") },
  ];
  if (shareable.avatarImage && bot.avatar && "image" in bot.avatar)
    files.push({ path: BOT_PACKAGE_AVATAR_PATH, bytes: shareable.avatarImage });
  const refused: BotShareLeftOut[] = [];
  for (const { name } of bot.skills) {
    const skill = shareable.skills.find((entry) => entry.name === name);
    if (!skill) continue;
    try {
      const skillFiles: BotPackageRawFile[] = [];
      for (const path of await ownSkillFiles(skill.directory))
        skillFiles.push({
          path: `skills/${name}/${path}`,
          bytes: await readBoundedFile(join(skill.directory, ...path.split("/"))),
        });
      files.push(...skillFiles);
    } catch (error) {
      refused.push({
        kind: "skill",
        name,
        why: error instanceof SkillRefused ? error.why : "unreadable",
      });
    }
  }
  for (const { topic } of bot.memory) {
    const note = shareable.memory.find((entry) => entry.topic === topic);
    if (note) files.push({ path: `memory/${topic}.md`, bytes: await readBoundedFile(note.path) });
  }
  return { files, refused };
}

/** A file read once, refused when it grows past the per-file limit or changes while read. */
async function readBoundedFile(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (before.size > BOT_PACKAGE_MAX_FILE_BYTES) throw new SkillRefused("size");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw new SkillRefused("unreadable");
      offset += result.bytesRead;
    }
    if ((await handle.stat()).size !== before.size) throw new SkillRefused("unreadable");
    return bytes;
  } finally {
    await handle.close();
  }
}
