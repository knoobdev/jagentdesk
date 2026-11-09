import { promises as fs } from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "../atomic-file.js";

// Local mirror of a job's remote output.log (spec 33.6): at most 20 MiB on disk, keeping the first
// 10 MiB and the newest 10 MiB once the cap is exceeded (outputTruncated). The on-disk layout is
// derivable from (totalBytes, truncated): everything, or head(10 MiB) ++ tail(last 10 MiB).

export const MIRROR_MAX_BYTES = 20 * 1024 * 1024;
export const MIRROR_HEAD_BYTES = 10 * 1024 * 1024;
export const MIRROR_TAIL_BYTES = 10 * 1024 * 1024;

export class OutputMirror {
  private totalBytes: number;
  private truncated: boolean;

  constructor(
    private readonly filePath: string,
    initial?: { totalBytes: number; truncated: boolean },
  ) {
    this.totalBytes = initial?.totalBytes ?? 0;
    this.truncated = initial?.truncated ?? false;
  }

  get state(): { totalBytes: number; truncated: boolean } {
    return { totalBytes: this.totalBytes, truncated: this.truncated };
  }

  /** Appends bytes to the mirror, compacting to head+tail once the 20 MiB cap is crossed. */
  async append(bytes: Buffer): Promise<void> {
    if (bytes.length === 0) return;
    this.totalBytes += bytes.length;
    if (!this.truncated) {
      if (this.totalBytes <= MIRROR_MAX_BYTES) {
        await this.appendToDisk(bytes);
        return;
      }
      this.truncated = true;
      // Everything so far: keep the first 10 MiB as head, the last 10 MiB as tail.
      const candidate = Buffer.concat([await this.readMirrorFile(), bytes]);
      const head = candidate.subarray(0, MIRROR_HEAD_BYTES);
      const tail = tailSlice(candidate, MIRROR_TAIL_BYTES);
      await this.rewriteMirror(Buffer.concat([head, tail]));
      return;
    }
    // Truncated: the file is head(10 MiB) ++ tail(≤10 MiB); appends extend the tail, which gets
    // trimmed from the front when it outgrows its 10 MiB budget.
    const currentTail = await this.readTailFromDisk();
    const candidate = Buffer.concat([currentTail, bytes]);
    if (candidate.length <= MIRROR_TAIL_BYTES) {
      await this.appendToDisk(bytes);
      return;
    }
    const head = await this.readHeadFromDisk();
    await this.rewriteMirror(Buffer.concat([head, tailSlice(candidate, MIRROR_TAIL_BYTES)]));
  }

  /**
   * Reads [offset, offset + limit) when the mirror covers the whole range contiguously, else null
   * (the caller falls back to the remote log).
   */
  async read(offset: number, limit: number): Promise<Buffer | null> {
    if (limit <= 0 || offset < 0 || offset >= this.totalBytes) return null;
    const end = Math.min(offset + limit, this.totalBytes);
    let physical: number;
    if (!this.truncated) {
      physical = offset;
    } else if (end <= MIRROR_HEAD_BYTES) {
      physical = offset;
    } else if (offset >= this.totalBytes - this.tailLength()) {
      physical = MIRROR_HEAD_BYTES + (offset - (this.totalBytes - this.tailLength()));
    } else {
      return null; // range spans the dropped middle
    }
    const handle = await fs.open(this.filePath, "r");
    try {
      const buffer = Buffer.alloc(end - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, physical);
      return buffer.subarray(0, bytesRead);
    } catch {
      return null;
    } finally {
      await handle.close();
    }
  }

  private tailLength(): number {
    return Math.min(this.totalBytes - MIRROR_HEAD_BYTES, MIRROR_TAIL_BYTES);
  }

  private async appendToDisk(bytes: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, bytes);
  }

  private async rewriteMirror(content: Buffer): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFileAtomic(this.filePath, content);
  }

  private async readMirrorFile(): Promise<Buffer> {
    return fs.readFile(this.filePath).catch(() => Buffer.alloc(0));
  }

  private async readHeadFromDisk(): Promise<Buffer> {
    const handle = await fs.open(this.filePath, "r");
    try {
      const head = Buffer.alloc(MIRROR_HEAD_BYTES);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      return head.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  private async readTailFromDisk(): Promise<Buffer> {
    const tailLength = this.truncated ? this.tailLength() : 0;
    if (tailLength <= 0) return Buffer.alloc(0);
    const handle = await fs.open(this.filePath, "r");
    try {
      const tail = Buffer.alloc(tailLength);
      const { bytesRead } = await handle.read(tail, 0, tailLength, MIRROR_HEAD_BYTES);
      return tail.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}

function tailSlice(buffer: Buffer, keep: number): Buffer {
  return buffer.length <= keep ? buffer : buffer.subarray(buffer.length - keep);
}
