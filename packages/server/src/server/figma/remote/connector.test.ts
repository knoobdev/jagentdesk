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
  FigmaRemoteOutcomeUnknownError,
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
  private deferOauth = false;
  private readonly pendingOauth: { resolve: (value: unknown) => void }[] = [];
  disposed = false;

  on(method: string, responder: Responder): void {
    this.responders.set(method, responder);
  }

  /** Hold `mcpServer/tool/call` promises until the test resolves them (late-callback tests). */
  deferToolCalls(): void {
    this.deferCalls = true;
  }

  /** Hold `mcpServer/oauth/login` promises so duplicate Connect taps race for one flow. */
  deferOauthLogin(): void {
    this.deferOauth = true;
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "mcpServer/tool/call" && this.deferCalls) {
      return new Promise((resolve, reject) => {
        this.pendingToolCalls.push({ resolve, reject });
      });
    }
    if (method === "mcpServer/oauth/login" && this.deferOauth) {
      return new Promise((resolve) => {
        this.pendingOauth.push({ resolve });
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

  resolveOauthLogin(value: unknown): void {
    const call = this.pendingOauth.shift();
    if (!call) throw new Error("no oauth login in flight");
    call.resolve(value);
  }

  get inFlightOauth(): number {
    return this.pendingOauth.length;
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

  it("accepts only the exact auth hosts, no userinfo, and 443 only", () => {
    expect(validateFigmaAuthorizationUrl("https://figma.com/oauth")).toBe(
      "https://figma.com/oauth",
    );
    expect(validateFigmaAuthorizationUrl("https://api.figma.com/oauth/xyz")).toBe(
      "https://api.figma.com/oauth/xyz",
    );
    // Arbitrary subdomains are not authority: only the listed hosts pass.
    expect(validateFigmaAuthorizationUrl("https://cdn.figma.com/oauth")).toBeUndefined();
    expect(validateFigmaAuthorizationUrl("https://user@figma.com/oauth")).toBeUndefined();
    expect(validateFigmaAuthorizationUrl("https://user:pw@figma.com/oauth")).toBeUndefined();
    expect(validateFigmaAuthorizationUrl("https://figma.com:8443/oauth")).toBeUndefined();
    // The WHATWG URL parser normalizes an explicit default port away.
    expect(validateFigmaAuthorizationUrl("https://figma.com:443/oauth")).toBe(
      "https://figma.com:443/oauth",
    );
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

// ── root-review regressions: lifecycle ownership races ─────────────────────────

/** A connector whose client factory is held by the test, so disconnects race the start. */
function makeGatedConnector(): {
  connector: FigmaRemoteConnector;
  releases: ((client: FakeNativeClient) => void)[];
  spawns: { count: number };
} {
  const releases: ((client: FakeNativeClient) => void)[] = [];
  const spawns = { count: 0 };
  const connector = new FigmaRemoteConnector({
    jagentdeskHome: home,
    logger,
    createClient: () =>
      new Promise<NativeMcpRpcClient>((resolve) => {
        spawns.count++;
        releases.push((fake) => {
          fake.on("initialize", () => ({}));
          fake.on("thread/start", () => ({ thread: { id: `thr-${spawns.count}` } }));
          fake.on("mcpServerStatus/list", () => connectedInventory());
          fake.on("mcpServer/oauth/login", () => ({
            authorizationUrl: "https://www.figma.com/oauth/abc",
          }));
          resolve(fake);
        });
      }),
  });
  return { connector, releases, spawns };
}

describe("disconnect racing a start (root review 1)", () => {
  it("a late-created client is disposed and never adopted as the live child", async () => {
    const { connector, releases, spawns } = makeGatedConnector();
    const begun = connector.authBegin();
    await settle();
    expect(spawns.count).toBe(1);
    await connector.disconnect(); // lands while createClient is still pending
    const late = new FakeNativeClient();
    releases[0]?.(late); // the factory finally delivers a child
    await begun;
    await settle();
    expect(late.disposed).toBe(true); // abandoned late child disposed, not leaked
    expect(await connector.getStatus()).toEqual({ state: "disconnected" });

    // An abandoned connect cannot block the next one: reconnect starts a genuinely new process.
    const again = connector.authBegin();
    await settle();
    expect(spawns.count).toBe(2);
    const second = new FakeNativeClient();
    releases[1]?.(second);
    await again;
    expect(await connector.getStatus()).toMatchObject({ state: "connected" });
    expect(second.disposed).toBe(false);
  });

  it("a createClient failure after disconnect does not overwrite newer state", async () => {
    const { connector, releases } = makeGatedConnector();
    const begun = connector.authBegin();
    await settle();
    await connector.disconnect();
    releases[0]?.(new FakeNativeClient()); // resolves the factory only after the disconnect
    await begun;
    // The late start must not stamp `unavailable`/`connecting` over the disconnected reset.
    expect(await connector.getStatus()).toEqual({ state: "disconnected" });
  });

  it("a disconnect while initialize/thread-start await leaves no live client pointer", async () => {
    const { connector, releases } = makeGatedConnector();
    const begun = connector.authBegin();
    await settle();
    const started = new FakeNativeClient();
    // Freeze the child after thread/start is delivered, before status is read.
    started.deferToolCalls();
    started.on("mcpServerStatus/list", async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return connectedInventory();
    });
    releases[0]?.(started);
    await connector.disconnect(); // lands mid-status while the start still owns nothing
    await begun;
    expect(await connector.getStatus()).toEqual({ state: "disconnected" });
  });
});

describe("authBegin ownership (root review 2)", () => {
  it("duplicate Connect/Continue share one native OAuth flow", async () => {
    const connector = makeConnector();
    client.on("mcpServerStatus/list", () => notLoggedInInventory());
    client.deferOauthLogin();
    const first = connector.authBegin();
    const second = connector.authBegin();
    await settle();
    expect(client.inFlightOauth).toBe(1); // not two stacked OAuth flows
    client.resolveOauthLogin({ authorizationUrl: "https://www.figma.com/oauth/abc" });
    const [a, b] = await Promise.all([first, second]);
    expect(a.authorizationUrl).toBe("https://www.figma.com/oauth/abc");
    expect(b.authorizationUrl).toBe("https://www.figma.com/oauth/abc");
    expect(
      client.requests.filter((request) => request.method === "mcpServer/oauth/login"),
    ).toHaveLength(1);
  });

  it("never returns an old URL when disconnect lands mid-OAuth", async () => {
    const connector = makeConnector();
    client.on("mcpServerStatus/list", () => notLoggedInInventory());
    client.deferOauthLogin();
    const begun = connector.authBegin();
    await settle();
    await connector.disconnect();
    client.resolveOauthLogin({ authorizationUrl: "https://www.figma.com/oauth/abc" });
    const result = await begun;
    expect(result.status).toEqual({ state: "disconnected" });
    expect(result.authorizationUrl).toBeUndefined();
  });

  it("a new Connect after a settled one starts a fresh flow (single-flight is not sticky)", async () => {
    const connector = await connectedConnector();
    await connector.authBegin();
    await connector.authBegin();
    expect(
      client.requests.filter((request) => request.method === "mcpServer/oauth/login"),
    ).toHaveLength(0); // connected state never re-OAuthes
  });
});

describe("tool-call serialization (root review 3)", () => {
  it("one in-flight native tool call at a time, even for concurrent executes", async () => {
    const connector = await connectedConnector();
    client.deferToolCalls();
    const a = connector.execute({ fileKey: "A", code: "x", description: "d" });
    const b = connector.execute({ fileKey: "B", code: "y", description: "d" });
    await settle();
    expect(client.inFlightToolCalls).toBe(1); // B queues behind A; two agents never interleave
    // The serialized lane is strict FIFO: A.use_figma, B.use_figma, A.get_metadata, B.get_metadata.
    client.resolveToolCall({ content: [{ type: "text", text: "a applied" }] });
    await settle();
    expect(client.inFlightToolCalls).toBe(1); // B took the lane next — never two at once
    client.resolveToolCall({ content: [{ type: "text", text: "b applied" }] });
    await settle();
    client.resolveToolCall({ content: [], structuredContent: { version: "va" } }); // A readback
    await settle();
    client.resolveToolCall({ content: [], structuredContent: { version: "vb" } }); // B readback
    await expect(a).resolves.toMatchObject({ readbackAvailable: true });
    await expect(b).resolves.toMatchObject({ readbackAvailable: true });
  });

  it("an approval declined during an earlier write is not lost to a later call", async () => {
    const connector = await connectedConnector();
    client.deferToolCalls();
    const a = connector.execute({ fileKey: "A", code: "x", description: "d" });
    const b = connector.execute({ fileKey: "B", code: "y", description: "d" });
    await settle();
    client.elicit({ message: "approve A?" }); // while A owns the lane; B is still queued
    client.resolveToolCall({ content: [{ type: "text", text: "a applied" }] });
    await expect(a).rejects.toThrow(/approval/); // A specifically fails clear
    client.resolveToolCall({ content: [{ type: "text", text: "b applied" }] }); // B.use_figma
    await settle(); // let B's readback enter the lane before answering it
    client.resolveToolCall({ content: [], structuredContent: { version: "v" } }); // B.get_metadata
    const outcomeB = await b;
    expect(outcomeB.readbackAvailable).toBe(true); // B's outcome untouched by A's decline
    expect(connector.elicitationCount).toBe(1);
  });

  it("a disconnect while a call is queued reports the write outcome as unverified", async () => {
    const connector = await connectedConnector();
    client.deferToolCalls();
    const a = connector.execute({ fileKey: "A", code: "x", description: "d" });
    const b = connector.execute({ fileKey: "B", code: "y", description: "d" });
    await settle();
    await connector.disconnect();
    await expect(a).rejects.toThrow(/restarted during the write/); // dispose rejected it mid-call
    await expect(b).rejects.toThrow(/restarted during the write/); // dispatched into a dead lane
  });

  it("execute -> readback does not deadlock the serialized lane", async () => {
    const connector = await connectedConnector();
    scriptToolReplies([
      { content: [{ type: "text", text: "edited" }] },
      { content: [], structuredContent: { version: "7" } },
    ]);
    await expect(
      connector.execute({ fileKey: "FK", code: "x", description: "d" }),
    ).resolves.toMatchObject({ readbackAvailable: true });
  });
});

describe("status observation (root review 4)", () => {
  it("getStatus re-reads native state while the process is owned, without OAuth or spawn", async () => {
    const connector = await connectedConnector();
    const baseline = client.requests.length;
    client.on("mcpServerStatus/list", () => ({
      data: [{ name: "figma", runtimeStatus: "connected", authStatus: "oAuth", tools: {} }],
    }));
    const status = await connector.getStatus();
    expect(status).toEqual({ state: "connected" });
    const after = client.requests.slice(baseline);
    expect(after.map((request) => request.method)).toContain("mcpServerStatus/list");
    expect(after.map((request) => request.method)).not.toContain("mcpServer/oauth/login");
  });

  it("concurrent status polls share one in-flight native refresh", async () => {
    const connector = await connectedConnector();
    const baseline = client.requests.filter(
      (request) => request.method === "mcpServerStatus/list",
    ).length;
    client.on("mcpServerStatus/list", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return connectedInventory();
    });
    await Promise.all([connector.getStatus(), connector.getStatus(), connector.getStatus()]);
    const extra = client.requests.filter(
      (request) => request.method === "mcpServerStatus/list",
    ).length;
    expect(extra - baseline).toBe(1);
  });

  it("a pending startup notification settles into an observable terminal state via polling", async () => {
    const connector = await connectedConnector();
    client.on("mcpServerStatus/list", () => ({
      data: [{ name: "figma", runtimeStatus: "starting", authStatus: "oAuth", tools: {} }],
    }));
    client.emitNotification("mcpServer/startupStatus/updated", {
      name: "figma",
      status: "starting",
    });
    await settle();
    expect(await connector.getStatus()).toMatchObject({ state: "connecting" });
    client.on("mcpServerStatus/list", () => ({
      data: [{ name: "figma", runtimeStatus: "failed", authStatus: "oAuth", tools: {} }],
    }));
    expect(await connector.getStatus()).toMatchObject({
      state: "error",
      message: /failed/,
    });
  });

  it("a stale-generation refresh cannot stamp state over a newer lifecycle", async () => {
    const connector = await connectedConnector();
    client.on("mcpServerStatus/list", async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return connectedInventory();
    });
    const first = connector.getStatus(); // refresh in flight, observing `connected`
    await settle();
    client.terminate(); // enabled stays true; the termination owns the new state
    await first;
    await settle(60); // the stale refresh resolves late — it must be guard-dropped
    expect(await connector.getStatus()).toMatchObject({ state: "error" });
  });
});

describe("elicitation logging (root review 5)", () => {
  it("logs only the method and outcome — raw params may carry the auth URL", async () => {
    const lines: string[] = [];
    const capturing = pino(
      { level: "debug" },
      {
        write: (chunk: string) => lines.push(chunk),
      },
    );
    const connector = new FigmaRemoteConnector({
      jagentdeskHome: home,
      logger: capturing,
      createClient: async () => {
        client.on("initialize", () => ({}));
        client.on("thread/start", () => ({ thread: { id: "thr-1" } }));
        client.on("mcpServerStatus/list", () => connectedInventory());
        client.on("mcpServer/oauth/login", () => ({
          authorizationUrl: "https://www.figma.com/oauth/abc",
        }));
        return client;
      },
    });
    await connector.authBegin();
    client.elicit({ message: "secret consent text", url: "https://hidden.example/x" });
    const elicitationLines = lines.filter((line) => line.includes("elicitation declined"));
    expect(elicitationLines.length).toBe(1);
    expect(elicitationLines[0]).not.toMatch(/secret consent text|hidden\.example/);
    expect(elicitationLines[0]).toMatch(/"action":"decline"/);
  });
});

describe("malformed native results (root review 7)", () => {
  it("a result without a content array fails closed instead of empty success", async () => {
    const connector = await connectedConnector();
    client.on("mcpServer/tool/call", () => ({ structuredContent: { note: "no content" } }));
    await expect(connector.execute({ fileKey: "FK", code: "x", description: "d" })).rejects.toThrow(
      /malformed use_figma/,
    );
    expect(toolCallRequests()).toHaveLength(1); // parse fails before the readback dispatches
  });

  it("a non-object content block fails closed", async () => {
    const connector = await connectedConnector();
    client.on("mcpServer/tool/call", () => ({ content: ["surprise"] }));
    await expect(connector.execute({ fileKey: "FK", code: "x", description: "d" })).rejects.toThrow(
      /malformed use_figma/,
    );
  });

  it("isError must be a strict boolean to be honored", async () => {
    const connector = await connectedConnector();
    client.on("mcpServer/tool/call", () => ({ content: [], isError: "false" }));
    await expect(connector.execute({ fileKey: "FK", code: "x", description: "d" })).rejects.toThrow(
      /malformed use_figma/,
    );
  });

  it("a tool-call timeout is tagged outcome-unknown so the memo is dropped, never retried", async () => {
    const connector = await connectedConnector();
    client.on("mcpServer/tool/call", () => {
      throw new Error("Codex app-server request timed out for mcpServer/tool/call");
    });
    const error = await connector
      .execute({ fileKey: "FK", code: "x", description: "d" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FigmaRemoteOutcomeUnknownError);
    expect((error as Error).message).toMatch(/timed out/);
    expect(toolCallRequests()).toHaveLength(1); // no auto-retry, ever
  });
});
