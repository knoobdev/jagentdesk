// A shared bot's archive: a transport manifest naming and hashing every file, then the files, as a
// ustar stream in a stored-block gzip. Ported from Orca dfdb4fda (MIT, see vendor/orca-bots/LICENSE):
// src/main/bots/sharing/bot-package-archive.ts, bot-package-transport.ts,
// src/main/archive/ustar-entry-header.ts, src/main/skills/package-archive/skill-package-tar.ts,
// skill-package-deterministic-gzip.ts and skill-package-identity.ts. JAgentDesk seals the archive
// before it leaves the daemon (seal.ts) and bundles are at most 32 MiB, so it is written and read in
// memory rather than through temporary files; every hash, order and part rule is Orca's.
import { createHash } from "node:crypto";
import { crc32, gunzipSync } from "node:zlib";
import { z } from "zod";
import {
  BOT_PACKAGE_MANIFEST_PATH,
  BOT_PACKAGE_MAX_AVATAR_BYTES,
  BOT_PACKAGE_MAX_FILE_BYTES,
  BOT_PACKAGE_MAX_FILES,
  BOT_PACKAGE_MAX_MANIFEST_BYTES,
  BOT_PACKAGE_MAX_TOTAL_BYTES,
  BOT_TRANSPORT_MANIFEST_PATH,
  BOT_DISPLAY_NAME_MAX,
  BOT_PACKAGE_PURPOSE_MAX,
  botPackagePartOf,
  botPackageRole,
  compareCodeUnits,
  parseBotPackage,
  validPackagePath,
  type BotPackageV1,
} from "./package.js";
import { hasUnsafeText, withoutUnsafeText } from "./text-scan.js";

const USTAR_BLOCK_BYTES = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/** The expanded tar may hold the manifest and padding on top of the 32 MiB of files. */
const TAR_EXPANDED_LIMIT = 40 * 1024 * 1024;

const BotTransportFileSchema = z
  .object({
    path: z.string().min(1).max(1024),
    size: z.number().int().nonnegative().max(BOT_PACKAGE_MAX_FILE_BYTES),
    executable: z.boolean(),
    classification: z.enum(["text", "binary"]),
    sha256: z.string().regex(SHA256_PATTERN),
    identitySha256: z.string().regex(SHA256_PATTERN),
    role: z.string().regex(/^(?:manifest|soul|avatar|memory|skill:[a-z0-9-]{1,64})$/),
  })
  .strict();

/** Text as one line: unsafe characters become spaces, whitespace collapses, cut to `maximum`. */
export function landingLine(text: string, maximum: number): string {
  return withoutUnsafeText(text).replace(/\s+/g, " ").trim().slice(0, maximum).trim();
}
function isLandingText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length <= maximum && !hasUnsafeText(value);
}

const BotTransportManifestV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("bot"),
    versionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    displayName: z
      .string()
      .min(1)
      .refine((value) => isLandingText(value, BOT_DISPLAY_NAME_MAX)),
    description: z.string().refine((value) => isLandingText(value, BOT_PACKAGE_PURPOSE_MAX)),
    createdAt: z.iso.datetime({ offset: true }),
    files: z.array(BotTransportFileSchema).min(2).max(BOT_PACKAGE_MAX_FILES),
    botDigest: z.string().regex(SHA256_PATTERN),
  })
  .strict();
export type BotTransportManifest = z.infer<typeof BotTransportManifestV1Schema>;
export type BotTransportFile = z.infer<typeof BotTransportFileSchema>;

/** The digest over every file's path, role, kind and content identity, in order. */
export function botPackageDigest(files: readonly BotTransportFile[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          role: file.role,
          executable: file.executable,
          classification: file.classification,
          identitySha256: file.identitySha256,
        })),
      ),
    )
    .digest("hex");
}

