import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { ensurePrivateDirectory, writePrivateFileAtomicSync } from "../private-files.js";
import type { FigmaCache } from "./context.js";

// Disk cache for Figma content (spec 32.3 "Cache", 32.8 "cache results"): node subtrees and
// outlines as JSON, render/image-fill/font bytes as binary with a one-line mime sidecar, under
// $JAGENTDESK_HOME/figma/cache. LRU-evicted at a 2 GB cap by last access. Keys carry the Figma
// version (handlers cache per version), so entries are immutable and entries never expire.

export const FIGMA_CACHE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const JSON_SUFFIX = ".json";
const BYTES_SUFFIX = ".bin";
const MIME_SUFFIX = ".mime";

interface FileRecord {
  size: number;
  accessedAt_ms: number;
}

export interface FigmaDiskCacheOptions {
  maxBytes?: number;
  now?: () => number;
}

/** Keys are arbitrary strings (file keys, node ids like `1:2`, urls). Each path segment keeps
 *  safe characters and the final name embeds a digest of the whole key, so no key can escape
 *  the cache directory or collide with a differently-spelled sibling. */
export function cachePathFor(dir: string, key: string, suffix: string): string {
  const segments = key
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, "-"));
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const base = `${(segments[segments.length - 1] ?? "entry").slice(0, 80)}-${digest}`;
  return path.join(dir, ...segments.slice(0, -1), base + suffix);
}

export class FigmaDiskCache implements FigmaCache {
  readonly dir: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly files = new Map<string, FileRecord>();
  private totalBytes = 0;
  private scanned: Promise<void> | null = null;

  constructor(dir: string, options: FigmaDiskCacheOptions = {}) {
    this.dir = dir;
    this.maxBytes = options.maxBytes ?? FIGMA_CACHE_MAX_BYTES;
    this.now = options.now ?? (() => Date.now());
  }

  async getJson<T>(key: string): Promise<T | null> {
    const file = cachePathFor(this.dir, key, JSON_SUFFIX);
    const data = await this.read(file);
    if (data === null) return null;
    try {
      return JSON.parse(data.toString("utf8")) as T;
    } catch {
      await this.remove(file);
      return null;
    }
  }

  async putJson(key: string, value: unknown): Promise<void> {
    await this.write(cachePathFor(this.dir, key, JSON_SUFFIX), JSON.stringify(value));
  }

  async getBytes(key: string): Promise<{ mimeType: string; data: Buffer } | null> {
    const base = cachePathFor(this.dir, key, BYTES_SUFFIX);
    const data = await this.read(base);
    if (data === null) return null;
    const mime = await this.read(cachePathFor(this.dir, key, MIME_SUFFIX));
    return { mimeType: (mime?.toString("utf8") || "application/octet-stream").trim(), data };
  }

  async putBytes(key: string, value: { mimeType: string; data: Buffer }): Promise<void> {
    await this.write(cachePathFor(this.dir, key, MIME_SUFFIX), value.mimeType);
    await this.write(cachePathFor(this.dir, key, BYTES_SUFFIX), value.data);
  }

  /** Total bytes tracked (the value the cap is measured against); observable for tests. */
  async size(): Promise<number> {
    await this.ensureScanned();
    return this.totalBytes;
  }

  private async read(file: string): Promise<Buffer | null> {
    await this.ensureScanned();
    try {
      const data = await fs.readFile(file);
      this.record(file, data.length);
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (this.files.delete(file)) this.recount();
        return null;
      }
      throw error;
    }
  }

  private async write(file: string, data: string | Buffer): Promise<void> {
    await this.ensureScanned();
    writePrivateFileAtomicSync(file, data);
    this.record(file, Buffer.byteLength(data));
    await this.evict();
  }

  private record(file: string, size: number): void {
    const previous = this.files.get(file);
    if (previous && previous.size === size) {
      previous.accessedAt_ms = this.now();
      return;
    }
    this.files.set(file, { size, accessedAt_ms: this.now() });
    this.recount();
  }

  private recount(): void {
    this.totalBytes = 0;
    for (const record of this.files.values()) this.totalBytes += record.size;
  }

  private async remove(file: string): Promise<void> {
    await fs.rm(file, { force: true });
    if (this.files.delete(file)) this.recount();
  }

  private async evict(): Promise<void> {
    while (this.totalBytes > this.maxBytes) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [file, record] of this.files) {
        if (record.accessedAt_ms < oldest) {
          oldest = record.accessedAt_ms;
          victim = file;
        }
      }
      if (victim === null) return;
      await this.remove(victim);
      // A bytes entry is a pair: dropping the payload drops its mime sidecar.
      if (victim.endsWith(BYTES_SUFFIX)) {
        await this.remove(victim.slice(0, -BYTES_SUFFIX.length) + MIME_SUFFIX);
      }
    }
  }

  private async ensureScanned(): Promise<void> {
    this.scanned ??= this.scan();
    await this.scanned;
  }

  /** Adopt what is already on disk so a restart keeps serving (and counting) old entries. */
  private async scan(): Promise<void> {
    ensurePrivateDirectory(this.dir);
    const stack = [this.dir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || entry.name.startsWith(".")) continue;
        if (
          !full.endsWith(JSON_SUFFIX) &&
          !full.endsWith(BYTES_SUFFIX) &&
          !full.endsWith(MIME_SUFFIX)
        )
          continue;
        const stat = await fs.stat(full);
        this.files.set(full, { size: stat.size, accessedAt_ms: stat.mtimeMs });
      }
    }
    this.recount();
    await this.evict();
  }
}
