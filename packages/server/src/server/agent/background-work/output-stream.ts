import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import { sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type {
  BackgroundWorkOutputFile,
  BackgroundWorkOutputPage,
  BackgroundWorkOutputSource,
} from "./index.js";

/** ADR-0062 §2: the tail sent when a viewer opens the output. */
export const OUTPUT_TAIL_BYTES = 256 * 1024;
/** ADR-0062 §2: the most new output pushed to one viewer per second. */
export const OUTPUT_PUSH_BYTES_PER_SECOND = 64 * 1024;
/** One provider API page. */
const READER_PAGE_BYTES = 64 * 1024;

export interface BackgroundWorkOutputChunk {
  chunk: string;
  /** Byte offset of the first byte read for this chunk. */
  offset: number;
  /** Byte offset after this chunk. A later chunk that starts past it skipped output. */
  nextOffset: number;
  /** True when the viewer should drop what it has: the first tail, or the output restarted. */
  reset: boolean;
}

export class BackgroundWorkOutputUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BackgroundWorkOutputUnavailableError";
  }
}

export interface FollowBackgroundWorkOutputOptions {
  source: BackgroundWorkOutputSource;
  onChunk(chunk: BackgroundWorkOutputChunk): void;
  /** The source stopped being readable; the follow is over. */
  onError(error: Error): void;
  /** How often a file is re-checked besides change events, and a reader is polled. */
  pollMs?: number;
  tailBytes?: number;
  bytesPerSecond?: number;
}

/** Stops following; safe to call more than once. */
export type StopFollowing = () => void;

/**
 * Sends the tail of one background item's output, then pushes what is appended, rate-limited.
 * Rejects with {@link BackgroundWorkOutputUnavailableError} when the source cannot be read.
 */
export async function followBackgroundWorkOutput(
  options: FollowBackgroundWorkOutputOptions,
): Promise<StopFollowing> {
  const reader =
    options.source.type === "file"
      ? await openFileReader(options.source)
      : providerReader(options.source);
  const follower = new OutputFollower(reader, options);
  try {
    await follower.start();
  } catch (error) {
    follower.stop();
    throw error;
  }
  return () => follower.stop();
}

interface ByteReader {
  size(): Promise<number>;
  read(cursor: number, limit: number): Promise<BackgroundWorkOutputPage>;
  watch?(onChange: () => void): () => void;
  close(): Promise<void>;
}

class OutputFollower {
  private position = 0;
  private decoder = new StringDecoder("utf8");
  /** The next read starts at an arbitrary byte after a skip. */
  private realign = false;
  private tokens: number;
  private refilledAt = Date.now();
  private stopped = false;
  private pumping = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private unwatch: (() => void) | null = null;
  private readonly tailBytes: number;
  private readonly rate: number;

  constructor(
    private readonly reader: ByteReader,
    private readonly options: FollowBackgroundWorkOutputOptions,
  ) {
    this.tailBytes = options.tailBytes ?? OUTPUT_TAIL_BYTES;
    this.rate = options.bytesPerSecond ?? OUTPUT_PUSH_BYTES_PER_SECOND;
    this.tokens = this.rate;
  }

