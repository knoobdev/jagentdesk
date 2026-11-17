import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
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
    test("lets a page on a loopback alias of the request's host and port fetch a download", async () => {
      const cwd = tmpCwd();
      writeFileSync(path.join(cwd, "download.bin"), "download bytes");
      try {
        // The web UI behind a remapped port (for example Docker -p 8080:6767): the page is at
        // http://127.0.0.1:8080 and the app sends the request to localhost:8080. The WebSocket
        // accepts this origin, so the download must as well.
        const token = await ctx.client.requestDownloadToken(cwd, "download.bin");
        const request = get({
          host: "127.0.0.1",
          port: ctx.daemon.port,
          path: `/api/files/download?token=${token.token}`,
          headers: { Host: "localhost:8080", Origin: "http://127.0.0.1:8080" },
        });
        const [response] = (await once(request, "response")) as [IncomingMessage];
        response.resume();
        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:8080");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

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
