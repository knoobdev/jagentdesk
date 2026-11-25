/**
 * Just enough Mach-O to inspect an IPA (26.5 "kiểm tra IPA"): which architectures the
 * main executable has, and whether any slice is still FairPlay-encrypted (cryptid != 0).
 */

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC = 0xfeedface;
const MH_MAGIC_64 = 0xfeedfacf;
const LC_ENCRYPTION_INFO = 0x21;
const LC_ENCRYPTION_INFO_64 = 0x2c;

export interface MachoSlice {
  offset: number;
  cputype: number;
  cpusubtype: number;
}

export class MachoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachoError";
  }
}

export function architectureName(cputype: number, cpusubtype: number): string {
  const subtype = cpusubtype & 0x00ffffff;
  switch (cputype) {
    case 0x0100000c:
      return subtype === 2 ? "arm64e" : "arm64";
    case 12:
      if (subtype === 11) return "armv7s";
      return subtype === 9 ? "armv7" : "arm";
    case 0x01000007:
      return "x86_64";
    case 7:
      return "i386";
    default:
      return `cpu${cputype}`;
  }
}

/** Slices of a fat binary, or the single slice of a thin one (needs the first 4 KB). */
export function machoSlices(prefix: Buffer): MachoSlice[] {
  if (prefix.length < 8) throw new MachoError("Executable is too short");
  const magicBE = prefix.readUInt32BE(0);
  if (magicBE === FAT_MAGIC || magicBE === FAT_MAGIC_64) {
    const count = prefix.readUInt32BE(4);
    const entrySize = magicBE === FAT_MAGIC_64 ? 32 : 20;
    const slices: MachoSlice[] = [];
    for (let index = 0; index < count; index += 1) {
      const base = 8 + index * entrySize;
      if (base + entrySize > prefix.length) throw new MachoError("Truncated fat header");
      const offset =
        magicBE === FAT_MAGIC_64
          ? Number(prefix.readBigUInt64BE(base + 8))
          : prefix.readUInt32BE(base + 8);
      slices.push({
        cputype: prefix.readInt32BE(base),
        cpusubtype: prefix.readInt32BE(base + 4),
        offset,
      });
    }
    return slices;
  }
  const magicLE = prefix.readUInt32LE(0);
  if (magicLE !== MH_MAGIC && magicLE !== MH_MAGIC_64) {
    throw new MachoError("Main executable is not a Mach-O file");
  }
  return [{ offset: 0, cputype: prefix.readInt32LE(4), cpusubtype: prefix.readInt32LE(8) }];
}

/** Bytes needed from `slice.offset` to read its header and load commands. */
export function sliceHeaderLength(buffer: Buffer, offset: number): number {
  const magic = buffer.readUInt32LE(offset);
  const headerSize = magic === MH_MAGIC_64 ? 32 : 28;
  if (magic !== MH_MAGIC && magic !== MH_MAGIC_64) throw new MachoError("Bad slice magic");
  return headerSize + buffer.readUInt32LE(offset + 20);
}

/** True when a slice carries an encryption load command with cryptid != 0. */
export function sliceIsEncrypted(buffer: Buffer, offset: number): boolean {
  const magic = buffer.readUInt32LE(offset);
  const is64 = magic === MH_MAGIC_64;
  const ncmds = buffer.readUInt32LE(offset + 16);
  let cursor = offset + (is64 ? 32 : 28);
  for (let index = 0; index < ncmds; index += 1) {
    if (cursor + 8 > buffer.length) throw new MachoError("Truncated load commands");
    const cmd = buffer.readUInt32LE(cursor);
    const size = buffer.readUInt32LE(cursor + 4);
    if (cmd === LC_ENCRYPTION_INFO || cmd === LC_ENCRYPTION_INFO_64) {
      return buffer.readUInt32LE(cursor + 16) !== 0;
    }
    if (size < 8) throw new MachoError("Corrupt load command");
    cursor += size;
  }
  return false;
}

const LC_SEGMENT = 0x1;
const LC_SEGMENT_64 = 0x19;
const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x80000018;
const S_ZEROFILL = 0x1;