  async start(): Promise<void> {
    const size = await this.reader.size();
    await this.sendTail(size);
    if (this.stopped) return;
    this.unwatch = this.reader.watch?.(() => this.schedule(0)) ?? null;
    this.poll = setInterval(() => this.schedule(0), this.options.pollMs ?? 500);
    this.poll.unref?.();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.poll) clearInterval(this.poll);
    this.unwatch?.();
    void this.reader.close().catch(() => undefined);
  }

  private async sendTail(size: number): Promise<void> {
    const start = Math.max(0, size - this.tailBytes);
    const parts: Buffer[] = [];
    let cursor = start;
    while (cursor < size && !this.stopped) {
      const page = await this.reader.read(cursor, Math.min(READER_PAGE_BYTES, size - cursor));
      if (page.bytes.length === 0) break;
      parts.push(Buffer.from(page.bytes));
      cursor = page.nextCursor;
    }
    const bytes = skipContinuationBytes(Buffer.concat(parts), start > 0);
    this.decoder = new StringDecoder("utf8");
    this.realign = false;
    this.position = cursor;
    this.options.onChunk({
      chunk: this.decoder.write(bytes.data),
      offset: start + bytes.skipped,
      nextOffset: cursor,
      reset: true,
    });
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.pumping) {
      this.again = true;
      return;
    }
    if (this.timer && delayMs > 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pump();
    }, delayMs);
    this.timer.unref?.();
  }

  private async pump(): Promise<void> {
    if (this.stopped) return;
    this.pumping = true;
    try {
      const size = await this.reader.size();
      if (this.stopped) return;
      if (size < this.position) {
        // The source was truncated or replaced: start over from its tail.
        await this.sendTail(size);
        return;
      }
      if (size - this.position > this.tailBytes) {
        // The viewer cannot keep up at the push rate; jump to the newest tail.
        this.position = size - this.tailBytes;
        this.decoder = new StringDecoder("utf8");
        this.realign = true;
      }
      this.refill();
      const backlog = size - this.position;
      if (backlog === 0) return;
      const allowed = Math.floor(Math.min(this.tokens, READER_PAGE_BYTES, backlog));
      if (allowed <= 0) {
        this.schedule(Math.ceil(((1 - this.tokens) / this.rate) * 1000) + 1);
        return;
      }
      const offset = this.position;
      const page = await this.reader.read(offset, allowed);
      if (this.stopped || page.bytes.length === 0) return;
      const realigned = skipContinuationBytes(Buffer.from(page.bytes), this.realign);
      this.realign = false;
      this.tokens -= page.bytes.length;
      this.position = page.nextCursor;
      this.options.onChunk({
        chunk: this.decoder.write(realigned.data),
        offset: offset + realigned.skipped,
        nextOffset: page.nextCursor,
        reset: false,
      });
      if (size > this.position) {
        this.schedule(this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.rate) * 1000) + 1);
      }
    } catch (error) {
      if (this.stopped) return;
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
      this.stop();
    } finally {
      this.pumping = false;
      if (this.again && !this.stopped) {
        this.again = false;
        this.schedule(0);
      }
    }
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.refilledAt) / 1000) * this.rate);
    this.refilledAt = now;
  }
}

/** A tail that starts inside a UTF-8 sequence drops the partial character. */
function skipContinuationBytes(
  data: Buffer,
  midStream: boolean,
): { data: Buffer; skipped: number } {
  if (!midStream) return { data, skipped: 0 };
  let skipped = 0;
  while (skipped < Math.min(3, data.length) && (data[skipped] & 0xc0) === 0x80) skipped++;
  return { data: data.subarray(skipped), skipped };
}

function providerReader(
  source: Extract<BackgroundWorkOutputSource, { type: "reader" }>,
): ByteReader {
  return {
    size: async () => (await source.read({ cursor: 0, limit: 1 })).size,
    read: (cursor, limit) => source.read({ cursor, limit }),
    close: async () => undefined,
  };
}

/**
 * Opens the provider's output file after checking that it is a regular file inside the
 * provider's own folders. A path that resolves elsewhere (a symlink, `..`) is refused.
 */
async function openFileReader(
  source: Extract<BackgroundWorkOutputSource, { type: "file" }>,
): Promise<ByteReader> {
  const file = await source.locate();
  if (!file) throw new BackgroundWorkOutputUnavailableError("Output is not available");
  const handle = await openVerifiedOutputFile(file);
  return {
    size: async () => (await handle.stat()).size,
    read: async (cursor, limit) => {
      const buffer = Buffer.alloc(limit);
      const { bytesRead } = await handle.read(buffer, 0, limit, cursor);
      const { size } = await handle.stat();
      return { bytes: buffer.subarray(0, bytesRead), nextCursor: cursor + bytesRead, size };
    },
    watch: (onChange) => {
      let watcher: FSWatcher | null = null;
      try {
        watcher = watch(file.path, { persistent: false }, onChange);
        watcher.on("error", () => watcher?.close());
      } catch {
        // The periodic check still follows the file.
      }
      return () => watcher?.close();
    },
    close: () => handle.close(),
  };
}

export async function openVerifiedOutputFile(file: BackgroundWorkOutputFile): Promise<FileHandle> {
  if (!(await isInsideOutputRoots(file))) {
    throw new BackgroundWorkOutputUnavailableError("Output file is outside the provider's folder");
  }
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const [opened, resolved] = await Promise.all([handle.stat(), stat(await realpath(file.path))]);
    if (!opened.isFile() || opened.ino !== resolved.ino || opened.dev !== resolved.dev) {
      throw new BackgroundWorkOutputUnavailableError("Output file changed while opening");
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** True when `file.path` is a regular, non-symlinked file that resolves inside a root. */
export async function isInsideOutputRoots(file: BackgroundWorkOutputFile): Promise<boolean> {
  try {
    const link = await lstat(file.path);
    if (!link.isFile()) return false;
    const resolved = await realpath(file.path);
    for (const root of file.roots) {
      const realRoot = await realpath(root).catch(() => null);
      if (realRoot && resolved.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep))
        return true;
    }
    return false;
  } catch {
    return false;
  }
}
