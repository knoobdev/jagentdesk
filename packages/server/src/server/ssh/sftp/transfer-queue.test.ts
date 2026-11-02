import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SshTransfer } from "@jagentdesk/protocol/ssh/sftp-schemas";
import { LocalFileSystem, formatPermissions, parseOctalMode } from "./file-system.js";
import { TransferQueue, keepBothName } from "./transfer-queue.js";

const daemon = { kind: "daemon" } as const;

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("file-system helpers", () => {
  it("formats permission bits like ls -l", () => {
    expect(formatPermissions(0o755)).toBe("rwxr-xr-x");
    expect(formatPermissions(0o640)).toBe("rw-r-----");
    expect(parseOctalMode("0750")).toBe(0o750);
  });

  it("names keep-both copies before the extension", () => {
    expect(keepBothName("report.tar.gz", 1)).toBe("report.tar (1).gz");
    expect(keepBothName("notes.txt", 2)).toBe("notes (2).txt");
    expect(keepBothName(".bashrc", 1)).toBe(".bashrc (1)");
    expect(keepBothName("Makefile", 3)).toBe("Makefile (3)");
  });
});

describe("TransferQueue on the daemon file system", () => {
  let root: string;
  let events: SshTransfer[];
  let queue: TransferQueue;
  let onEvent: ((transfer: SshTransfer) => void) | null;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "jad-sftp-queue-"));
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "dst"));
    events = [];
    onEvent = null;
    const local = new LocalFileSystem();
    queue = new TransferQueue({
      openEndpoint: async () => ({ fs: local, release: () => undefined }),
      onChange: (transfer) => {
        events.push(transfer);
        onEvent?.(transfer);
      },
      progressIntervalMs: 0,
    });
  });

  afterEach(async () => {
    queue.dispose();
    await rm(root, { recursive: true, force: true });
  });

  it("copies a directory tree and reports file and byte totals", async () => {
    await mkdir(path.join(root, "src", "site", "assets"), { recursive: true });
    await writeFile(path.join(root, "src", "site", "index.html"), "<h1>ok</h1>");
    await writeFile(path.join(root, "src", "site", "assets", "app.js"), "console.info(1)");

    const queued = await queue.enqueue({
      source: daemon,
      sourcePath: path.join(root, "src", "site"),
      target: daemon,
      targetDir: path.join(root, "dst"),
    });
    const done = await queue.settled(queued.id);

    expect(done).toMatchObject({
      kind: "directory",
      status: "completed",
      targetPath: path.join(root, "dst", "site"),
      filesTotal: 2,
      filesDone: 2,
      bytesTotal: 26,
      bytesTransferred: 26,
    });
    expect(await readFile(path.join(root, "dst", "site", "assets", "app.js"), "utf8")).toBe(
      "console.info(1)",
    );
  });

  it("stops in conflict without a policy, then resolves keep-both to a new name", async () => {
    await writeFile(path.join(root, "src", "a.txt"), "new");
    await writeFile(path.join(root, "dst", "a.txt"), "old");

    const queued = await queue.enqueue({
      source: daemon,
      sourcePath: path.join(root, "src", "a.txt"),
      target: daemon,
      targetDir: path.join(root, "dst"),
    });
    expect((await queue.settled(queued.id)).status).toBe("conflict");

    queue.start(queued.id, "keep-both");
    const done = await queue.settled(queued.id);

    expect(done.status).toBe("completed");
    expect(done.targetPath).toBe(path.join(root, "dst", "a (1).txt"));
    expect((await readdir(path.join(root, "dst"))).sort()).toEqual(["a (1).txt", "a.txt"]);
    expect(await readFile(path.join(root, "dst", "a.txt"), "utf8")).toBe("old");
    expect(await readFile(path.join(root, "dst", "a (1).txt"), "utf8")).toBe("new");
  });

  it("skips or replaces an existing target as the policy says", async () => {
    await writeFile(path.join(root, "src", "a.txt"), "new");
    await writeFile(path.join(root, "dst", "a.txt"), "old");
    const input = {
      source: daemon,
      sourcePath: path.join(root, "src", "a.txt"),
      target: daemon,
      targetDir: path.join(root, "dst"),
    };

    const skipped = await queue.settled((await queue.enqueue({ ...input, conflict: "skip" })).id);
    expect(skipped.status).toBe("skipped");
    expect(await readFile(path.join(root, "dst", "a.txt"), "utf8")).toBe("old");

    const replaced = await queue.settled(
      (await queue.enqueue({ ...input, conflict: "replace" })).id,
    );
    expect(replaced.status).toBe("completed");
    expect(await readFile(path.join(root, "dst", "a.txt"), "utf8")).toBe("new");
  });

  it("pauses mid-file and resumes from the target offset to an identical file", async () => {
    const data = randomBytes(8 * 1024 * 1024);
    await writeFile(path.join(root, "src", "big.bin"), data);
    const queued = await queue.enqueue({
      source: daemon,
      sourcePath: path.join(root, "src", "big.bin"),
      target: daemon,
      targetDir: path.join(root, "dst"),
    });
    onEvent = (transfer) => {
      if (transfer.status === "running" && transfer.bytesTransferred >= data.length / 2) {
        onEvent = null;
        queue.pause(queued.id);
      }
    };

    const paused = await queue.settled(queued.id);
    expect(paused.status).toBe("paused");
    expect(paused.bytesTransferred).toBeGreaterThanOrEqual(data.length / 2);
    expect(paused.bytesTransferred).toBeLessThan(data.length);

    queue.resume(queued.id);
    const done = await queue.settled(queued.id);

    expect(done.status).toBe("completed");
    expect(done.bytesTransferred).toBe(data.length);
    expect(sha256(await readFile(path.join(root, "dst", "big.bin")))).toBe(sha256(data));
  });

  it("cancel removes the partial file and a retry copies it from the start", async () => {
    const data = randomBytes(4 * 1024 * 1024);
    await writeFile(path.join(root, "src", "big.bin"), data);
    const queued = await queue.enqueue({
      source: daemon,
      sourcePath: path.join(root, "src", "big.bin"),
      target: daemon,
      targetDir: path.join(root, "dst"),
    });
    onEvent = (transfer) => {
      if (transfer.status === "running" && transfer.bytesTransferred > 0) {
        onEvent = null;
        queue.cancel(queued.id);
      }
    };

    expect((await queue.settled(queued.id)).status).toBe("cancelled");
    expect(await readdir(path.join(root, "dst"))).toEqual([]);

    queue.start(queued.id);
    expect((await queue.settled(queued.id)).status).toBe("completed");
    expect(sha256(await readFile(path.join(root, "dst", "big.bin")))).toBe(sha256(data));
  });

  it("refuses to copy a folder into itself", async () => {
    await mkdir(path.join(root, "src", "inner"));
    await expect(
      queue.enqueue({
        source: daemon,
        sourcePath: path.join(root, "src"),
        target: daemon,
        targetDir: path.join(root, "src", "inner"),
      }),
    ).rejects.toMatchObject({ code: "invalid_target" });
  });

  it("fails with not_found when the source is missing", async () => {
    await expect(
      queue.enqueue({
        source: daemon,
        sourcePath: path.join(root, "src", "missing.txt"),
        target: daemon,
        targetDir: path.join(root, "dst"),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(events).toEqual([]);
  });
});
