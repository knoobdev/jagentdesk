import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MIRROR_HEAD_BYTES,
  MIRROR_MAX_BYTES,
  MIRROR_TAIL_BYTES,
  OutputMirror,
} from "./output-mirror.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "jad-remote-exec-mirror-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function chunk(byte: number, size: number): Buffer {
  return Buffer.alloc(size, byte);
}

describe("OutputMirror", () => {
  it("mirrors everything while under the cap", async () => {
    const mirror = new OutputMirror(path.join(dir, "job.log"));
    await mirror.append(chunk(1, 1000));
    await mirror.append(chunk(2, 1000));
    expect(mirror.state).toEqual({ totalBytes: 2000, truncated: false });
    const read = await mirror.read(0, 2000);
    expect(read).not.toBeNull();
    expect(read?.length).toBe(2000);
    expect(read?.[0]).toBe(1);
    expect(read?.[1999]).toBe(2);
  });

  it("keeps the first 10 MiB and the newest 10 MiB once 20 MiB is exceeded", async () => {
    const mirror = new OutputMirror(path.join(dir, "job.log"));
    const step = 1024 * 1024;
    for (let i = 0; i < 24; i += 1) {
      await mirror.append(chunk(i + 1, step)); // 24 MiB total
    }
    expect(mirror.state).toEqual({ totalBytes: 24 * step, truncated: true });
    const head = await mirror.read(0, MIRROR_HEAD_BYTES);
    expect(head).not.toBeNull();
    expect(head?.[0]).toBe(1); // first byte of the first MiB chunk
    expect(head?.[MIRROR_HEAD_BYTES - 1]).toBe(10); // end of the 10th chunk
    const tail = await mirror.read(24 * step - MIRROR_TAIL_BYTES, MIRROR_TAIL_BYTES);
    expect(tail).not.toBeNull();
    expect(tail?.[0]).toBe(15); // the tail starts at byte 14 MiB, inside chunk 15
    expect(tail?.[MIRROR_TAIL_BYTES - 1]).toBe(24);
    // The dropped middle is not covered.
    const gap = await mirror.read(MIRROR_HEAD_BYTES + 1, 1000);
    expect(gap).toBeNull();
    const onDisk = await fs.stat(path.join(dir, "job.log"));
    expect(onDisk.size).toBe(MIRROR_MAX_BYTES);
  });

  it("keeps appending to the tail after truncation", async () => {
    const mirror = new OutputMirror(path.join(dir, "job.log"));
    const step = 1024 * 1024;
    for (let i = 0; i < 21; i += 1) {
      await mirror.append(chunk(i + 1, step));
    }
    await mirror.append(chunk(99, 500));
    const tail = await mirror.read(21 * step + 500 - 500, 500);
    expect(tail?.[0]).toBe(99);
    expect(mirror.state.totalBytes).toBe(21 * step + 500);
  });

  it("resumes from a persisted state and serves reads from disk", async () => {
    const file = path.join(dir, "job.log");
    const first = new OutputMirror(file);
    const step = 1024 * 1024;
    for (let i = 0; i < 22; i += 1) {
      await first.append(chunk(i + 1, step));
    }
    const resumed = new OutputMirror(file, { totalBytes: 22 * step, truncated: true });
    const head = await resumed.read(0, 10);
    expect(head?.[0]).toBe(1);
    const tail = await resumed.read(22 * step - 10, 10);
    expect(tail?.[9]).toBe(22);
    const missing = await resumed.read(MIRROR_HEAD_BYTES + 5, 10);
    expect(missing).toBeNull();
  });
});
