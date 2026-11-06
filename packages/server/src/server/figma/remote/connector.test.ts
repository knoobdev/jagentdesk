/**
 * The ADR-0040 remote write connector on the Codex app-server native MCP transport,
 * driven by a fake RPC client: sequence, zero turns, observed-only status, bounded
 * enforcement (64 KiB UTF-8), inventory fail-closed, elicitation clear-fail, and
 * process-generation guards on late callbacks.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pino from "pino";
import { CodexAppServerRpcError } from "../../agent/providers/codex/app-server-transport.js";
import {
  FigmaRemoteConnector,
  FIGMA_REMOTE_ENDPOINT,
  FIGMA_REMOTE_MAX_CODE_BYTES,
  validateFigmaAuthorizationUrl,
  type NativeMcpRpcClient,
} from "./connector.js";

const logger = pino({ level: "silent" });

interface RecordedRequest {
  method: string;
  params?: unknown;
}

type Responder = (params: unknown) => unknown;

class FakeNativeClient implements NativeMcpRpcClient {
  readonly requests: RecordedRequest[] = [];
  private readonly responders = new Map<string, Responder>();
  private readonly requestHandlers = new Map<string, (params: unknown) => unknown>();
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private terminationHandler: ((error: Error) => void) | null = null;
  private readonly pendingToolCalls: {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  }[] = [];
  private deferCalls = false;
  disposed = false;

  on(method: string, responder: Responder): void {
    this.responders.set(method, responder);
  }

  /** Hold `mcpServer/tool/call` promises until the test resolves them (late-callback tests). */
  deferToolCalls(): void {
    this.deferCalls = true;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "mcpServer/tool/call" && this.deferCalls) {
      return new Promise((resolve, reject) => {
        this.pendingToolCalls.push({ resolve, reject });
      });
    }
    const responder = this.responders.get(method);
    if (!responder) throw new Error(`unhandled native method ${method}`);
    return responder(params);
  }

  resolveToolCall(value: unknown): void {
    const call = this.pendingToolCalls.shift();
    if (!call) throw new Error("no tool call in flight");
    call.resolve(value);
  }

  get inFlightToolCalls(): number {
    return this.pendingToolCalls.length;
  }

  notify(method: string, params?: unknown): void {
    this.requests.push({ method, params });
  }

  setRequestHandler(method: string, handler: (params: unknown) => unknown): void {
    this.requestHandlers.set(method, handler);
  }

  setNotificationHandler(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  setUnexpectedTerminationHandler(handler: (error: Error) => void): void {
    this.terminationHandler = handler;
  }

  emitNotification(method: string, params: unknown): void {
    this.notificationHandler?.(method, params);
  }

  elicit(params: unknown): unknown {
    const handler = this.requestHandlers.get("mcpServer/elicitation/request");
    if (!handler) throw new Error("connector registered no elicitation responder");
    return handler(params);
  }

  terminate(): void {
    this.terminationHandler?.(new Error("Codex app-server exited"));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    // Faithful to CodexAppServerClient: dispose rejects in-flight requests.
    while (this.pendingToolCalls.length)
      this.pendingToolCalls.shift()?.reject(new Error("Codex app-server exited"));
  }
}

const USE_FIGMA_TOOL = {
  inputSchema: {
    type: "object",
    properties: { fileKey: { type: "string" }, code: { type: "string" }, description: {} },
    required: ["fileKey", "code"],
  },
};
const GET_METADATA_TOOL = {
  inputSchema: { type: "object", properties: { fileKey: { type: "string" } } },
};

function connectedInventory(
  tools: Record<string, unknown> = { use_figma: USE_FIGMA_TOOL, get_metadata: GET_METADATA_TOOL },
): unknown {
  return { data: [{ name: "figma", runtimeStatus: "connected", authStatus: "oAuth", tools }] };
}

function notLoggedInInventory(): unknown {
  return {
    data: [{ name: "figma", runtimeStatus: "starting", authStatus: "notLoggedIn", tools: {} }],
  };
}