/** Lowest file offset of section data in a slice: load commands must end before it. */
function firstSectionOffset(buffer: Buffer, offset: number): number {
  const is64 = buffer.readUInt32LE(offset) === MH_MAGIC_64;
  const ncmds = buffer.readUInt32LE(offset + 16);
  let cursor = offset + (is64 ? 32 : 28);
  let lowest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < ncmds; index += 1) {
    const cmd = buffer.readUInt32LE(cursor);
    const size = buffer.readUInt32LE(cursor + 4);
    if (cmd === LC_SEGMENT_64 || cmd === LC_SEGMENT) {
      const wide = cmd === LC_SEGMENT_64;
      const nsects = buffer.readUInt32LE(cursor + (wide ? 64 : 48));
      const first = cursor + (wide ? 72 : 56);
      const sectionSize = wide ? 80 : 68;
      for (let section = 0; section < nsects; section += 1) {
        const base = first + section * sectionSize;
        const sectionOffset = buffer.readUInt32LE(base + (wide ? 48 : 40));
        const flags = buffer.readUInt32LE(base + (wide ? 64 : 56));
        if (sectionOffset !== 0 && (flags & 0xff) !== S_ZEROFILL) {
          lowest = Math.min(lowest, sectionOffset);
        }
      }
    }
    cursor += size;
  }
  return lowest;
}

function dylibCommandPaths(buffer: Buffer, offset: number): string[] {
  const is64 = buffer.readUInt32LE(offset) === MH_MAGIC_64;
  const ncmds = buffer.readUInt32LE(offset + 16);
  let cursor = offset + (is64 ? 32 : 28);
  const paths: string[] = [];
  for (let index = 0; index < ncmds; index += 1) {
    const cmd = buffer.readUInt32LE(cursor);
    const size = buffer.readUInt32LE(cursor + 4);
    if (cmd === LC_LOAD_DYLIB || cmd === LC_LOAD_WEAK_DYLIB || cmd === 0x8000001f) {
      const nameOffset = buffer.readUInt32LE(cursor + 8);
      const end = buffer.indexOf(0, cursor + nameOffset);
      paths.push(buffer.toString("utf8", cursor + nameOffset, Math.min(end, cursor + size)));
    }
    cursor += size;
  }
  return paths;
}

/** Install names this binary loads (every slice; deduplicated). */
export function linkedDylibs(binary: Buffer): string[] {
  const all = new Set<string>();
  for (const slice of machoSlices(binary)) {
    for (const name of dylibCommandPaths(binary, slice.offset)) all.add(name);
  }
  return [...all];
}

/**
 * Appends an LC_LOAD_WEAK_DYLIB for `loadPath` to every slice (the inject of 26.5), in the
 * header padding before the first section. Idempotent. The existing code signature becomes
 * invalid; signing runs after this.
 */
export function addLoadDylib(binary: Buffer, loadPath: string): Buffer {
  const out = Buffer.from(binary);
  const name = Buffer.from(`${loadPath}\0`, "utf8");
  const commandSize = Math.ceil((24 + name.length) / 8) * 8;
  for (const slice of machoSlices(out)) {
    const offset = slice.offset;
    if (dylibCommandPaths(out, offset).includes(loadPath)) continue;
    const is64 = out.readUInt32LE(offset) === MH_MAGIC_64;
    const headerSize = is64 ? 32 : 28;
    const sizeofcmds = out.readUInt32LE(offset + 20);
    const end = offset + headerSize + sizeofcmds;
    const limit = offset + firstSectionOffset(out, offset);
    if (end + commandSize > limit) {
      throw new MachoError(`No room in the Mach-O header to load ${loadPath}`);
    }
    if (out.subarray(end, end + commandSize).some((byte) => byte !== 0)) {
      throw new MachoError("Mach-O header padding is not empty");
    }
    out.writeUInt32LE(LC_LOAD_WEAK_DYLIB, end);
    out.writeUInt32LE(commandSize, end + 4);
    out.writeUInt32LE(24, end + 8);
    out.writeUInt32LE(2, end + 12);
    out.writeUInt32LE(0x10000, end + 16);
    out.writeUInt32LE(0x10000, end + 20);
    name.copy(out, end + 24);
    out.writeUInt32LE(out.readUInt32LE(offset + 16) + 1, offset + 16);
    out.writeUInt32LE(sizeofcmds + commandSize, offset + 20);
  }
  return out;
}
