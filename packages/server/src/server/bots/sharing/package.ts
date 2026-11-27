// A shared bot, as its link carries it: the bot.json schema and the parts its archive may hold.
// Ported from Orca dfdb4fda src/shared/bots/bot-package.ts:58-184 (MIT, see vendor/orca-bots/LICENSE)
// for JAgentDesk's bot: automations are cron schedules, connectors are JAgentDesk's, and there are no
// tools or event suggestions (spec 37.2.2). No filesystem work here.
import { z } from "zod";

export const BOT_PACKAGE_SCHEMA_VERSION = 1;
export const BOT_PACKAGE_MANIFEST_PATH = "dev.jagentdesk.bot-sharing/bot.json";
export const BOT_TRANSPORT_MANIFEST_PATH = "dev.jagentdesk.bot-sharing/manifest.json";
export const BOT_PACKAGE_SOUL_PATH = "SOUL.md";
export const BOT_PACKAGE_AVATAR_PATH = "avatar.png";
export const BOT_PACKAGE_MAX_MANIFEST_BYTES = 256 * 1024;
export const BOT_PACKAGE_MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const BOT_PACKAGE_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const BOT_PACKAGE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const BOT_PACKAGE_MAX_FILES = 512;
export const BOT_PACKAGE_PURPOSE_MAX = 200;
export const BOT_PACKAGE_SKILLS_MAX = 64;
export const BOT_PACKAGE_SETUP_NOTE_MAX = 2000;
export const BOT_DISPLAY_NAME_MAX = 80;
export const BOT_PACKAGE_CONNECTORS = ["github", "gitlab", "jira", "slack", "telegram"] as const;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/** Skill and memory names become folder and file names: Orca's skill package name rule. */
export function validPartName(name: string): boolean {
  return name.length <= 64 && SKILL_NAME_PATTERN.test(name) && !WINDOWS_RESERVED_SEGMENT.test(name);
}

/** Orca's skill package path rule: relative, NFC, no `.`/`..`, no characters Windows refuses. */
export function validPackagePath(path: string): boolean {
  if (path !== path.normalize("NFC") || Buffer.byteLength(path, "utf8") > 1024) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  if (segments.length > 16 || segments.some((s) => s === "" || s === "." || s === ".."))
    return false;
  return segments.every(
    (segment) =>
      Buffer.byteLength(segment, "utf8") <= 255 &&
      ![...segment].some((character) => character.charCodeAt(0) <= 0x1f) &&
      !':*?"<>|'.split("").some((character) => segment.includes(character)) &&
      !/[ .]$/.test(segment) &&
      !WINDOWS_RESERVED_SEGMENT.test(segment),
  );
}

const PartName = z.string().refine(validPartName, "Use lowercase letters, digits and dashes");
const PartId = z.string().regex(/^[a-z0-9-]{1,32}$/);
const Prompt = z.string().min(1).max(20_000);

export const BotPackageV1Schema = z.object({
  schemaVersion: z.literal(BOT_PACKAGE_SCHEMA_VERSION),
  name: z.string().trim().min(1).max(64),
  /** A mascot by id, or the archive's avatar.png; absent, the recipient's default. */
  avatar: z
    .union([
      z.object({ mascot: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/) }).strict(),
      z.object({ image: z.literal(BOT_PACKAGE_AVATAR_PATH) }).strict(),
    ])
    .optional(),
  purpose: z.string().max(BOT_PACKAGE_PURPOSE_MAX),
  /** The sharer's provider; the recipient picks their own. */
  agentHint: z.string().min(1).max(64),
  skills: z.array(z.object({ name: PartName })).max(BOT_PACKAGE_SKILLS_MAX),
  connectors: z.array(z.object({ kind: z.enum(BOT_PACKAGE_CONNECTORS) })).max(8),
  schedules: z
    .array(
      z.object({
        id: PartId,
        name: z.string().min(1).max(100),
        prompt: Prompt,
        cron: z.string().min(1).max(100),
        timezone: z.string().min(1).max(64).optional(),
      }),
    )
    .max(32),
  memory: z.array(z.object({ topic: PartName })).max(256),
  /** Shown to the recipient verbatim, as untrusted text. */
  setupNote: z.string().max(BOT_PACKAGE_SETUP_NOTE_MAX).optional(),
});
export type BotPackageV1 = z.infer<typeof BotPackageV1Schema>;
export type BotPackageConnector = (typeof BOT_PACKAGE_CONNECTORS)[number];

/** Keys of `input` the parse dropped, as dotted paths (`schedules.0.rrule`). */
function droppedKeys(input: unknown, parsed: unknown, path: string[] = []): string[] {
  if (Array.isArray(input) && Array.isArray(parsed))
    return input.flatMap((entry, index) =>
      droppedKeys(entry, parsed[index], [...path, String(index)]),
    );
  if (!input || typeof input !== "object" || !parsed || typeof parsed !== "object") return [];
  const kept = new Map(Object.entries(parsed));
  return Object.entries(input).flatMap(([key, value]) =>
    kept.has(key) ? droppedKeys(value, kept.get(key), [...path, key]) : [[...path, key].join(".")],
  );
}

/** A strict parse that strips unknown keys and lists them; a newer schema is refused. */
export function parseBotPackage(value: unknown): { bot: BotPackageV1; droppedKeys: string[] } {
  const parsedVersion = z.object({ schemaVersion: z.number() }).safeParse(value);
  if (parsedVersion.success && parsedVersion.data.schemaVersion > BOT_PACKAGE_SCHEMA_VERSION)
    throw new Error("bot-package-newer-schema");
  const parsed = BotPackageV1Schema.safeParse(value);
  if (!parsed.success) throw new Error("bot-package-invalid");
  const ids = parsed.data.schedules.map((schedule) => `schedule:${schedule.id}`);
  const names = [
    ...parsed.data.skills.map((skill) => `skill:${skill.name}`),
    ...parsed.data.memory.map((note) => `memory:${note.topic}`),
  ];
  if (new Set([...ids, ...names]).size !== ids.length + names.length)
    throw new Error("bot-package-duplicate-part");
  return { bot: parsed.data, droppedKeys: droppedKeys(value, parsed.data) };
}

/** What one archive path is; null for any path a bot archive may not hold. */
export type BotPackagePart =
  | { role: "manifest" }
  | { role: "soul" }
  | { role: "avatar" }
  | { role: "memory"; topic: string }
  | { role: "skill"; name: string; path: string };

const MEMORY_PATH = /^memory\/([^/]+)\.md$/;
const SKILL_PATH = /^skills\/([^/]+)\/(.+)$/;

export function botPackagePartOf(path: string): BotPackagePart | null {
  if (path === BOT_PACKAGE_MANIFEST_PATH) return { role: "manifest" };
  if (path === BOT_PACKAGE_SOUL_PATH) return { role: "soul" };
  if (path === BOT_PACKAGE_AVATAR_PATH) return { role: "avatar" };
  const memory = MEMORY_PATH.exec(path);
  if (memory && validPartName(memory[1])) return { role: "memory", topic: memory[1] };
  const skill = SKILL_PATH.exec(path);
  if (skill && validPartName(skill[1])) return { role: "skill", name: skill[1], path: skill[2] };
  return null;
}

/** The role string the transport inventory records for a part. */
export function botPackageRole(part: BotPackagePart): string {
  return part.role === "skill" ? `skill:${part.name}` : part.role;
}

export function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