/** Every rule the inventory must meet, on either side of the link. */
export function parseBotTransportManifest(value: unknown): BotTransportManifest {
  const parsed = BotTransportManifestV1Schema.safeParse(value);
  if (!parsed.success) throw new Error("bot-package-transport-invalid");
  const manifest = parsed.data;
  const folded = new Set<string>();
  let previous: string | null = null;
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (!validPackagePath(file.path)) throw new Error("bot-package-path-invalid");
    if (previous !== null && compareCodeUnits(file.path, previous) <= 0)
      throw new Error("bot-package-transport-order");
    previous = file.path;
    const key = file.path.toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new Error("bot-package-case-collision");
    folded.add(key);
    const part = botPackagePartOf(file.path);
    if (!part) throw new Error("bot-package-path-not-allowed");
    if (botPackageRole(part) !== file.role) throw new Error("bot-package-role-mismatch");
    // Nothing is runnable, and every part is text but the avatar.
    if (file.executable || (file.classification === "binary") !== (part.role === "avatar"))
      throw new Error("bot-package-part-kind");
    if (
      (part.role === "manifest" && file.size > BOT_PACKAGE_MAX_MANIFEST_BYTES) ||
      (part.role === "avatar" && file.size > BOT_PACKAGE_MAX_AVATAR_BYTES)
    )
      throw new Error("bot-package-part-size");
    totalBytes += file.size;
  }
  if (totalBytes > BOT_PACKAGE_MAX_TOTAL_BYTES) throw new Error("bot-package-size-limit");
  for (const role of ["manifest", "soul"])
    if (!manifest.files.some((file) => file.role === role))
      throw new Error(`bot-package-${role}-required`);
  if (botPackageDigest(manifest.files) !== manifest.botDigest)
    throw new Error("bot-package-digest-mismatch");
  return manifest;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Orca's file identity: text is hashed with LF line ends, binary as is. */
function describeFile(path: string, bytes: Buffer) {
  let normalized: Buffer | null = null;
  if (!bytes.includes(0)) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      normalized = Buffer.from(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"), "utf8");
    } catch {
      normalized = null;
    }
  }
  const exact = sha256(bytes);
  const textSha = normalized && (normalized.equals(bytes) ? exact : sha256(normalized));
  return {
    path,
    size: bytes.length,
    executable: false,
    classification: normalized ? ("text" as const) : ("binary" as const),
    sha256: exact,
    identitySha256: textSha ?? exact,
  };
}

// ---- ustar (src/main/archive/ustar-entry-header.ts) ----

function writeField(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error("bot-package-tar-path-limit");
  bytes.copy(header, offset);
}
function writeOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length > length - 1) throw new Error("bot-package-tar-number-limit");
  writeField(header, offset, length, `${encoded}\0`);
}
function splitTarPath(path: string): { name: string; prefix: string } {
  if (Buffer.byteLength(path, "utf8") <= 100) return { name: path, prefix: "" };
  for (let index = path.lastIndexOf("/"); index > 0; index = path.lastIndexOf("/", index - 1)) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (Buffer.byteLength(prefix, "utf8") <= 155 && Buffer.byteLength(name, "utf8") <= 100)
      return { name, prefix };
  }
  throw new Error("bot-package-tar-path-limit");
}
/** Fixed ownership and mtime make archives reproducible. */
function ustarHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(USTAR_BLOCK_BYTES);
  const { name, prefix } = splitTarPath(path);
  writeField(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeField(header, 257, 6, "ustar");
  writeField(header, 263, 2, "00");
  writeField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}
const padding = (size: number) =>
  (USTAR_BLOCK_BYTES - (size % USTAR_BLOCK_BYTES)) % USTAR_BLOCK_BYTES;

