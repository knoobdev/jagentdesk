import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureSecureDir, writeSecureFileAtomic } from "../ssh/snippets/secure-file.js";

// Content-hash cache for snapshots (spec 33.4): (path, size, mtimeMs, ino) -> sha256, persisted in
// $JAGENTDESK_HOME/remote-exec/hash-cache/<workspaceKey>.json so an unchanged repo of ~5k files
// re-snapshots in well under 2 s.

interface HashCacheEntry {
  size: number;
  mtimeMs: number;
  ino: number;
  sha256: string;
}

interface HashCacheFile {
  version: 1;
  entries: Record<string, HashCacheEntry>;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export class HashCache {
  private entries: Record<string, HashCacheEntry> = {};
  private loaded = false;
  private dirty = false;

  constructor(private readonly filePath: string) {}

  /** Returns the cached hash when path+size+mtimeMs+ino all match, else null. */
  get(pathKey: string, stat: { size: number; mtimeMs: number; ino: number }): string | null {
    const entry = this.entries[pathKey];
    if (!entry) return null;
    if (entry.size !== stat.size || entry.mtimeMs !== stat.mtimeMs || entry.ino !== stat.ino) {
      return null;
    }
    return entry.sha256;
  }

  set(pathKey: string, stat: { size: number; mtimeMs: number; ino: number }, sha256: string): void {
    this.entries[pathKey] = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, sha256 };
    this.dirty = true;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as HashCacheFile;
      if (parsed.version === 1 && typeof parsed.entries === "object" && parsed.entries !== null) {
        this.entries = parsed.entries;
      }
    } catch {
      this.entries = {};
    }
  }

  /** Persists the cache, pruned to the paths still present in the workspace. */
  async save(keepPaths: ReadonlySet<string>): Promise<void> {
    await this.load();
    if (!this.dirty) return;
    const pruned: Record<string, HashCacheEntry> = {};
    for (const [pathKey, entry] of Object.entries(this.entries)) {
      if (keepPaths.has(pathKey)) pruned[pathKey] = entry;
    }
    await ensureSecureDir(path.dirname(this.filePath));
    const payload = JSON.stringify({ version: 1, entries: pruned } satisfies HashCacheFile);
    await writeSecureFileAtomic(this.filePath, payload);
    this.dirty = false;
  }
}