let home: string;
let client: FakeNativeClient;
let spawnCount: number;

function makeConnector(): FigmaRemoteConnector {
  client = new FakeNativeClient();
  client.on("initialize", () => ({}));
  client.on("thread/start", () => ({ thread: { id: "thr-1" } }));
  client.on("mcpServerStatus/list", () => connectedInventory());
  client.on("mcpServer/oauth/login", () => ({
    authorizationUrl: "https://www.figma.com/oauth/abc",
  }));
  spawnCount = 0;
  const connector = new FigmaRemoteConnector({
    jagentdeskHome: home,
    logger,
    createClient: async () => {
      spawnCount++;
      return client;
    },
  });
  return connector;
}

/** Script auto-resolved tool replies in arrival order (write reply, then readback reply). */
function scriptToolReplies(replies: unknown[]): void {
  let index = 0;
  client.on("mcpServer/tool/call", () => replies[index++] ?? { content: [] });
}

async function connectedConnector(): Promise<FigmaRemoteConnector> {
  const connector = makeConnector();
  await connector.authBegin();
  return connector;
}

async function settle(ms = 5): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function toolCallRequests(): RecordedRequest[] {
  return client.requests.filter((request) => request.method === "mcpServer/tool/call");
}

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "jad-figma-remote-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("enabled flag (private figma/remote.json, default off)", () => {
  it("reports disconnected without spawning the app-server or opening OAuth", async () => {
    const connector = makeConnector();
    expect(await connector.getStatus()).toEqual({ state: "disconnected" });
    expect(spawnCount).toBe(0);
    expect(client.requests).toEqual([]);
  });

  it("persists enable/disable and a fresh connector reloads the flag", async () => {
    const connector = await connectedConnector();
    expect(JSON.parse(readFileSync(path.join(home, "figma", "remote.json"), "utf8"))).toEqual({
      enabled: true,
    });
    await connector.disconnect();
    expect(JSON.parse(readFileSync(path.join(home, "figma", "remote.json"), "utf8"))).toEqual({
      enabled: false,
    });
    expect(client.disposed).toBe(true);
    const reloaded = makeConnector();
    expect(await reloaded.getStatus()).toEqual({ state: "disconnected" });
    expect(spawnCount).toBe(0);
  });
});

describe("native sequence", () => {
  it("drives initialize/thread-start/status only — zero turns, ephemeral, official endpoint", async () => {
    const connector = await connectedConnector();
    expect(client.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "mcpServerStatus/list",
    ]);
    expect(client.requests.filter((request) => request.method.startsWith("turn/"))).toEqual([]);
    const threadStart = client.requests.find((request) => request.method === "thread/start");
    expect(threadStart?.params).toMatchObject({
      ephemeral: true,
      sandbox: "read-only",
      approvalPolicy: "never",
      config: {
        mcp_servers: {
          figma: { url: FIGMA_REMOTE_ENDPOINT, default_tools_approval_mode: "auto" },
        },
      },
    });
    const threadParams = threadStart?.params as { model?: string } | undefined;
    expect(threadParams?.model).toBeUndefined();
    expect(await connector.getStatus()).toMatchObject({ state: "connected" });
  });

  it("reports needs_auth from the actual notLoggedIn status and returns a validated Figma URL", async () => {
    const connector = makeConnector();
    client.on("mcpServerStatus/list", () => notLoggedInInventory());
    const begun = await connector.authBegin();
    expect(begun.status.state).toBe("needs_auth");
    expect(begun.authorizationUrl).toBe("https://www.figma.com/oauth/abc");
    expect(
      client.requests.find((request) => request.method === "mcpServer/oauth/login")?.params,
    ).toMatchObject({ threadId: "thr-1", name: "figma" });
    await expect(connector.execute({ fileKey: "FK", code: "x", description: "d" })).rejects.toThrow(
      /Connect editing/,
    );
  });

  it("advances to connected only after the native oauthLogin/completed event re-reads status", async () => {
    const connector = makeConnector();
    client.on("mcpServerStatus/list", () => notLoggedInInventory());
    await connector.authBegin();
    expect(await connector.getStatus()).toMatchObject({ state: "needs_auth" });
    client.on("mcpServerStatus/list", () => connectedInventory());
    client.emitNotification("mcpServer/oauthLogin/completed", { name: "figma" });
    await settle();
    expect(await connector.getStatus()).toMatchObject({ state: "connected" });
  });

  it("marks an unsupported transport unavailable and asks for a Codex update", async () => {
    const connector = makeConnector();
    client.on("thread/start", () => {
      throw new CodexAppServerRpcError("Method not found", -32601);
    });
    const begun = await connector.authBegin();
    expect(begun.status.state).toBe("unavailable");
    expect(begun.status.message).toMatch(/update Codex/i);
  });
});

