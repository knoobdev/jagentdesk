import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, symlink } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createInflateRaw, inflateRawSync } from "node:zlib";

/**
 * Minimal ZIP reader for IPAs and `.apks` bundles: random access through the central
 * directory (Zip64 included), stored/deflate entries, Unix modes and symlinks kept on
 * extraction. Reads only what is asked, so inspecting a 2 GB IPA stays cheap.
 */

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number;
  /** Unix mode bits when the archive was made on Unix, else null. */
  mode: number | null;
  isDirectory: boolean;
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;

async function readAt(file: string, position: number, length: number): Promise<Buffer> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function fileSize(file: string): Promise<number> {
  const handle = await open(file, "r");
  try {
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

function readZip64Extra(
  extra: Buffer,
  entry: { size: number; compressedSize: number; localHeaderOffset: number },
): void {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    if (id === 0x0001) {
      let cursor = offset + 4;
      if (entry.size === 0xffffffff) {
        entry.size = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.compressedSize === 0xffffffff) {
        entry.compressedSize = Number(extra.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (entry.localHeaderOffset === 0xffffffff) {
        entry.localHeaderOffset = Number(extra.readBigUInt64LE(cursor));
      }
      return;
    }
    offset += 4 + length;
  }
}

export async function listZip(file: string): Promise<ZipEntry[]> {
  const size = await fileSize(file);
  const tailLength = Math.min(size, 65_557);
  const tail = await readAt(file, size - tailLength, tailLength);
  let eocd = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) throw new ZipError("Not a ZIP archive (no end of central directory)");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
    const zip64Offset = Number(tail.readBigUInt64LE(eocd - 20 + 8));
    const record = await readAt(file, zip64Offset, 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD) throw new ZipError("Corrupt Zip64 record");
    count = Number(record.readBigUInt64LE(32));
    cdSize = Number(record.readBigUInt64LE(40));
    cdOffset = Number(record.readBigUInt64LE(48));
  }
  const directory = await readAt(file, cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    if (directory.readUInt32LE(offset) !== CENTRAL) throw new ZipError("Corrupt central directory");
    const madeBy = directory.readUInt16LE(offset + 4);
    const method = directory.readUInt16LE(offset + 10);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressed = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const external = directory.readUInt32LE(offset + 38);
    const localHeaderOffset = directory.readUInt32LE(offset + 42);
    const name = directory.toString("utf8", offset + 46, offset + 46 + nameLength);
    const extra = directory.subarray(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    const entry = { size: uncompressed, compressedSize, localHeaderOffset };
    readZip64Extra(extra, entry);
    const unixMode = madeBy >> 8 === 3 ? external >>> 16 : null;
    entries.push({
      name,
      method,
      compressedSize: entry.compressedSize,
      size: entry.size,
      localHeaderOffset: entry.localHeaderOffset,
      mode: unixMode && unixMode !== 0 ? unixMode : null,
      isDirectory: name.endsWith("/"),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function dataOffset(file: string, entry: ZipEntry): Promise<number> {
  const header = await readAt(file, entry.localHeaderOffset, 30);
  if (header.readUInt32LE(0) !== LOCAL)
    throw new ZipError(`Corrupt local header for ${entry.name}`);
  return entry.localHeaderOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
}

function assertSupported(entry: ZipEntry): void {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError(`${entry.name} uses unsupported compression method ${entry.method}`);
  }
}

/** Whole entry in memory — for small files (plists, profiles). */
export async function readZipEntry(file: string, entry: ZipEntry): Promise<Buffer> {
  assertSupported(entry);
  const start = await dataOffset(file, entry);
  const raw = await readAt(file, start, entry.compressedSize);
  return entry.method === 0 ? raw : inflateRawSync(raw);
}

/** The first `length` bytes of an entry without inflating the rest (Mach-O headers). */
export async function readZipEntryPrefix(
  file: string,
  entry: ZipEntry,
  length: number,
): Promise<Buffer> {
  assertSupported(entry);
  const start = await dataOffset(file, entry);
  if (entry.method === 0) return readAt(file, start, Math.min(length, entry.size));
  if (entry.compressedSize === 0) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let collected = 0;
  const source = createReadStream(file, { start, end: start + entry.compressedSize - 1 });
  const inflate = createInflateRaw();
  await new Promise<void>((resolve, reject) => {
    inflate.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      collected += chunk.length;
      if (collected >= length) {
        source.destroy();
        inflate.destroy();
        resolve();
      }
    });
    inflate.on("end", resolve);
    inflate.on("error", reject);
    source.on("error", reject);
    source.pipe(inflate);
  });
  return Buffer.concat(chunks).subarray(0, length);
}

function safeTarget(root: string, name: string): string {
  const target = path.resolve(root, name);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new ZipError(`Entry escapes the extraction directory: ${name}`);
  }
  return target;
}

/** Extracts every entry (or those `filter` keeps) under `destination`. */
export async function extractZip(
  file: string,
  destination: string,
  filter?: (entry: ZipEntry) => boolean,
): Promise<void> {
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  for (const entry of await listZip(file)) {
    if (filter && !filter(entry)) continue;
    const target = safeTarget(root, entry.name);
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    assertSupported(entry);
    await mkdir(path.dirname(target), { recursive: true });
    if (entry.mode !== null && (entry.mode & S_IFMT) === S_IFLNK) {
      const link = (await readZipEntry(file, entry)).toString("utf8");
      safeTarget(root, path.join(path.dirname(entry.name), link));
      await symlink(link, target);
      continue;
    }
    const start = await dataOffset(file, entry);
    if (entry.compressedSize === 0) {
      await pipeline(async function* () {}, createWriteStream(target));
    } else {
      const source = createReadStream(file, { start, end: start + entry.compressedSize - 1 });
      if (entry.method === 0) await pipeline(source, createWriteStream(target));
      else await pipeline(source, createInflateRaw(), createWriteStream(target));
    }
    if (entry.mode !== null) await chmod(target, entry.mode & 0o777);
  }
}
