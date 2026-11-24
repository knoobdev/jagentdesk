import { createWorkspaceRuntimeStore } from "./workspace-runtime-store/index.js";
import { DaemonClient } from "@jagentdesk/client";
import { createWebSocketTransportFactory } from "@jagentdesk/client/internal/daemon-client-transport";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { FileBackedChatService } from "./chat/chat-service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
import type { ClusterRegistry } from "./cluster/cluster-registry.js";
import type { DatabaseRegistry } from "./database/database-registry.js";
import type { DaemonConfigStore } from "./daemon-config-store.js";
import type { DownloadTokenStore } from "./file-download/token-store.js";
import type { LoopService } from "./loop-service.js";
import type { ScheduleService } from "./schedule/service.js";
import { createStub } from "./test-utils/class-mocks.js";
import { createProviderSnapshotManagerStub } from "./test-utils/session-stubs.js";
import {
  VoiceAssistantWebSocketServer,
  type PairingServerDependencies,
} from "./websocket-server.js";
import type { WorkspaceAutoName } from "./workspace-auto-name.js";
import { createNonceChallengeManager } from "./pairing/nonce-challenge.js";
import { createPairedDeviceStore } from "./pairing/paired-devices.js";
import { createPairingCodeManager } from "./pairing/pairing-code.js";
import {
  exportDevicePublicKey,
  generateDeviceKeyPair,
  signNonce,
} from "./pairing/device-signature-crypto.js";

const DAEMON_PUBLIC_KEY_B64 = "ZGFlbW9uLXB1YmxpYy1rZXk=";
const RELAY_ENDPOINT = "relay.jagentdesk.test:443";

interface RelayDaemonHarness {
  ingressPort: number;
  directPort: number;
  wsServer: VoiceAssistantWebSocketServer;
  devices: ReturnType<typeof createPairedDeviceStore>;
  stop(): Promise<void>;
}

const harnesses: RelayDaemonHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
});

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

/**
 * Mirrors the relay-transport wiring: the fake relay ingress hands sockets to
 * attachExternalSocket with transport "relay", exactly as relay-transport.ts
 * does after the ownership guard authenticates a data socket. The tailnet
 * listener is absent — this is the tailnet-down scenario from spec 35.4.
 */
function createRelayServerHarness(
  options: {
    relayEnabled?: boolean;
    enablePairingCode?: boolean;
    stallClose?: boolean;
    frameBytes?: number;
  } = {},
): {
  harness: RelayDaemonHarness;
  devices: ReturnType<typeof createPairedDeviceStore>;
} {
  const home = mkdtempSync(path.join(tmpdir(), "jagentdesk-relay-ws-"));
  const devices = createPairedDeviceStore({ jagentdeskHome: home });
  const challenges = createNonceChallengeManager({});

  const pairing: PairingServerDependencies = {
    devices,
    challenges,
    daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
    ...(options.enablePairingCode ? { pairingCodeManager: createPairingCodeManager() } : {}),
  };

  const httpServer = createServer();
  const relayEnabled = options.relayEnabled ?? true;
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
    createWorkspaceAutoNameStub(),
    createWorkspaceRuntimeStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    "1.2.3-test",
    undefined,
    undefined,
    undefined,
    createStub<FileBackedChatService>({}),
    createStub<LoopService>({}),
    createStub<ClusterRegistry>({}),
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
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createProviderSnapshotManagerStub().manager,
    {
      listen: "127.0.0.1:0",
      getRelayConfig: () =>
        relayEnabled ? { enabled: true, endpoint: RELAY_ENDPOINT, useTls: true } : null,
    },
    undefined,
    undefined,
    undefined,
    pairing,
    undefined,
    undefined,
    undefined,
    createStub<DatabaseRegistry>({}),
  );

  const ingress = createServer();
  const ingressWss = new WebSocketServer({ server: ingress, path: "/ws" });
  let relayConnections = 0;
  ingressWss.on("connection", (ws) => {
    if (options.stallClose) ws.close = () => {};
    if (options.frameBytes)
      Object.defineProperty(ws, "maxFrameBytes", { value: options.frameBytes });
    relayConnections += 1;
    void wsServer.attachExternalSocket(ws, {
      transport: "relay",
      relayConnectionId: `clt-relay-${relayConnections}`,
    });
  });
  void ingress.listen(0, "127.0.0.1");

  const harness: RelayDaemonHarness = {
    ingressPort: 0,
    directPort: 0,
    wsServer,
    devices,
    async stop() {
      wsServer.prepareForShutdown();
      await wsServer.close();
      ingressWss.close();
      await new Promise<void>((resolve) => {
        ingress.closeAllConnections?.();
        ingress.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      });
      rmSync(home, { recursive: true, force: true });
    },
  };
  ingress.on("listening", () => {
    harness.ingressPort = (ingress.address() as AddressInfo).port;
  });
  void httpServer.listen(0, "127.0.0.1");
  httpServer.on("listening", () => {
    harness.directPort = (httpServer.address() as AddressInfo).port;
  });
  return { harness, devices };
}