describe("authorization URL validation", () => {
  it("accepts only official Figma HTTPS URLs", () => {
    expect(validateFigmaAuthorizationUrl("https://www.figma.com/oauth/abc")).toBe(
      "https://www.figma.com/oauth/abc",
    );
    expect(validateFigmaAuthorizationUrl("http://www.figma.com/oauth")).toBeUndefined();
    expect(validateFigmaAuthorizationUrl("https://example.com/oauth")).toBeUndefined();
    expect(validateFigmaAuthorizationUrl("https://figma.com.evil.local/x")).toBeUndefined();
    expect(validateFigmaAuthorizationUrl(undefined)).toBeUndefined();
  });
});

describe("execute", () => {
  it("calls use_figma once with the server-injected fileKey and skill, then reads back metadata", async () => {
    const connector = await connectedConnector();
    scriptToolReplies([
      { content: [{ type: "text", text: "edited 1:2" }] },
      { content: [], structuredContent: { version: "171:9" } },
    ]);
    const outcome = await connector.execute({
      fileKey: "FK123",
      code: "figma.currentPage.name = 'x'",
      description: "rename page",
    });
    const toolCalls = toolCallRequests();
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.params).toEqual({
      threadId: "thr-1",
      server: "figma",
      tool: "use_figma",
      arguments: {
        fileKey: "FK123",
        code: "figma.currentPage.name = 'x'",
        description: "rename page",
        skillNames: "figma-use",
      },
    });
    expect(toolCalls[1]?.params).toMatchObject({ tool: "get_metadata" });
    expect(outcome.readbackAvailable).toBe(true);
    expect(outcome.readback?.structuredContent).toEqual({ version: "171:9" });
  });

  it("enforces 64 KiB UTF-8 without touching the native side", async () => {
    const connector = await connectedConnector();
    const over = "é".repeat(FIGMA_REMOTE_MAX_CODE_BYTES); // 2 bytes each
    await expect(
      connector.execute({ fileKey: "FK", code: over, description: "d" }),
    ).rejects.toThrow(/UTF-8 bytes/);
    expect(toolCallRequests()).toHaveLength(0);
    scriptToolReplies([{ content: [] }, { content: [] }]);
    await expect(
      connector.execute({
        fileKey: "FK",
        code: "x".repeat(FIGMA_REMOTE_MAX_CODE_BYTES),
        description: "d",
      }),
    ).resolves.toMatchObject({ readbackAvailable: true });
  });

  it("rejects empty or oversized descriptions before any call", async () => {
    const connector = await connectedConnector();
    await expect(connector.execute({ fileKey: "FK", code: "x", description: " " })).rejects.toThrow(
      /description/,
    );
    await expect(
      connector.execute({ fileKey: "FK", code: "x", description: "d".repeat(1001) }),
    ).rejects.toThrow(/description/);
    expect(toolCallRequests()).toHaveLength(0);
  });

  it("fails closed when the actual inventory lacks use_figma fileKey/code support", async () => {
    const connector = makeConnector();
    client.on("mcpServerStatus/list", () => connectedInventory({ use_figma: {} }));
    await connector.authBegin();
    await expect(connector.execute({ fileKey: "FK", code: "x", description: "d" })).rejects.toThrow(
      /does not advertise use_figma/,
    );
    expect(toolCallRequests()).toHaveLength(0);
  });

  it("surfaces an errored readback as unverified without throwing the write away", async () => {
    const connector = await connectedConnector();
    client.on("mcpServer/tool/call", (params) =>
      (params as { tool: string }).tool === "get_metadata"
        ? { content: [{ type: "text", text: "meta failed" }], isError: true }
        : { content: [{ type: "text", text: "ok" }] },
    );
    const outcome = await connector.execute({ fileKey: "FK", code: "x", description: "d" });
    expect(outcome.result.isError).toBeFalsy();
    expect(outcome.readbackAvailable).toBe(false);
    expect(outcome.readback?.isError).toBe(true);
  });

  it("skips the readback and never retries when the tool reply itself errored", async () => {
    const connector = await connectedConnector();
    scriptToolReplies([{ content: [{ type: "text", text: "no seat" }], isError: true }]);
    const outcome = await connector.execute({ fileKey: "FK", code: "x", description: "d" });
    expect(outcome.result.isError).toBe(true);
    expect(outcome.readbackAvailable).toBe(false);
    expect(toolCallRequests()).toHaveLength(1);
  });
});

