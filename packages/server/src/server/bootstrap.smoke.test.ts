import os from "node:os";
import http from "node:http";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import pino from "pino";
import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import { createJAgentDeskDaemon, parseListenString, type JAgentDeskDaemonConfig } from "./bootstrap.js";
import { AgentManagerShuttingDownError } from "./agent/agent-manager.js";
import { hashDaemonPassword } from "./auth.js";
import { generateLocalPairingOffer } from "./pairing-offer.js";
import { createTestJAgentDeskDaemon } from "./test-utils/jagentdesk-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { DaemonClient } from "./test-utils/daemon-client.js";
import { isPlatform } from "../test-utils/platform.js";
import { findFreePort } from "./service-proxy.js";
import type {
  HubEnrollment,
  HubEnrollmentResult,
  HubRelationshipRemote,
  HubRevocation,
  HubSocketConnection,
  HubSocketCredentials,
  HubSocketEvents,
} from "./hub/relationship-remote.js";

interface HeldAgentClose {
  started: Promise<void>;
  arm(): void;
  closeSession(): Promise<void>;
  finish(): void;
}

interface BlockedDaemonShutdown {
  probeReconnect(): Promise<WebSocketProbeResult>;
  tryCreateAgent(): Promise<"created" | "rejected">;
  finish(): Promise<void>;
}

type WebSocketProbeResult =
  | { status: "connected" }
  | { status: "rejected"; statusCode: number | null };

