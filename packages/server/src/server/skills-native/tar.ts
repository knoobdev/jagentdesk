import { promises as fs } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Minimal, defensive `.tar.gz` reader for skill downloads (GitHub codeload
 * tarballs, npm package tarballs). Only regular files and directories are
 * written; symlinks, hard links and device entries are skipped, and any path
 * escaping the destination is rejected. The top-level directory of the archive
 * (`<repo>-<ref>/`, `package/`) is stripped.
 */
export interface ExtractResult {
  /** Commit sha from the pax global header `comment=` (GitHub sets it). */
  revision: string | null;
  fileCount: number;
}

export interface ExtractLimits {
  maxBytes: number;
  maxFiles: number;
}

export const DEFAULT_LIMITS: ExtractLimits = { maxBytes: 256 * 1024 * 1024, maxFiles: 20_000 };
const BLOCK = 512;

function readString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const nul = slice.indexOf(0);
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
}

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readString(buffer, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function parsePax(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const length = Number.parseInt(data.subarray(offset, space).toString("utf8"), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = data.subarray(space + 1, offset + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    offset += length;
  }
  return records;
}

function stripTopLevel(entryPath: string): string | null {
  const normalized = entryPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const slash = normalized.indexOf("/");
  if (slash === -1) return null;
  const rest = normalized.slice(slash + 1).replace(/\/+$/, "");
  return rest.length > 0 ? rest : null;
}

export function safeTarget(destination: string, relative: string): string | null {
  if (relative.split("/").some((segment) => segment === "..") || path.isAbsolute(relative)) {
    return null;
  }
  const target = path.resolve(destination, relative);
  const rel = path.relative(destination, target);
  return rel.startsWith("..") || path.isAbsolute(rel) ? null : target;
}

interface TarHeader {
  name: string;
  size: number;
  type: string;
  mode: number;
}

function readHeader(archive: Buffer, offset: number): TarHeader | null {
  const header = archive.subarray(offset, offset + BLOCK);
  if (header.length < BLOCK || header.every((byte) => byte === 0)) return null;
  const prefix = readString(header, 345, 155);
  const baseName = readString(header, 0, 100);
  return {
    name: prefix ? `${prefix}/${baseName}` : baseName,
    size: readOctal(header, 124, 12),
    type: String.fromCharCode(header[156] ?? 48) || "0",
    mode: readOctal(header, 100, 8),
  };
}

class Extractor {
  revision: string | null = null;
  fileCount = 0;
  private totalBytes = 0;
  private nextPath: string | null = null;

  constructor(
    private readonly destination: string,
    private readonly limits: ExtractLimits,
  ) {}

  async handle(header: TarHeader, data: Buffer): Promise<void> {
    switch (header.type) {
      case "g":
        this.revision = parsePax(data)["comment"] ?? this.revision;
        return;
      case "x":
        this.nextPath = parsePax(data)["path"] ?? null;
        return;
      case "L":
        this.nextPath = readString(data, 0, data.length);
        return;
      default:
        break;
    }
    const entryPath = this.nextPath ?? header.name;
    this.nextPath = null;
    const relative = stripTopLevel(entryPath);
    if (!relative) return;
    const target = safeTarget(this.destination, relative);
    if (!target) throw new Error(`Archive entry escapes the destination: ${entryPath}`);
    if (header.type === "5") {
      await fs.mkdir(target, { recursive: true });
      return;
    }
    if (header.type !== "0" && header.type !== "\0" && header.type !== "7") return;
    await this.writeFile(target, data, header.mode);
  }

  private async writeFile(target: string, data: Buffer, mode: number): Promise<void> {
    this.fileCount += 1;
    this.totalBytes += data.length;
    if (this.fileCount > this.limits.maxFiles || this.totalBytes > this.limits.maxBytes) {
      throw new Error("Archive is larger than the allowed skill download size");
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Keep the executable bit, drop setuid/setgid/sticky and group/other write.
    await fs.writeFile(target, data, { mode: (mode & 0o755) | 0o600 });
  }
}

export async function extractTarGz(
  gzipped: Buffer,
  destination: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): Promise<ExtractResult> {
  const archive = gunzipSync(gzipped, { maxOutputLength: limits.maxBytes + 64 * 1024 * 1024 });
  await fs.mkdir(destination, { recursive: true });
  const extractor = new Extractor(path.resolve(destination), limits);
  let offset = 0;
  while (offset + BLOCK <= archive.length) {
    const header = readHeader(archive, offset);
    if (!header) break;
    const dataStart = offset + BLOCK;
    const data = archive.subarray(dataStart, dataStart + header.size);
    await extractor.handle(header, data);
    offset = dataStart + Math.ceil(header.size / BLOCK) * BLOCK;
  }
  return { revision: extractor.revision, fileCount: extractor.fileCount };
}