function createBufferedClient(port: number): {
  socket: WebSocket;
  messages: unknown[];
  waitFor(predicate: (message: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
} {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages: unknown[] = [];
  const waiters: Array<{
    predicate: (message: unknown) => boolean;
    resolve: (message: unknown) => void;
    reject: (error: Error) => void;
  }> = [];

  socket.on("message", (data: RawData) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch {
      return;
    }
    messages.push(parsed);
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(parsed));
    if (waiterIndex !== -1) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(parsed);
    }
  });

  function waitFor(predicate: (message: unknown) => boolean, timeoutMs = 10_000): Promise<unknown> {
    const existing = messages.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      const timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for message; received: ${JSON.stringify(messages)}`));
      }, timeoutMs);
      waiter.reject = (error) => {
        clearTimeout(timeout);
        reject(error);
      };
      waiters.push(waiter);
    });
  }

  function waitForClose(timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for close")), timeoutMs);
      socket.once("close", (code: number, reason: Buffer) => {
        clearTimeout(timeout);
        resolve({ code, reason: reason.toString() });
      });
    });
  }

  return { socket, messages, waitFor, waitForClose };
}

async function waitForPort(harness: RelayDaemonHarness): Promise<number> {
  if (harness.ingressPort > 0) return harness.ingressPort;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForPort(harness);
}

async function waitForDirectPort(harness: RelayDaemonHarness): Promise<number> {
  if (harness.directPort > 0) return harness.directPort;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForDirectPort(harness);
}

async function openClient(client: { socket: WebSocket }): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.socket.once("open", () => resolve());
    client.socket.once("error", reject);
  });
}

/** Reconnects a previously paired relay device; returns deviceId + live client. */
async function pairOverRelay(harness: RelayDaemonHarness, deviceName: string) {
  const port = await waitForPort(harness);
  const key = generateDeviceKeyPair();
  const devicePublicKeyB64 = exportDevicePublicKey(key.publicKey);
  // Relay authentication cases reconnect a key paired before the SAS requirement.
  harness.devices.register({ devicePublicKeyB64, deviceName });
  const client = createBufferedClient(port);
  await openClient(client);

  const challenge = (await client.waitFor(
    (m) => (m as { type?: string }).type === "challenge",
  )) as { nonce: string };

  client.socket.send(
    JSON.stringify({
      type: "session",
      message: {
        type: "pairing.device.register.request",
        requestId: `req-${deviceName}`,
        daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
        devicePublicKeyB64,
        deviceName,
      },
    }),
  );
  const registerResponse = (await client.waitFor(
    (m) =>
      (m as { message?: { type?: string } }).message?.type === "pairing.device.register.response",
  )) as { message: { payload: { ok: boolean; deviceId: string } } };
  expect(registerResponse.message.payload.ok).toBe(true);
  const deviceId = registerResponse.message.payload.deviceId;

  client.socket.send(
    JSON.stringify({
      type: "hello",
      clientId: `client-${deviceName}`,
      clientType: "mobile",
      protocolVersion: 1,
      nonce: challenge.nonce,
      signature: signNonce(key, challenge.nonce),
      devicePublicKeyB64,
    }),
  );
  const serverInfo = (await client.waitFor(
    (m) =>
      (m as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
      "server_info",
  )) as { message: { payload: Record<string, unknown> } };

  return { client, deviceId, serverInfoPayload: serverInfo.message.payload };
}

describe("relay external sockets (spec 35)", () => {
  test("chunks requests and responses without changing signed relay admission", async () => {
    const { harness, devices } = createRelayServerHarness({ frameBytes: 128 });
    harnesses.push(harness);
    const key = generateDeviceKeyPair();
    const devicePublicKeyB64 = exportDevicePublicKey(key.publicKey);
    const deviceName = "Signed device ".repeat(40) + "日本語";
    devices.register({ devicePublicKeyB64, deviceName });
    const port = await waitForPort(harness);
    let outboundBinary = 0;
    let inboundBinary = 0;
    const recordInbound = (_data: RawData, binary: boolean) => {
      if (binary) inboundBinary++;
    };
    const factory = createWebSocketTransportFactory((url) => {
      const socket = new WebSocket(url);
      socket.on("message", recordInbound);
      return socket;
    });
    const client = new DaemonClient({
      url: `ws://127.0.0.1:${port}/ws`,
      clientId: "chunked-relay-device",
      expectChallenge: true,
      reconnect: { enabled: false },
      deviceSigning: { devicePublicKeyB64, signNonce: async (nonce) => signNonce(key, nonce) },
      transportFactory: (options) => {
        const base = factory(options);
        return {
          ...base,
          maxFrameBytes: 128,
          send: (frame) => {
            if (typeof frame !== "string") outboundBinary++;
            return base.send(frame);
          },
        };
      },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    try {
      await client.connect();
      const requestId = "chunked-" + "request".repeat(80);
      const response = await client.pairingDeviceList(requestId);
      expect(response.requestId).toBe(requestId);
      expect(response.devices.map((device) => device.deviceName)).toEqual([deviceName]);
      expect(outboundBinary).toBeGreaterThan(1);
      expect(inboundBinary).toBeGreaterThan(1);
      expect(client.isConnected).toBe(true);
    } finally {
      client.close();
    }
  });

  test("pairs over relay with the tailnet down, and server_info advertises the relay", async () => {
    const { harness, devices } = createRelayServerHarness();
    harnesses.push(harness);

    const { client, deviceId, serverInfoPayload } = await pairOverRelay(
      harness,
      "Phone over relay",
    );

    // The signed-hello gate treats relay exactly like tailnet: the session is
    // fully upgraded and the device is persisted.
    expect(devices.list().some((d) => d.deviceId === deviceId)).toBe(true);

    // Spec 35.4: hosts already paired learn the second path from server_info.
    expect(serverInfoPayload.relay).toEqual({
      endpoint: RELAY_ENDPOINT,
      useTls: true,
      daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
    });
    expect((serverInfoPayload.features as Record<string, unknown>).relay).toBe(true);

    client.socket.close();
  });

  test("server_info omits the relay descriptor when relay is disabled", async () => {
    const { harness } = createRelayServerHarness({ relayEnabled: false });
    harnesses.push(harness);

    const { client, serverInfoPayload } = await pairOverRelay(harness, "Phone, relay off");
    expect(serverInfoPayload.relay).toBeUndefined();
    expect((serverInfoPayload.features as Record<string, unknown>).relay).toBe(false);

    client.socket.close();
  });

  test("pairing requests carry the relay transport to trusted desktops", async () => {
    const { harness } = createRelayServerHarness({ enablePairingCode: true });
    harnesses.push(harness);
    const port = await waitForPort(harness);
    const directPort = await waitForDirectPort(harness);

    const desktop = createBufferedClient(directPort);
    await openClient(desktop);
    desktop.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-desktop-relay",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );
    await desktop.waitFor(
      (m) =>
        (m as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
        "server_info",
    );

    // A relay device asks for pairing while the tailnet is down.
    const mobile = createBufferedClient(port);
    await openClient(mobile);
    await mobile.waitFor((m) => (m as { type?: string }).type === "challenge");
    mobile.socket.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "pairing.device.identify.request",
          requestId: "req-relay-identify",
          deviceName: "Relay laptop",
          devicePublicKeyB64: "ZGV2aWNlLWtleQ==",
        },
      }),
    );

    const requested = (await desktop.waitFor(
      (m) => (m as { message?: { type?: string } }).message?.type === "pairing.device.requested",
    )) as {
      message: { payload: { transport?: string; relayConnectionId?: string; deviceName?: string } };
    };
    expect(requested.message.payload.transport).toBeUndefined();
    expect(requested.message.payload.relayConnectionId).toBe("clt-relay-1");
    expect(requested.message.payload.deviceName).toBe("Relay laptop");

    mobile.socket.close();
    desktop.socket.close();
  });

  test("revoking a device closes its live relay socket (spec 05.5 × 35)", async () => {
    const { harness } = createRelayServerHarness();
    harnesses.push(harness);

    const { client, deviceId } = await pairOverRelay(harness, "Phone to revoke");

    const closed = harness.wsServer.closeConnectionsForDevice(deviceId);
    expect(closed).toBe(1);

    const close = await client.waitForClose();
    expect(close.reason).toBe("Device revoked");
  });

  test("revoking a device closes only that device's relay sockets", async () => {
    const { harness } = createRelayServerHarness();
    harnesses.push(harness);

    const first = await pairOverRelay(harness, "First phone");
    const second = await pairOverRelay(harness, "Second phone");

    // One socket per device: the returned count is exact, proving scoping.
    expect(harness.wsServer.closeConnectionsForDevice(first.deviceId)).toBe(1);
    await first.client.waitForClose();

    // The second device's relay socket survived: it is still attached and
    // trackable, so revoking it closes exactly its own connection.
    expect(harness.wsServer.closeConnectionsForDevice(second.deviceId)).toBe(1);
    await second.client.waitForClose();
  });
  test("revocation terminates a relay socket whose close handshake stalls", async () => {
    const { harness } = createRelayServerHarness({ stallClose: true });
    harnesses.push(harness);
    const { client, deviceId } = await pairOverRelay(harness, "Stalled phone");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      expect(harness.wsServer.closeConnectionsForDevice(deviceId)).toBe(1);
      expect(harness.wsServer.closeConnectionsForDevice(deviceId)).toBe(0);
      vi.advanceTimersByTime(5_000);
    } finally {
      vi.useRealTimers();
    }
    expect((await client.waitForClose()).code).toBe(1006);
  });
});
