import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type {
  SshLogBookmark,
  SshLogSearchMatch,
  SshLogSource,
  SshSessionLog,
} from "@jagentdesk/protocol/ssh/logs-import-schemas";
import {
  SSH_FILE_MODE,
  WriteQueue,
  ensureSecureDir,
  newSshId,
  readSecureJson,
  writeSecureFileAtomic,
  writeSecureJsonAtomic,
} from "../snippets/secure-file.js";
import { TerminalTextCleaner } from "./terminal-text.js";

export const SESSION_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_READ_DEFAULT_BYTES = 256 * 1024;
export const LOG_SEARCH_MAX_MATCHES = 500;
const SEARCH_LINE_MAX_CHARS = 400;

const BookmarkMetaSchema = z.object({
  id: z.string(),
  serverId: z.string(),
  comment: z.string(),
  createdAtMs: z.number(),
  sessionStartedAtMs: z.number(),
});
type BookmarkMeta = z.infer<typeof BookmarkMetaSchema>;

const LogsIndexSchema = z.object({
  enabledServerIds: z.array(z.string()),
  recent: z.record(z.string(), z.object({ sessionStartedAtMs: z.number() })),
  bookmarks: z.array(BookmarkMetaSchema),
});
type LogsIndex = z.infer<typeof LogsIndexSchema>;

const EMPTY_INDEX: LogsIndex = { enabledServerIds: [], recent: {}, bookmarks: [] };

export class SessionLogNotFoundError extends Error {
  constructor(readonly source: SshLogSource) {
    super(
      source.kind === "recent"
        ? `No session log for server ${source.serverId}`
        : `Bookmark ${source.bookmarkId} not found`,
    );
  }
}

interface ActiveRecording {
  generation: number;
  bookmarkIds: Set<string>;
}

export interface SessionLogListing {
  logs: SshSessionLog[];
  bookmarks: SshLogBookmark[];
  enabledServerIds: string[];
}

export interface SearchResult {
  matches: SshLogSearchMatch[];
  truncated: boolean;
}

export interface LogWindow {
  text: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
}

/** Receives one session's terminal output; the owner calls write() for every chunk. */
export interface SessionLogRecorder {
  write(chunk: string): void;
  /** Writes the unfinished last line and stops recording. */
  close(): Promise<void>;
}

/**
 * Session logs (spec 25.8): off by default per server; one recent log per server, at
 * most 10 MB with the oldest text cut first; bookmarks keep a log permanently with a
 * comment. Only output is recorded, so input typed with echo off never lands here.
 */
export class SessionLogService {
  private readonly dir: string;
  private readonly bookmarksDir: string;
  private readonly indexPath: string;
  private readonly indexQueue = new WriteQueue();
  private readonly fileQueues = new Map<string, WriteQueue>();
  private readonly active = new Map<string, ActiveRecording>();
  private readonly maxBytes: number;
  private generation = 0;

  constructor(private readonly options: { sshHome: string; now: () => number; maxBytes?: number }) {
    this.dir = path.join(options.sshHome, "logs");
    this.bookmarksDir = path.join(this.dir, "bookmarks");
    this.indexPath = path.join(this.dir, "index.json");
    this.maxBytes = options.maxBytes ?? SESSION_LOG_MAX_BYTES;
  }

  async list(): Promise<SessionLogListing> {
    const index = await this.readIndex();
    const logs: SshSessionLog[] = [];
    for (const [serverId, recent] of Object.entries(index.recent)) {
      const stat = await statOrNull(this.recentPath(serverId));
      if (!stat) continue;
      logs.push({
        serverId,
        sessionStartedAtMs: recent.sessionStartedAtMs,
        updatedAtMs: Math.round(stat.mtimeMs),
        sizeBytes: stat.size,
        recording: this.active.has(serverId),
      });
    }
    const bookmarks: SshLogBookmark[] = [];
    for (const meta of index.bookmarks) {
      const stat = await statOrNull(this.bookmarkPath(meta.id));
      bookmarks.push({ ...meta, sizeBytes: stat?.size ?? 0 });
    }
    return { logs, bookmarks, enabledServerIds: index.enabledServerIds };
  }

  async isEnabled(serverId: string): Promise<boolean> {
    return (await this.readIndex()).enabledServerIds.includes(serverId);
  }

