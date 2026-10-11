import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
} from "fs";
import { once } from "node:events";
import { get } from "node:http";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Linux exposes the real open descriptors without replacing file or HTTP methods.
function openDownloadDescriptors(filePath: string): string[] {
  const realFilePath = realpathSync(filePath);
  return readdirSync("/proc/self/fd").filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === realFilePath;
    } catch (error) {
      // A descriptor can close between listing it and reading its link.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
}

async function expectDownloadClosed(filePath: string): Promise<void> {
  await expect.poll(() => openDownloadDescriptors(filePath)).toEqual([]);
}

async function cancelDownloadAfterFirstChunk(url: string): Promise<void> {
  const request = get(url);
  try {
    const [response] = await once(request, "response");
    expect(response.statusCode).toBe(200);
    const [chunk] = await once(response, "data");
    expect(chunk.length).toBeGreaterThan(0);
    expect(chunk.length).toBeLessThan(64 * 1024 * 1024);
    const closed = once(response, "close");
    response.destroy();
    request.destroy();
    await closed;
  } finally {
    request.destroy();
  }
}

// Use gpt-5.4-mini with low thinking preset for faster test execution
const CODEX_TEST_MODEL = "gpt-5.4-mini";
const CODEX_TEST_THINKING_OPTION_ID = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("file download tokens", () => {
    test.skipIf(process.platform !== "linux")(
      "releases file descriptors after repeated HTTP download cancellations",
      async () => {
        const directory = tmpCwd();
        const cwd = path.join(directory, "linked-files");
        symlinkSync(mkdtempSync(path.join(directory, "files-")), cwd, "dir");
        const filePath = path.join(cwd, "large.bin");
        const fileSize = 64 * 1024 * 1024;
        writeFileSync(filePath, Buffer.alloc(fileSize));
        try {
          const completedToken = await ctx.client.requestDownloadToken(cwd, "large.bin");
          expect(completedToken.error).toBeNull();
          const completed = await fetch(
            `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${completedToken.token}`,
          );
          expect(completed.status).toBe(200);
          expect((await completed.arrayBuffer()).byteLength).toBe(fileSize);
          await expectDownloadClosed(filePath);

          for (let attempt = 0; attempt < 3; attempt++) {
            const token = await ctx.client.requestDownloadToken(cwd, "large.bin");
            expect(token.error).toBeNull();
            await cancelDownloadAfterFirstChunk(
              `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${token.token}`,
            );
            await expectDownloadClosed(filePath);
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      },
    );

    test("issues token over WS and downloads via HTTP", async () => {
      const cwd = tmpCwd();
      const filePath = path.join(cwd, "download.txt");
      const fileContents = "download test payload";
      writeFileSync(filePath, fileContents, "utf-8");

      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Download Token Test Agent",
      });

      expect(agent.id).toBeTruthy();

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "download.txt");

      expect(tokenResponse.error).toBeNull();
      expect(tokenResponse.token).toBeTruthy();
      expect(tokenResponse.fileName).toBe("download.txt");

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(tokenResponse.mimeType);
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("download.txt");

      const body = await response.text();
      expect(body).toBe(fileContents);

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("rejects invalid token", async () => {
      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=invalid-token`,
      );

      expect(response.status).toBe(403);
    }, 30000);

    test("rejects expired token", async () => {
      await ctx.cleanup();
      ctx = await createDaemonTestContext({ downloadTokenTtlMs: 50 });

      const cwd = tmpCwd();
      const filePath = path.join(cwd, "expired.txt");
      writeFileSync(filePath, "expired", "utf-8");

      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Expired Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "expired.txt");

      expect(tokenResponse.error).toBeNull();
      expect(tokenResponse.token).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 150));

      const response = await fetch(
        `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
      );

      expect(response.status).toBe(403);

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);

    test("rejects paths outside the workspace cwd", async () => {
      const cwd = tmpCwd();
      await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        thinkingOptionId: CODEX_TEST_THINKING_OPTION_ID,
        cwd,
        title: "Outside Path Token Test Agent",
      });

      const tokenResponse = await ctx.client.requestDownloadToken(cwd, "../outside.txt");

      expect(tokenResponse.token).toBeNull();
      expect(tokenResponse.error).toBeTruthy();

      rmSync(cwd, { recursive: true, force: true });
    }, 60000);
  });
});