describe("jagentdesk daemon bootstrap", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("starts and serves health endpoint", async () => {
    const daemonHandle = await createTestJAgentDeskDaemon({
      openai: { stt: { apiKey: "test-openai-api-key" }, tts: { apiKey: "test-openai-api-key" } },
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/api/health`, {
        headers: daemonHandle.agentMcpAuthHeader
          ? { Authorization: daemonHandle.agentMcpAuthHeader }
          : undefined,
      });
      expect(response.ok).toBe(true);
      const payload = await response.json();
      expect(payload.status).toBe("ok");
      expect(typeof payload.timestamp).toBe("string");
    } finally {
      await daemonHandle.close();
    }
  });

  function httpGetWithHost(port: number, host: string, requestPath: string): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { hostname: "127.0.0.1", port, path: requestPath, headers: { host } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve(
              new Response(Buffer.concat(chunks), {
                status: res.statusCode ?? 0,
                headers: res.headers as HeadersInit,
              }),
            );
          });
        },
      );
      req.on("error", reject);
    });
  }

  test("proxies registered service hosts before daemon auth while daemon APIs stay protected", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("service-ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected upstream TCP address");
    }

    const daemonHandle = await createTestJAgentDeskDaemon({
      auth: { password: hashDaemonPassword("secret") },
    });
    try {
      daemonHandle.daemon.serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-service-auth",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "web",
        port: address.port,
      });

      const serviceResponse = await httpGetWithHost(
        daemonHandle.port,
        `web--repo.localhost:${daemonHandle.port}`,
        "/",
      );
      expect(serviceResponse.status).toBe(200);
      expect(await serviceResponse.text()).toBe("service-ok");

      const daemonResponse = await httpGetWithHost(
        daemonHandle.port,
        `daemon.localhost:${daemonHandle.port}`,
        "/api/status",
      );
      expect(daemonResponse.status).toBe(401);
    } finally {
      await daemonHandle.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("configured public service namespace misses never reach daemon APIs", async () => {
    const daemonHandle = await createTestJAgentDeskDaemon({
      serviceProxy: {
        publicBaseUrl: "https://services.example.com",
        standaloneListen: null,
      },
    });
    try {
      const response = await httpGetWithHost(
        daemonHandle.port,
        `missing.services.example.com:${daemonHandle.port}`,
        "/api/status",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    } finally {
      await daemonHandle.close();
    }
  });

  test("rolls back daemon listener when standalone service proxy startup fails", async () => {
    const occupiedServer = http.createServer((_req, res) => {
      res.end("occupied");
    });
    await new Promise<void>((resolve) => occupiedServer.listen(0, "127.0.0.1", resolve));
    const address = occupiedServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected occupied TCP address");
    }

    const jagentdeskHomeRoot = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-standalone-rollback-"));
    const jagentdeskHome = path.join(jagentdeskHomeRoot, ".jagentdesk");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-static-"));
    await mkdir(jagentdeskHome, { recursive: true });
    const config: JAgentDeskDaemonConfig = {
      listen: "127.0.0.1:0",
      jagentdeskHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(jagentdeskHome, "agents"),
      appBaseUrl: "jagentdesk://app",
      openai: undefined,
      speech: undefined,
      serviceProxy: {
        standaloneListen: `127.0.0.1:${address.port}`,
      },
    };
    const daemon = await createJAgentDeskDaemon(config, pino({ level: "silent" }));

    try {
      await expect(daemon.start()).rejects.toThrow();
      await expect(fetch(`http://127.0.0.1:${daemon.port}/api/health`)).rejects.toThrow();
    } finally {
      await daemon.stop().catch(() => undefined);
      await new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
      await rm(jagentdeskHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("local service namespace misses never reach daemon APIs", async () => {
    const daemonHandle = await createTestJAgentDeskDaemon({
      auth: { password: hashDaemonPassword("secret") },
    });
    try {
      const response = await httpGetWithHost(
        daemonHandle.port,
        `missing--repo.localhost:${daemonHandle.port}`,
        "/api/status",
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe("404 Not Found");
    } finally {
      await daemonHandle.close();
    }
  });

  test("daemon websocket still upgrades when service proxy upgrade handler is mounted", async () => {
    const daemonHandle = await createTestJAgentDeskDaemon();
    const ws = new WebSocket(`ws://127.0.0.1:${daemonHandle.port}/ws`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      ws.close();
      await daemonHandle.close();
    }
  });

  test("config changes during Hub enrollment reach the live runtime", async () => {
    const jagentdeskHomeRoot = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-tailnet-startup-"));
    const jagentdeskHome = path.join(jagentdeskHomeRoot, ".jagentdesk");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-static-"));
    await mkdir(jagentdeskHome, { recursive: true });
    await writeFile(
      path.join(jagentdeskHome, "hub-relationship.json"),
      `${JSON.stringify({
        version: 1,
        state: "pending",
        relationship: {
          daemonId: "daemon-startup-race",
          idempotencyKey: "enrollment-startup-race",
          hubOrigin: "https://hub.test",
          createdAt: "2026-07-31T00:00:00.000Z",
          scopes: ["hub.execution.*"],
        },
        credential: { secret: "credential" },
        enrollment: { token: "enrollment-token" },
        identity: { serverId: "server-startup-race", daemonPublicKey: "public-key" },
      })}\n`,
      "utf-8",
    );

    let markEnrollmentStarted: () => void = () => undefined;
    const enrollmentStarted = new Promise<void>((resolve) => {
      markEnrollmentStarted = resolve;
    });
    let releaseEnrollment: () => void = () => undefined;
    const enrollmentReleased = new Promise<void>((resolve) => {
      releaseEnrollment = resolve;
    });
    const remote: HubRelationshipRemote = {
      async enroll(input: HubEnrollment): Promise<HubEnrollmentResult> {
        markEnrollmentStarted();
        await enrollmentReleased;
        return {
          daemonId: input.daemonId,
          permissions: input.permissions,
          webSocketUrl: "wss://hub.test/daemon",
        };
      },
      async updatePermissions(input) {
        return { permissions: input.permissions };
      },
      async revoke(_input: HubRevocation): Promise<void> {},
      openSocket(_input: HubSocketCredentials, _events: HubSocketEvents): HubSocketConnection {
        return { close: () => undefined };
      },
    };
    const config: JAgentDeskDaemonConfig = {
      listen: "127.0.0.1:0",
      jagentdeskHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(jagentdeskHome, "agents"),
      appBaseUrl: "jagentdesk://app",
      openai: undefined,
      speech: undefined,
    };
    const daemon = await createJAgentDeskDaemon(config, pino({ level: "silent" }), {
      hubRelationshipRemote: remote,
    });
    const starting = daemon.start();
    let client: DaemonClient | null = null;

    try {
      await enrollmentStarted;
      const listenTarget = daemon.getListenTarget();
      if (!listenTarget || listenTarget.type !== "tcp") {
        throw new Error("Expected daemon TCP listener during Hub enrollment");
      }
      client = new DaemonClient({
        url: `ws://127.0.0.1:${listenTarget.port}/ws`,
        appVersion: "0.1.82",
      });
      await client.connect();
      await client.patchDaemonConfig({ browserTools: { enabled: true } });
      releaseEnrollment();
      await starting;

      const config = await client.getDaemonConfig();
      expect(config.config.browserTools?.enabled).toBe(true);
    } finally {
      releaseEnrollment();
      await starting.catch(() => undefined);
      await client?.close().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      await rm(jagentdeskHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("stops new connections and agent registrations before closing agents", async () => {
    const shutdown = await beginDaemonShutdownWithAgentClosing();
    try {
      await expect(
        Promise.all([shutdown.probeReconnect(), shutdown.tryCreateAgent()]),
      ).resolves.toEqual([{ status: "rejected", statusCode: 503 }, "rejected"]);
    } finally {
      await shutdown.finish();
    }
  });

  test("standalone listener exposes services only", async () => {
    const standalonePort = await findFreePort();
    const upstream = http.createServer((_req, res) => {
      res.end("service-ok");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("Expected upstream TCP address");
    }

    const daemonHandle = await createTestJAgentDeskDaemon({
      serviceProxy: { standaloneListen: `127.0.0.1:${standalonePort}` },
    });
    try {
      daemonHandle.daemon.serviceProxy.registerWorkspaceService({
        workspaceId: "workspace-standalone",
        projectSlug: "repo",
        branchName: "main",
        scriptName: "web",
        port: upstreamAddress.port,
      });

      const serviceResponse = await httpGetWithHost(
        standalonePort,
        `web--repo.localhost:${standalonePort}`,
        "/",
      );
      expect(serviceResponse.status).toBe(200);
      expect(await serviceResponse.text()).toBe("service-ok");

      for (const requestPath of ["/api/health", "/ws", "/mcp/agents", "/index.html", "/files/x"]) {
        const response = await httpGetWithHost(
          standalonePort,
          `daemon.localhost:${standalonePort}`,
          requestPath,
        );
        expect(response.status).toBe(404);
      }
    } finally {
      await daemonHandle.close();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("rolls back already-open standalone listener when main daemon listen fails", async () => {
    const mainPort = await findFreePort();
    const standalonePort = await findFreePort();
    const occupiedMain = http.createServer((_req, res) => {
      res.end("occupied-main");
    });
    await new Promise<void>((resolve) => occupiedMain.listen(mainPort, "127.0.0.1", resolve));

    const jagentdeskHomeRoot = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-main-rollback-"));
    const jagentdeskHome = path.join(jagentdeskHomeRoot, ".jagentdesk");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-static-"));
    await mkdir(jagentdeskHome, { recursive: true });
    const config: JAgentDeskDaemonConfig = {
      listen: `127.0.0.1:${mainPort}`,
      jagentdeskHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(jagentdeskHome, "agents"),
      appBaseUrl: "jagentdesk://app",
      openai: undefined,
      speech: undefined,
      serviceProxy: { standaloneListen: `127.0.0.1:${standalonePort}` },
    };
    const daemon = await createJAgentDeskDaemon(config, pino({ level: "silent" }));

    try {
      await expect(daemon.start()).rejects.toThrow();
      await expect(fetch(`http://127.0.0.1:${standalonePort}/api/health`)).rejects.toThrow();
    } finally {
      await daemon.stop().catch(() => undefined);
      await new Promise<void>((resolve) => occupiedMain.close(() => resolve()));
      await rm(jagentdeskHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("redacts Agent MCP debug request credentials and bodies", async () => {
    const logLines: string[] = [];
    const logger = pino(
      { level: "debug" },
      {
        write: (line: string) => {
          logLines.push(line);
        },
      },
    );
    const daemonHandle = await createTestJAgentDeskDaemon({
      logger,
      mcpDebug: true,
    });

    try {
      const response = await fetch(`http://127.0.0.1:${daemonHandle.port}/mcp/agents`, {
        method: "POST",
        headers: {
          Authorization: "Bearer secret-debug-token",
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            apiKey: "secret-body-token",
          },
        }),
      });

      await response.text();
      const logs = logLines.join("\n");
      expect(logs).toContain("Agent MCP request");
      expect(logs).toContain("[redacted]");
      expect(logs).toContain('"method":"tools/call"');
      expect(logs).toContain('"hasParams":true');
      expect(logs).not.toContain("secret-debug-token");
      expect(logs).not.toContain("secret-body-token");
      expect(logs).not.toContain("apiKey");
    } finally {
      await daemonHandle.close();
    }
  });

  test("starts when OpenAI speech provider is configured without credentials", async () => {
    const jagentdeskHomeRoot = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-openai-config-"));
    const jagentdeskHome = path.join(jagentdeskHomeRoot, ".jagentdesk");
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-static-"));
    await mkdir(jagentdeskHome, { recursive: true });

    const config: JAgentDeskDaemonConfig = {
      listen: "127.0.0.1:0",
      jagentdeskHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(jagentdeskHome, "agents"),
      appBaseUrl: "jagentdesk://app",
      openai: undefined,
      speech: {
        providers: {
          dictationStt: { provider: "openai", explicit: true },
          voiceStt: { provider: "openai", explicit: true },
          voiceTts: { provider: "openai", explicit: true },
        },
      },
    };

    try {
      const daemon = await createJAgentDeskDaemon(config, pino({ level: "silent" }));
      try {
        await daemon.start();
        expect(daemon.getListenTarget()).toBeDefined();
        // Must also stop without throwing
      } finally {
        await daemon.stop();
      }
    } finally {
      await rm(jagentdeskHomeRoot, { recursive: true, force: true });
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  test("does not block daemon start on local speech model downloads", async () => {
    const originalFetch = globalThis.fetch;
    let releaseFetch: ((value: Response) => void) | null = null;
    const fetchGate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => fetchGate),
    );

    const daemonHandle = await createTestJAgentDeskDaemon({
      speech: {
        providers: {
          dictationStt: { provider: "local", explicit: true, enabled: true },
          voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
          voiceStt: { provider: "local", explicit: true, enabled: false },
          voiceTts: { provider: "local", explicit: true, enabled: false },
        },
        local: {
          modelsDir: path.join(os.tmpdir(), `jagentdesk-missing-models-${Date.now()}`),
          models: {
            dictationStt: "parakeet-tdt-0.6b-v2-int8",
            voiceStt: "parakeet-tdt-0.6b-v2-int8",
            voiceTts: "kokoro-en-v0_19",
          },
        },
      },
    });

    try {
      const response = await originalFetch(`http://127.0.0.1:${daemonHandle.port}/api/health`);
      expect(response.ok).toBe(true);
    } finally {
      releaseFetch?.(
        new Response(null, {
          status: 500,
          statusText: "test cleanup",
        }),
      );
      vi.unstubAllGlobals();
      globalThis.fetch = originalFetch;
      await daemonHandle.close();
    }
  });

  test("parses whitespace-padded numeric port strings", () => {
    expect(parseListenString(" 6767 ")).toEqual({
      type: "tcp",
      host: "127.0.0.1",
      port: 6767,
    });
  });

  test("parses IPv6 listen targets correctly", () => {
    expect(parseListenString("[::1]:6767")).toEqual({
      type: "tcp",
      host: "::1",
      port: 6767,
    });
    expect(parseListenString("[::]:6767")).toEqual({
      type: "tcp",
      host: "::",
      port: 6767,
    });
  });

  test("rejects Windows absolute paths that are not named pipes", () => {
    // A Windows drive path like C:\daemon must NOT be silently parsed as TCP
    // (split(":") would yield host="C" and port="\\daemon" which is nonsensical).
    expect(() => parseListenString(String.raw`C:\daemon`)).toThrow();
    expect(() => parseListenString(String.raw`D:\Users\foo\.jagentdesk\daemon.sock`)).toThrow();
    // Single-letter "host" with no valid port is not a valid listen string
    expect(() => parseListenString(String.raw`C:\some\path`)).toThrow();
  });

  test("parses Windows named pipes as managed IPC listen targets", () => {
    expect(parseListenString(String.raw`\\.\pipe\jagentdesk-managed-test`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\jagentdesk-managed-test`,
    });
    expect(parseListenString(`pipe://${String.raw`\\.\pipe\jagentdesk-managed-test`}`)).toEqual({
      type: "pipe",
      path: String.raw`\\.\pipe\jagentdesk-managed-test`,
    });
  });

  // POSIX-only: Unix socket listen paths are invalid Windows listen targets.
  test.skipIf(isPlatform("win32"))(
    "generates a tailnet pairing offer when a direct address is configured",
    async () => {
      const jagentdeskHomeRoot = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-socket-tailnet-"));
      const jagentdeskHome = path.join(jagentdeskHomeRoot, ".jagentdesk");
      const staticDir = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-static-"));
      const socketPath = path.join(jagentdeskHomeRoot, "run", "jagentdesk.sock");
      await mkdir(path.dirname(socketPath), { recursive: true });
      await mkdir(jagentdeskHome, { recursive: true });
      const logger = pino({ level: "silent" });

      const config: JAgentDeskDaemonConfig = {
        listen: socketPath,
        jagentdeskHome,
        corsAllowedOrigins: [],
        hostnames: true,
        mcpEnabled: false,
        staticDir,
        mcpDebug: false,
        agentClients: createTestAgentClients(),
        agentStoragePath: path.join(jagentdeskHome, "agents"),
        appBaseUrl: "jagentdesk://app",
        openai: undefined,
        speech: undefined,
      };

      const daemon = await createJAgentDeskDaemon(config, logger);

      try {
        await daemon.start();
        const pairing = await generateLocalPairingOffer({
          jagentdeskHome,
          tailnetAddress: "localhost:6767",
          appBaseUrl: "jagentdesk://app",
          includeQr: false,
        });
        expect(pairing.tailnetEnabled).toBe(true);
        expect(pairing.url?.startsWith("jagentdesk://app/#offer=")).toBe(true);
      } finally {
        await daemon.stop().catch(() => undefined);
        await daemon.agentManager.flush().catch(() => undefined);
        await rm(jagentdeskHomeRoot, { recursive: true, force: true });
        await rm(staticDir, { recursive: true, force: true });
      }
    },
  );
});

function holdAgentClose(): HeldAgentClose {
  let armed = false;
  let markStarted = () => {};
  let finish = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    started,
    arm() {
      armed = true;
    },
    async closeSession() {
      if (!armed) {
        return;
      }
      markStarted();
      await finished;
    },
    finish: () => finish(),
  };
}

async function beginDaemonShutdownWithAgentClosing(): Promise<BlockedDaemonShutdown> {
  const heldAgentClose = holdAgentClose();
  const daemonHandle = await createTestJAgentDeskDaemon({
    cleanup: false,
    agentClients: createTestAgentClients({ closeSession: heldAgentClose.closeSession }),
  });
  const agentCwd = await mkdtemp(path.join(os.tmpdir(), "jagentdesk-shutdown-agent-"));
  await daemonHandle.daemon.agentManager.createAgent(
    {
      provider: "codex",
      cwd: agentCwd,
    },
    undefined,
    { workspaceId: undefined },
  );

  heldAgentClose.arm();
  const stopPromise = daemonHandle.daemon.stop();
  await heldAgentClose.started;

  return {
    probeReconnect: () => probeWebSocketConnection(`ws://127.0.0.1:${daemonHandle.port}/ws`),
    async tryCreateAgent() {
      try {
        await daemonHandle.daemon.agentManager.createAgent(
          {
            provider: "codex",
            cwd: agentCwd,
          },
          undefined,
          { workspaceId: undefined },
        );
        return "created";
      } catch (error) {
        if (error instanceof AgentManagerShuttingDownError) {
          return "rejected";
        }
        throw error;
      }
    },
    async finish() {
      heldAgentClose.finish();
      await stopPromise;
      await daemonHandle.daemon.agentManager.flush().catch(() => undefined);
      await Promise.all([
        rm(path.dirname(daemonHandle.jagentdeskHome), { recursive: true, force: true }),
        rm(daemonHandle.staticDir, { recursive: true, force: true }),
        rm(agentCwd, { recursive: true, force: true }),
      ]);
    },
  };
}

function probeWebSocketConnection(url: string): Promise<WebSocketProbeResult> {
  const ws = new WebSocket(url);
  return new Promise((resolve) => {
    ws.once("open", () => {
      ws.close();
      resolve({ status: "connected" });
    });
    ws.once("error", () => resolve({ status: "rejected", statusCode: null }));
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve({ status: "rejected", statusCode: response.statusCode ?? null });
    });
  });
}