  async setEnabled(serverId: string, enabled: boolean): Promise<void> {
    if (!enabled) this.active.delete(serverId);
    await this.updateIndex((index) => {
      const others = index.enabledServerIds.filter((id) => id !== serverId);
      index.enabledServerIds = enabled ? [...others, serverId] : others;
    });
  }

  /**
   * Hook for the owner: call when an SSH terminal session starts and feed it the
   * session's output. Returns null when logging is off for the server. A new session
   * replaces the server's recent log; an older session still open stops writing.
   */
  async startRecording(serverId: string): Promise<SessionLogRecorder | null> {
    if (!(await this.isEnabled(serverId))) return null;
    await ensureSecureDir(this.dir);
    this.generation += 1;
    const recording: ActiveRecording = { generation: this.generation, bookmarkIds: new Set() };
    this.active.set(serverId, recording);
    await this.queueFor(serverId).run(() => writeSecureFileAtomic(this.recentPath(serverId), ""));
    const sessionStartedAtMs = this.options.now();
    await this.updateIndex((index) => {
      index.recent[serverId] = { sessionStartedAtMs };
    });
    const cleaner = new TerminalTextCleaner();
    let pending: Promise<void> = Promise.resolve();
    const append = (text: string) => {
      if (text === "" || this.active.get(serverId) !== recording) return;
      pending = this.append(serverId, recording, text);
    };
    return {
      write: (chunk) => append(cleaner.push(chunk)),
      close: async () => {
        append(cleaner.flush());
        await pending;
        if (this.active.get(serverId) === recording) this.active.delete(serverId);
      },
    };
  }

  async read(source: SshLogSource, offset?: number, length?: number): Promise<LogWindow> {
    const filePath = await this.pathFor(source);
    const stat = await statOrNull(filePath);
    if (!stat) throw new SessionLogNotFoundError(source);
    const windowLength = length ?? LOG_READ_DEFAULT_BYTES;
    const start = Math.min(offset ?? Math.max(0, stat.size - windowLength), stat.size);
    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(Math.min(windowLength, stat.size - start));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
      const { skip, end } = utf8Window(buffer.subarray(0, bytesRead), start === 0);
      return {
        text: buffer.subarray(skip, end).toString("utf8"),
        offset: start + skip,
        nextOffset: start + end,
        totalBytes: stat.size,
      };
    } finally {
      await handle.close();
    }
  }

  async search(
    source: SshLogSource,
    query: string,
    options: { caseSensitive?: boolean } = {},
  ): Promise<SearchResult> {
    const filePath = await this.pathFor(source);
    const text = await readOrNull(filePath);
    if (text === null) throw new SessionLogNotFoundError(source);
    return searchLogText(text, query, options.caseSensitive ?? false);
  }

  async bookmark(serverId: string, comment: string): Promise<SshLogBookmark> {
    const index = await this.readIndex();
    const recent = index.recent[serverId];
    const source: SshLogSource = { kind: "recent", serverId };
    if (!recent) throw new SessionLogNotFoundError(source);
    const id = newSshId("bmk");
    await ensureSecureDir(this.bookmarksDir);
    await this.queueFor(serverId).run(async () => {
      await fs.copyFile(this.recentPath(serverId), this.bookmarkPath(id));
      await fs.chmod(this.bookmarkPath(id), SSH_FILE_MODE);
    });
    this.active.get(serverId)?.bookmarkIds.add(id);
    const meta: BookmarkMeta = {
      id,
      serverId,
      comment: comment.trim(),
      createdAtMs: this.options.now(),
      sessionStartedAtMs: recent.sessionStartedAtMs,
    };
    await this.updateIndex((next) => {
      next.bookmarks.push(meta);
    });
    const stat = await statOrNull(this.bookmarkPath(id));
    return { ...meta, sizeBytes: stat?.size ?? 0 };
  }

  async updateBookmark(id: string, comment: string): Promise<SshLogBookmark> {
    let updated: BookmarkMeta | undefined;
    await this.updateIndex((index) => {
      const meta = index.bookmarks.find((entry) => entry.id === id);
      if (!meta) return;
      meta.comment = comment.trim();
      updated = { ...meta };
    });
    if (!updated) throw new SessionLogNotFoundError({ kind: "bookmark", bookmarkId: id });
    const stat = await statOrNull(this.bookmarkPath(id));
    return { ...updated, sizeBytes: stat?.size ?? 0 };
  }

  private async append(serverId: string, recording: ActiveRecording, text: string): Promise<void> {
    const targets = [
      this.recentPath(serverId),
      ...[...recording.bookmarkIds].map((id) => this.bookmarkPath(id)),
    ];
    await this.queueFor(serverId).run(async () => {
      for (const target of targets) {
        await fs.appendFile(target, text, { encoding: "utf8", mode: SSH_FILE_MODE });
        await this.trim(target);
      }
    });
  }

  /** Cuts the oldest text once a log passes the cap, keeping 90 % from a line start. */
  private async trim(filePath: string): Promise<void> {
    const stat = await fs.stat(filePath);
    if (stat.size <= this.maxBytes) return;
    const content = await fs.readFile(filePath);
    const keep = Math.floor(this.maxBytes * 0.9);
    let start = content.length - keep;
    const newline = content.indexOf(0x0a, start);
    start = newline === -1 ? start : newline + 1;
    await writeSecureFileAtomic(filePath, content.subarray(start).toString("utf8"));
  }

  private async pathFor(source: SshLogSource): Promise<string> {
    if (source.kind === "recent") return this.recentPath(source.serverId);
    const index = await this.readIndex();
    if (!index.bookmarks.some((entry) => entry.id === source.bookmarkId)) {
      throw new SessionLogNotFoundError(source);
    }
    return this.bookmarkPath(source.bookmarkId);
  }

  private recentPath(serverId: string): string {
    return path.join(this.dir, `${safeName(serverId)}.log`);
  }

  private bookmarkPath(id: string): string {
    return path.join(this.bookmarksDir, `${safeName(id)}.log`);
  }

  private queueFor(serverId: string): WriteQueue {
    let queue = this.fileQueues.get(serverId);
    if (!queue) {
      queue = new WriteQueue();
      this.fileQueues.set(serverId, queue);
    }
    return queue;
  }

  private readIndex(): Promise<LogsIndex> {
    return readSecureJson(this.indexPath, LogsIndexSchema, structuredClone(EMPTY_INDEX));
  }

  private updateIndex(change: (index: LogsIndex) => void): Promise<void> {
    return this.indexQueue.run(async () => {
      const index = await this.readIndex();
      change(index);
      await writeSecureJsonAtomic(this.indexPath, index);
    });
  }
}