describe("elicitation (native approval channel)", () => {
  it("declines an unhandled elicitation and fails the execute clear", async () => {
    const connector = await connectedConnector();
    client.deferToolCalls();
    const pending = connector.execute({ fileKey: "FK", code: "x", description: "d" });
    await settle();
    expect(client.inFlightToolCalls).toBe(1);
    expect(client.elicit({ message: "approve this?" })).toEqual({
      action: "decline",
      content: null,
    });
    client.resolveToolCall({ content: [{ type: "text", text: "applied?" }] });
    await expect(pending).rejects.toThrow(/approval/);
    await expect(pending).rejects.toThrow(/unverified/);
  });

  it("counts stray elicitations outside calls without failing anything", async () => {
    const connector = await connectedConnector();
    expect(connector.elicitationCount).toBe(0);
    expect(client.elicit({ message: "hi" })).toEqual({ action: "decline", content: null });
    expect(connector.elicitationCount).toBe(1);
  });
});

describe("process generation guards", () => {
  it("a late callback after disconnect surfaces unverified and is not auto-retried", async () => {
    const connector = await connectedConnector();
    client.deferToolCalls();
    const pending = connector.execute({ fileKey: "FK", code: "x", description: "d" });
    await settle();
    await connector.disconnect();
    await expect(pending).rejects.toThrow(/restarted during the write/);
    expect(toolCallRequests()).toHaveLength(1); // no second attempt, ever
    await expect(connector.execute({ fileKey: "FK", code: "x", description: "d" })).rejects.toThrow(
      /is disconnected/,
    );
  });

  it("unexpected termination sets error while enabled and blocks further calls", async () => {
    const connector = await connectedConnector();
    client.terminate();
    expect(await connector.getStatus()).toMatchObject({ state: "error" });
    await expect(connector.execute({ fileKey: "FK", code: "x", description: "d" })).rejects.toThrow(
      /Figma remote editing is error/,
    );
  });
});

describe("identity", () => {
  it("exposes whoami text when the actual inventory offers it, best-effort", async () => {
    const connector = makeConnector();
    client.on("mcpServerStatus/list", () =>
      connectedInventory({
        use_figma: USE_FIGMA_TOOL,
        get_metadata: GET_METADATA_TOOL,
        whoami: { inputSchema: { type: "object", properties: {} } },
      }),
    );
    client.on("mcpServer/tool/call", (params) =>
      (params as { tool: string }).tool === "whoami"
        ? { content: [{ type: "text", text: "user: Jane Doe" }] }
        : { content: [], structuredContent: { version: "1" } },
    );
    await connector.authBegin();
    await settle();
    expect(await connector.getStatus()).toMatchObject({
      state: "connected",
      identityText: "user: Jane Doe",
    });
  });
});
