import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { BackgroundWorkOutputSource } from "./index.js";
import {
  followBackgroundWorkOutput,
  OUTPUT_TAIL_BYTES,
  type BackgroundWorkOutputChunk,
  type StopFollowing,
} from "./output-stream.js";

let root: string;
let stops: StopFollowing[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bg-output-"));
  stops = [];
});

afterEach(() => {
  for (const stop of stops) stop();
  rmSync(root, { recursive: true, force: true });
});

function fileSource(path: string, roots: string[] = [root]): BackgroundWorkOutputSource {
  return { type: "file", locate: async () => ({ path, roots }) };
}

async function follow(
  source: BackgroundWorkOutputSource,
  options: { bytesPerSecond?: number; pollMs?: number } = {},
) {
  const chunks: BackgroundWorkOutputChunk[] = [];
  const errors: Error[] = [];
  const stop = await followBackgroundWorkOutput({
    source,
    onChunk: (chunk) => chunks.push(chunk),
    onError: (error) => errors.push(error),
    pollMs: options.pollMs ?? 50,
    ...(options.bytesPerSecond ? { bytesPerSecond: options.bytesPerSecond } : {}),
  });
  stops.push(stop);
  return { chunks, errors, stop, text: () => chunks.map((chunk) => chunk.chunk).join("") };
}

describe("followBackgroundWorkOutput with a file", () => {
  test("sends the whole short output first, then what is appended", async () => {
    const path = join(root, "task.output");
    writeFileSync(path, "line-1\n");
    const { chunks, text } = await follow(fileSource(path));

    expect(chunks).toEqual([{ chunk: "line-1\n", offset: 0, nextOffset: 7, reset: true }]);

    appendFileSync(path, "line-2\n\u001b[31mred\u001b[0m\n");
    await vi.waitFor(() => expect(text()).toBe("line-1\nline-2\n\u001b[31mred\u001b[0m\n"), {
      timeout: 1000,
    });
    expect(chunks[1]).toMatchObject({ offset: 7, reset: false });
  });

  test("opens with at most the last 256 KiB, starting on a whole character", async () => {
    const path = join(root, "big.output");
    // 300 KiB of 3-byte characters: the tail cut lands inside one.
    writeFileSync(path, "€".repeat(100 * 1024));
    const { chunks } = await follow(fileSource(path));

    const [first] = chunks;
    expect(first.reset).toBe(true);
    expect(first.nextOffset).toBe(300 * 1024);
    expect(Buffer.byteLength(first.chunk)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(first.chunk).toMatch(/^€+$/);
    expect(first.offset + Buffer.byteLength(first.chunk)).toBe(300 * 1024);
  });

  test("pushes no more than the rate allows per second", async () => {
    const path = join(root, "fast.output");
    writeFileSync(path, "");
    const { chunks, text } = await follow(fileSource(path), { bytesPerSecond: 1000 });

    appendFileSync(path, "x".repeat(3000));
    await vi.waitFor(() => expect(text().length).toBeGreaterThan(0), { timeout: 1000 });
    const firstPush = chunks[1];
    expect(Buffer.byteLength(firstPush.chunk)).toBeLessThanOrEqual(1000);
    await vi.waitFor(() => expect(text().length).toBe(3000), { timeout: 4000 });
  });

  test("starts over from the tail when the file is truncated", async () => {
    const path = join(root, "rewritten.output");
    writeFileSync(path, "old output that is long\n");
    const { chunks } = await follow(fileSource(path));

    writeFileSync(path, "new\n");
    const sinceLastReset = () => {
      const last = chunks.findLastIndex((chunk) => chunk.reset);
      return last > 0
        ? chunks
            .slice(last)
            .map((chunk) => chunk.chunk)
            .join("")
        : null;
    };
    await vi.waitFor(() => expect(sinceLastReset()).toBe("new\n"));
  });

  test("refuses a file outside the provider's folders", async () => {
    const outside = mkdtempSync(join(tmpdir(), "bg-output-outside-"));
    try {
      const path = join(outside, "secret.output");
      writeFileSync(path, "secret");
      await expect(follow(fileSource(path))).rejects.toThrow(/outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses a symlink that points out of the provider's folders", async () => {
    const outside = mkdtempSync(join(tmpdir(), "bg-output-outside-"));
    try {
      writeFileSync(join(outside, "secret"), "secret");
      mkdirSync(join(root, "tasks"));
      const link = join(root, "tasks", "b1.output");
      symlinkSync(join(outside, "secret"), link);
      await expect(follow(fileSource(link))).rejects.toThrow(/outside/);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses a source that cannot be located", async () => {
    await expect(follow({ type: "file", locate: async () => null })).rejects.toThrow(
      /not available/,
    );
  });
});

describe("followBackgroundWorkOutput with a provider reader", () => {
  test("reads the tail by cursor, then polls for more", async () => {
    let output = Buffer.from("one\ntwo\n");
    const source: BackgroundWorkOutputSource = {
      type: "reader",
      read: async ({ cursor, limit }) => {
        const bytes = output.subarray(cursor, cursor + limit);
        return { bytes, nextCursor: cursor + bytes.length, size: output.length };
      },
    };
    const { chunks, text } = await follow(source);
    expect(chunks[0]).toEqual({ chunk: "one\ntwo\n", offset: 0, nextOffset: 8, reset: true });

    output = Buffer.concat([output, Buffer.from("three\n")]);
    await vi.waitFor(() => expect(text()).toBe("one\ntwo\nthree\n"), { timeout: 1000 });
  });

  test("reports a reader that starts failing and stops following", async () => {
    let fail = false;
    const source: BackgroundWorkOutputSource = {
      type: "reader",
      read: async () => {
        if (fail) throw new Error("shell removed");
        return { bytes: new Uint8Array(), nextCursor: 0, size: 0 };
      },
    };
    const { errors } = await follow(source);
    fail = true;
    const messages = () => errors.map((error) => error.message);
    await vi.waitFor(() => expect(messages()).toEqual(["shell removed"]));
  });
});
