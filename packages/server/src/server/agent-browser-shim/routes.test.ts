import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import pino from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BrowserToolsExecuteInput } from "../browser-tools/broker.js";
import type { BrowserToolsResponsePayload } from "../browser-tools/errors.js";
import {
  AGENT_BROWSER_OPEN_ROUTE,
  AGENT_FILES_ROUTE,
  AgentFileShares,
  createAgentBrowserOpenRouteHandler,
  createAgentFilesRouteHandler,
} from "./routes.js";
import { NO_BROWSER_HOST_MESSAGE } from "./shim-script.js";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "route-test-token";

function newTabOk(requestId: string): BrowserToolsResponsePayload {
  return {
    requestId,
    ok: true,
    result: {
      command: "new_tab",
      browserId: "1700000000000-abc",
      browserHost: { browserHostId: "h1", label: "Desktop", canOpenTabs: true },
    },
  } as unknown as BrowserToolsResponsePayload;
}

function failure(code: string, extra: Record<string, unknown> = {}): BrowserToolsResponsePayload {
  return {
    requestId: "r",
    ok: false,
    error: { code, message: `failed: ${code}`, retryable: false, ...extra },
  } as unknown as BrowserToolsResponsePayload;
}

describe("agent browser open and file routes", () => {
  let root: string;
  let server: Server;
  let base: string;
  const executed: BrowserToolsExecuteInput[] = [];
  let replies: BrowserToolsResponsePayload[] = [];

  beforeAll(async () => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "agent-browser-routes-")));
    mkdirSync(path.join(root, "site", "assets"), { recursive: true });
    writeFileSync(path.join(root, "site", "report.html"), "<link href=assets/a.css><h1>R</h1>");
    writeFileSync(path.join(root, "site", "assets", "a.css"), "h1{}");
    writeFileSync(path.join(root, "secret.txt"), "outside");
    writeFileSync(path.join(root, "site", "data.xlsx"), "x");
    const app = express();
    const shares = new AgentFileShares();
    app.post(
      AGENT_BROWSER_OPEN_ROUTE,
      express.json(),
      createAgentBrowserOpenRouteHandler({
        token: TOKEN,
        resolveAgent: (agentId) =>
          agentId === AGENT_ID ? { cwd: root, workspaceId: "ws-1" } : null,
        execute: async (input) => {
          executed.push(input);
          return replies.shift() ?? newTabOk("r");
        },
        shares,
        baseUrl: () => base,
        logger: pino({ level: "silent" }),
      }),
    );
    app.use(AGENT_FILES_ROUTE, createAgentFilesRouteHandler(shares));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    executed.length = 0;
    replies = [];
  });

  function post(body: unknown, token: string | null = TOKEN) {
    return fetch(`${base}${AGENT_BROWSER_OPEN_ROUTE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it("needs the agent token", async () => {
    const response = await post({ agentId: AGENT_ID, target: { url: "https://example.org" } }, "x");
    expect(response.status).toBe(401);
    expect(executed).toEqual([]);
  });

  it("opens a URL as a new tab in the agent's workspace, like browser_new_tab", async () => {
    const response = await post({ agentId: AGENT_ID, target: { url: "https://example.org" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, url: "https://example.org" });
    expect(executed).toEqual([
      {
        agentId: AGENT_ID,
        cwd: root,
        workspaceId: "ws-1",
        command: { command: "new_tab", args: { url: "https://example.org" } },
      },
    ]);
  });

  it("refuses an unknown agent", async () => {
    const response = await post({
      agentId: "99999999-2222-4333-8444-555555555555",
      target: { url: "https://example.org" },
    });
    expect(response.status).toBe(404);
  });

  it("with no browser host answers with the spec message", async () => {
    replies = [failure("browser_no_host")];
    const response = await post({ agentId: AGENT_ID, target: { url: "https://example.org" } });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, message: NO_BROWSER_HOST_MESSAGE });
  });

  it("picks the first host that can open tabs when several are connected", async () => {
    replies = [
      failure("browser_host_ambiguous", {
        browserHosts: [
          { browserHostId: "h0", label: "Mobile", canOpenTabs: false },
          { browserHostId: "h2", label: "Desktop", canOpenTabs: true },
        ],
      }),
    ];
    const response = await post({ agentId: AGENT_ID, target: { url: "https://example.org" } });
    expect(response.status).toBe(200);
    expect(executed.map((entry) => entry.browserHostId)).toEqual([undefined, "h2"]);
  });

  it("serves an opened local page and its relative assets over loopback, nothing outside", async () => {
    const response = await post({
      agentId: AGENT_ID,
      target: { path: path.join(root, "site", "report.html") },
    });
    expect(response.status).toBe(200);
    const { url } = (await response.json()) as { url: string };
    expect(url).toMatch(new RegExp(`^${base}${AGENT_FILES_ROUTE}/[0-9a-f]{32}/report\\.html$`));
    expect(executed[0]?.command).toEqual({ command: "new_tab", args: { url } });

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("<h1>R</h1>");
    const asset = await fetch(url.replace("report.html", "assets/a.css"));
    expect(asset.status).toBe(200);
    const outside = await fetch(url.replace("report.html", "..%2Fsecret.txt"));
    expect(outside.status).toBe(404);
    const unknownToken = await fetch(url.replace(/\/[0-9a-f]{32}\//, `/${"0".repeat(32)}/`));
    expect(unknownToken.status).toBe(404);
  });

  it("does not open local files that are not web pages", async () => {
    const response = await post({
      agentId: AGENT_ID,
      target: { path: path.join(root, "site", "data.xlsx") },
    });
    expect(response.status).toBe(400);
    expect(executed).toEqual([]);
  });
});