function readString(header: Buffer, offset: number, length: number): string {
  const end = header.indexOf(0, offset);
  return header
    .subarray(offset, end === -1 || end > offset + length ? offset + length : end)
    .toString("utf8");
}
function readOctal(header: Buffer, offset: number, length: number): number {
  const value = readString(header, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new Error("bot-package-tar-number-invalid");
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new Error("bot-package-tar-number-invalid");
  return parsed;
}
function parseTarHeader(header: Buffer): { path: string; size: number; executable: boolean } {
  if (header.length !== USTAR_BLOCK_BYTES) throw new Error("bot-package-tar-truncated");
  const expected = readOctal(header, 148, 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  if (copy.reduce((sum, byte) => sum + byte, 0) !== expected)
    throw new Error("bot-package-tar-checksum-invalid");
  if (readString(header, 257, 6) !== "ustar" || readString(header, 263, 2) !== "00")
    throw new Error("bot-package-tar-format-invalid");
  if (header[156] !== 0 && header[156] !== "0".charCodeAt(0))
    throw new Error("bot-package-tar-entry-type");
  const name = readString(header, 0, 100);
  const prefix = readString(header, 345, 155);
  const path = prefix ? `${prefix}/${name}` : name;
  if (!path) throw new Error("bot-package-tar-path-invalid");
  const mode = readOctal(header, 100, 8);
  return { path, size: readOctal(header, 124, 12), executable: (mode & 0o111) !== 0 };
}

// ---- stored-block gzip (skill-package-deterministic-gzip.ts) ----

const DEFLATE_STORED_BLOCK_BYTES = 65_535;
const GZIP_HEADER = Buffer.from([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]);
/** zlib's choices vary by version; stored blocks keep archive identity portable. */
function storedGzip(bytes: Buffer): Buffer {
  const parts: Buffer[] = [GZIP_HEADER];
  for (
    let offset = 0;
    offset < bytes.length || offset === 0;
    offset += DEFLATE_STORED_BLOCK_BYTES
  ) {
    const block = bytes.subarray(offset, offset + DEFLATE_STORED_BLOCK_BYTES);
    const final = offset + DEFLATE_STORED_BLOCK_BYTES >= bytes.length;
    const head = Buffer.alloc(5);
    head[0] = final ? 1 : 0;
    head.writeUInt16LE(block.length, 1);
    head.writeUInt16LE(~block.length & 0xffff, 3);
    parts.push(head, block);
    if (final) break;
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(bytes) >>> 0, 0);
  trailer.writeUInt32LE(bytes.length >>> 0, 4);
  parts.push(trailer);
  return Buffer.concat(parts);
}

// ---- the bot archive ----

/** A file of a package folder, by its package path. */
export interface BotArchiveFile {
  path: string;
  bytes: Buffer;
}

export interface WrittenBotPackage {
  transport: BotTransportManifest;
  archive: Buffer;
  archiveSha256: string;
}

/** Packs bot.json, SOUL.md, skills/, memory/ and avatar.png, then reads it back as a recipient does. */
export function writeBotPackageArchive(input: {
  files: readonly BotArchiveFile[];
  versionId: string;
  displayName: string;
  description: string;
  createdAt?: string;
}): WrittenBotPackage {
  if (input.files.length + 1 > BOT_PACKAGE_MAX_FILES) throw new Error("bot-package-size-limit");
  const sorted = [...input.files].sort((left, right) => compareCodeUnits(left.path, right.path));
  const files = sorted.map((file) => {
    const part = botPackagePartOf(file.path);
    if (!part) throw new Error("bot-package-path-not-allowed");
    if (file.bytes.length > BOT_PACKAGE_MAX_FILE_BYTES) throw new Error("bot-package-size-limit");
    return { ...describeFile(file.path, file.bytes), role: botPackageRole(part) };
  });
  const transport = parseBotTransportManifest({
    schemaVersion: 1,
    kind: "bot",
    versionId: input.versionId,
    displayName: input.displayName,
    description: input.description,
    createdAt: input.createdAt ?? new Date().toISOString(),
    files,
    botDigest: botPackageDigest(files),
  });
  const manifest = Buffer.from(JSON.stringify(transport), "utf8");
  const blocks: Buffer[] = [];
  const entry = (path: string, bytes: Buffer) => {
    blocks.push(ustarHeader(path, bytes.length), bytes, Buffer.alloc(padding(bytes.length)));
  };
  entry(BOT_TRANSPORT_MANIFEST_PATH, manifest);
  for (const file of sorted) entry(file.path, file.bytes);
  blocks.push(Buffer.alloc(USTAR_BLOCK_BYTES * 2));
  const archive = storedGzip(Buffer.concat(blocks));
  const written = { transport, archive, archiveSha256: sha256(archive) };
  readBotPackageArchive(archive, { botDigest: transport.botDigest });
  return written;
}

export interface ReadBotPackage {
  transport: BotTransportManifest;
  bot: BotPackageV1;
  droppedKeys: string[];
  /** Every file but the transport manifest, by path, its hash checked. */
  files: Map<string, Buffer>;
  archiveSha256: string;
}

/** bot.json must declare exactly the parts the inventory carries. */
function requireDeclaredParts(bot: BotPackageV1, files: readonly BotTransportFile[]): void {
  const carried = new Set(files.map((file) => file.role));
  const declared = new Set([
    "manifest",
    "soul",
    ...bot.skills.map((skill) => `skill:${skill.name}`),
    ...bot.memory.map(() => "memory"),
    ...(bot.avatar && "image" in bot.avatar ? ["avatar"] : []),
  ]);
  const memoryFiles = files.filter((file) => file.role === "memory").map((file) => file.path);
  const declaredMemory = bot.memory.map((note) => `memory/${note.topic}.md`);
  if (
    carried.size !== declared.size ||
    [...carried].some((role) => !declared.has(role)) ||
    memoryFiles.length !== declaredMemory.length ||
    declaredMemory.some((path) => !memoryFiles.includes(path)) ||
    bot.skills.some((skill) => !files.some((file) => file.path === `skills/${skill.name}/SKILL.md`))
  )
    throw new Error("bot-package-undeclared-part");
}

/** The `name` of a SKILL.md from its opening frontmatter only (Orca's rule). */
export function skillFrontmatterName(text: string): string | undefined {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trimEnd() !== "---") return undefined;
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return undefined;
  const names = lines
    .slice(1, end)
    .map((line) => /^name\s*:(.*)$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
  if (names.length !== 1) return undefined;
  const raw = names[0].trim();
  const quoted = /^(['"])(.*)\1\s*(?:#.*)?$/.exec(raw);
  const value = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "").trim();
  return value || undefined;
}

/** A cursor over the expanded tar: entries in order, each envelope checked against the inventory. */
class TarCursor {
  private offset = 0;
  constructor(readonly tar: Buffer) {}
  take(length: number): Buffer {
    if (this.offset + length > this.tar.length) throw new Error("bot-package-tar-truncated");
    const bytes = this.tar.subarray(this.offset, this.offset + length);
    this.offset += length;
    return bytes;
  }
  peekHeader(): { path: string; size: number; executable: boolean } {
    return parseTarHeader(
      Buffer.from(this.tar.subarray(this.offset, this.offset + USTAR_BLOCK_BYTES)),
    );
  }
  entry(path: string, size: number): Buffer {
    const header = parseTarHeader(this.take(USTAR_BLOCK_BYTES));
    if (header.path !== path || header.size !== size || header.executable)
      throw new Error("bot-package-file-envelope-mismatch");
    const bytes = Buffer.from(this.take(size));
    this.take(padding(size));
    return bytes;
  }
  /** The two zero end blocks, and nothing but zeros after them. */
  end(): void {
    const end = this.take(USTAR_BLOCK_BYTES * 2);
    if (
      !end.every((byte) => byte === 0) ||
      this.tar.subarray(this.offset).some((byte) => byte !== 0)
    )
      throw new Error("bot-package-tar-trailing-data");
  }
}

function expandArchive(archive: Buffer): Buffer {
  try {
    return gunzipSync(archive, { maxOutputLength: TAR_EXPANDED_LIMIT });
  } catch (error) {
    throw new Error("bot-package-archive-invalid", { cause: error });
  }
}

function readTransport(cursor: TarCursor): BotTransportManifest {
  const first = cursor.peekHeader();
  if (first.path !== BOT_TRANSPORT_MANIFEST_PATH || first.size > BOT_PACKAGE_MAX_MANIFEST_BYTES)
    throw new Error("bot-package-transport-invalid");
  const bytes = cursor.entry(first.path, first.size);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error("bot-package-transport-invalid", { cause: error });
  }
  return parseBotTransportManifest(value);
}

/** Each skill's SKILL.md names its folder. */
function requireSkillNames(transport: BotTransportManifest, files: Map<string, Buffer>): void {
  for (const file of transport.files) {
    const part = botPackagePartOf(file.path);
    if (part?.role !== "skill" || part.path !== "SKILL.md") continue;
    if (skillFrontmatterName(files.get(file.path)?.toString("utf8") ?? "") !== part.name)
      throw new Error("bot-package-skill-name-mismatch");
  }
}

function parseManifestFile(files: Map<string, Buffer>): ReturnType<typeof parseBotPackage> {
  let value: unknown;
  try {
    value = JSON.parse(files.get(BOT_PACKAGE_MANIFEST_PATH)?.toString("utf8") ?? "");
  } catch (error) {
    throw new Error("bot-package-invalid", { cause: error });
  }
  return parseBotPackage(value);
}

/** Unpacks an archive: each declared file, its hash checked, nothing else. */
export function readBotPackageArchive(
  archive: Buffer,
  expected: { botDigest?: string } = {},
): ReadBotPackage {
  const cursor = new TarCursor(expandArchive(archive));
  const transport = readTransport(cursor);
  if (expected.botDigest && expected.botDigest !== transport.botDigest)
    throw new Error("bot-package-identity-mismatch");
  const files = new Map<string, Buffer>();
  for (const file of transport.files) {
    const bytes = cursor.entry(file.path, file.size);
    const observed = describeFile(file.path, bytes);
    if (
      observed.sha256 !== file.sha256 ||
      observed.identitySha256 !== file.identitySha256 ||
      observed.classification !== file.classification
    )
      throw new Error("bot-package-identity-mismatch");
    files.set(file.path, bytes);
  }
  cursor.end();
  requireSkillNames(transport, files);
  const { bot, droppedKeys } = parseManifestFile(files);
  if (bot.name !== transport.displayName) throw new Error("bot-package-identity-mismatch");
  requireDeclaredParts(bot, transport.files);
  files.delete(BOT_PACKAGE_MANIFEST_PATH);
  return { transport, bot, droppedKeys, files, archiveSha256: sha256(archive) };
}