/** Server and bookmark ids become file names; anything outside [A-Za-z0-9_-] is refused. */
function safeName(id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid id ${JSON.stringify(id)}`);
  return id;
}

async function statOrNull(filePath: string): Promise<Stats | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

interface Utf8Bounds {
  skip: number;
  end: number;
}

/** Drops a partial UTF-8 character at either edge of a byte window. */
export function utf8Window(bytes: Uint8Array, atFileStart: boolean): Utf8Bounds {
  let skip = 0;
  if (!atFileStart) {
    while (skip < bytes.length && skip < 3 && (bytes[skip]! & 0xc0) === 0x80) skip += 1;
  }
  let end = bytes.length;
  for (let back = 1; back <= Math.min(3, end - skip); back += 1) {
    const byte = bytes[end - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    let width = 1;
    if ((byte & 0xe0) === 0xc0) width = 2;
    else if ((byte & 0xf0) === 0xe0) width = 3;
    else if ((byte & 0xf8) === 0xf0) width = 4;
    if (width > back) end -= back;
    break;
  }
  return { skip, end };
}

/** Line-by-line substring search with the byte offset of each matching line. */
export function searchLogText(text: string, query: string, caseSensitive: boolean): SearchResult {
  const needle = caseSensitive ? query : query.toLowerCase();
  const matches: SshLogSearchMatch[] = [];
  let byteOffset = 0;
  let truncated = false;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const haystack = caseSensitive ? line : line.toLowerCase();
    const column = haystack.indexOf(needle);
    if (column !== -1) {
      if (matches.length === LOG_SEARCH_MAX_MATCHES) {
        truncated = true;
        break;
      }
      matches.push({
        lineNumber: index + 1,
        byteOffset,
        column,
        line: line.slice(0, SEARCH_LINE_MAX_CHARS),
      });
    }
    byteOffset += Buffer.byteLength(line) + 1;
  }
  return { matches, truncated };
}
