import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { FileBackedChatService } from "./chat/chat-service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { ClusterRegistry } from "./cluster/cluster-registry.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { LoopService } from "./loop-service.js";
import type { ScheduleService } from "./schedule/service.js";
import { createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import { VoiceAssistantWebSocketServer, type WebSocketLike } from "./websocket-server.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";

// A fully in-process WebSocketLike. The guard under test is purely message-driven,
// so no real network transport is required.
class FakeSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void): void {
    this.sent.push(typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString());
    callback?.();
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", code, reason);
  }

  on(event: "message" | "close" | "error", listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  once(event: "close" | "error", listener: (...args: unknown[]) => void): void {
    this.on(event, listener);
  }

  emit(event: "message" | "close" | "error", ...args: unknown[]): void {
    const snapshot = Array.from(this.listeners.get(event) ?? []);
    for (const listener of snapshot) listener(...args);
  }

  /** Deliver an inbound frame as if it arrived from the peer. */
  receiveText(payload: unknown): void {
    this.emit("message", JSON.stringify(payload));
  }

  get closedWithInvalidPluginClientId(): boolean {
    // WS_CLOSE_INVALID_HELLO is 4002.
    return this.closeCalls.some((call) => call.code === 4002);
  }

  get receivedServerInfo(): boolean {
    return this.sent.some((frame) => frame.includes('"status":"server_info"'));
  }
}

interface Harness {
  wsServer: VoiceAssistantWebSocketServer;
  home: string;
}

const harnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    harness.wsServer.prepareForShutdown();
    await harness.wsServer.close().catch(() => undefined);
    rmSync(harness.home, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const home = mkdtempSync(path.join(tmpdir(), "jagentdesk-plugin-guard-"));
  const httpServer = createServer();
  // Positional arg order mirrors the constructor exactly. The `undefined` at the
  // clusterRegistry slot (position 22) is load-bearing: omitting it shifts every
  // later argument and drops checkoutDiffManager (the bug in the older harnesses).
  const wsServer = new VoiceAssistantWebSocketServer(
    httpServer,
    pino({ level: "silent" }),
    "srv-test",
    createStub<AgentManager>({
      setAgentAttentionCallback() {},
      subscribe: () => () => {},
      getMetricsSnapshot: () => ({
        total: 0,
        byLifecycle: {},
        withActiveForegroundTurn: 0,
        timelineStats: { totalItems: 0, maxItemsPerAgent: 0 },
      }),
    }),
    createStub<AgentStorage>({}),
    createStub<DownloadTokenStore>({}),
    home,
    createStub<DaemonConfigStore>({ onChange: () => () => {} }),
    null,
    { allowedOrigins: new Set(["*"]) },
    createStub<WorkspaceAutoName>({
      scheduleForWorktree: () => {},
      scheduleForDirectory: () => {},
    }),
    undefined, // auth — no pairing, so no signed hello is required
    undefined, // speech
    undefined, // terminalManager
    undefined, // dictation
    "1.2.3-test", // daemonVersion
    undefined, // onLifecycleIntent
    undefined, // projectRegistry
    undefined, // workspaceRegistry
    createStub<FileBackedChatService>({}),
    createStub<LoopService>({}),
    createStub<ClusterRegistry>({ subscribe: () => () => {} }),
    createStub<ScheduleService>({}),
    createStub<CheckoutDiffManager>({
      subscribe: () => {},
      scheduleRefreshForCwd: () => {},
      getMetrics: () => ({
        checkoutDiffTargetCount: 0,
        checkoutDiffSubscriptionCount: 0,
        checkoutDiffWatcherCount: 0,
        checkoutDiffFallbackRefreshTargetCount: 0,
        checkoutDiffDispose: 0,
      }),
      dispose: () => {},
    }),
    undefined, // serviceProxy
    undefined, // scriptRuntimeStore
    undefined, // onBranchChanged
    undefined, // getDaemonTcpPort
    undefined, // getDaemonTcpHost
    undefined, // resolveScriptHealth
    undefined, // workspaceGitService
    undefined, // github
    undefined, // pushNotificationSender
    createProviderSnapshotManagerStub().manager,
    undefined, // daemonRuntimeConfig
    undefined, // serviceProxyPublicBaseUrl
    undefined, // browserToolsBroker
    undefined, // hubRelationships
    undefined, // pairing
    undefined, // pluginRuntime
  );
  const harness: Harness = { wsServer, home };
  harnesses.push(harness);
  return harness;
}

function hello(clientId: string) {
  return { type: "hello", clientId, clientType: "cli", protocolVersion: 1 };
}

describe("reserved plugin clientId guard", () => {
  test("rejects a NETWORK socket that claims a plugin: clientId", async () => {
    const { wsServer } = createHarness();
    const ws = new FakeSocket();
    await wsServer.attachExternalSocket(ws);

    ws.receiveText(hello("plugin:evil"));

    expect(ws.closedWithInvalidPluginClientId).toBe(true);
    expect(ws.receivedServerInfo).toBe(false);
  });

  test("rejects a NETWORK socket that claims a hub: clientId", async () => {
    const { wsServer } = createHarness();
    const ws = new FakeSocket();
    await wsServer.attachExternalSocket(ws);

    ws.receiveText(hello("hub:evil"));

    expect(ws.closedWithInvalidPluginClientId).toBe(true);
    expect(ws.receivedServerInfo).toBe(false);
  });

  test("rejects a plugin socket that claims a DIFFERENT plugin's clientId", async () => {
    const { wsServer } = createHarness();
    const ws = new FakeSocket();
    await wsServer.attachPluginSocket("my-plugin", ws);

    ws.receiveText(hello("plugin:other-plugin"));

    expect(ws.closedWithInvalidPluginClientId).toBe(true);
    expect(ws.receivedServerInfo).toBe(false);
  });

  test("accepts a plugin socket that claims its own plugin:<id> clientId", async () => {
    const { wsServer } = createHarness();
    const ws = new FakeSocket();
    await wsServer.attachPluginSocket("my-plugin", ws);

    ws.receiveText(hello("plugin:my-plugin"));

    expect(ws.closedWithInvalidPluginClientId).toBe(false);
    expect(ws.receivedServerInfo).toBe(true);
  });

  test("accepts an ordinary network client with a non-reserved clientId", async () => {
    const { wsServer } = createHarness();
    const ws = new FakeSocket();
    await wsServer.attachExternalSocket(ws);

    ws.receiveText(hello("web-1"));

    expect(ws.closedWithInvalidPluginClientId).toBe(false);
    expect(ws.receivedServerInfo).toBe(true);
  });
});
