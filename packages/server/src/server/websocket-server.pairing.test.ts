import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import pino from "pino";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import type { FileBackedChatService } from "./chat/chat-service.js";
import type { CheckoutDiffManager } from "./checkout-diff-manager.js";
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
  type DeviceKeyPair,
} from "./pairing/device-signature-crypto.js";

const DAEMON_PUBLIC_KEY_B64 = "ZGFlbW9uLXB1YmxpYy1rZXk=";

interface PairingDaemonHarness {
  ingressPort: number;
  directPort: number;
  stop(): Promise<void>;
}

const harnesses: PairingDaemonHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.stop()));
});

function createLogger() {
  const logger = pino({ level: "silent" });
  return logger;
}

function createWorkspaceAutoNameStub(): WorkspaceAutoName {
  return createStub<WorkspaceAutoName>({
    scheduleForWorktree: () => {},
    scheduleForDirectory: () => {},
  });
}

function createPairingServerHarness(
  options: { enablePairingCode?: boolean; requireSignedHelloForDirect?: boolean } = {},
): {
  harness: PairingDaemonHarness;
  devices: ReturnType<typeof createPairedDeviceStore>;
  home: string;
} {
  const home = mkdtempSync(path.join(tmpdir(), "jagentdesk-pairing-ws-"));
  const devices = createPairedDeviceStore({ jagentdeskHome: home });
  const challenges = createNonceChallengeManager({});

  const pairing: PairingServerDependencies = {
    devices,
    challenges,
    daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
    ...(options.enablePairingCode ? { pairingCodeManager: createPairingCodeManager() } : {}),
    ...(options.requireSignedHelloForDirect ? { requireSignedHelloForDirect: true } : {}),
  };

  // The tsnet listener owns a loopback ingress that performs the HTTP upgrade
  // and hands sockets to attachExternalSocket with transport "tailnet". Mirror
  // that wiring here so the test drives the real pairing gate end-to-end.
  const httpServer = createServer();
  const wsServer = new VoiceAssistantWebSocketServer(
    httpServer,
    createLogger(),
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
    undefined,
    undefined,
    undefined,
    undefined,
    pairing,
  );

  const ingress = createServer();
  const ingressWss = new WebSocketServer({ server: ingress, path: "/ws" });
  ingressWss.on("connection", (ws) => {
    void wsServer.attachExternalSocket(ws, { transport: "tailnet" });
  });

  const startPromise = new Promise<void>((resolve) => {
    ingress.listen(0, "127.0.0.1", () => resolve());
  });
  const directStartPromise = new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const portPromise = startPromise.then(() => {
    const address = ingress.address() as AddressInfo;
    return address.port;
  });
  const directPortPromise = directStartPromise.then(() => {
    const address = httpServer.address() as AddressInfo;
    return address.port;
  });

  const harness: PairingDaemonHarness = {
    ingressPort: 0,
    directPort: 0,
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

  void portPromise.then((port) => {
    harness.ingressPort = port;
    return undefined;
  });
  void directPortPromise.then((port) => {
    harness.directPort = port;
    return undefined;
  });
  return { harness, devices, home };
}

/**
 * A test client that buffers every inbound message from the moment the socket
 * is created, so a challenge sent immediately on attach is never missed.
 */
function createBufferedTailnetClient(port: number | string): {
  socket: WebSocket;
  messages: unknown[];
  waitFor(predicate: (message: unknown) => boolean, timeoutMs?: number): Promise<unknown>;
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>;
} {
  const socket = new WebSocket(typeof port === "number" ? `ws://127.0.0.1:${port}/ws` : port);
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
        if (index !== -1) {
          waiters.splice(index, 1);
        }
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

  return {
    socket,
    messages,
    waitFor,
    waitForClose,
  };
}

function waitForSocketOpen(client: { socket: WebSocket }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    client.socket.once("open", resolve);
    client.socket.once("error", reject);
  });
}

async function waitForPort(harness: PairingDaemonHarness): Promise<number> {
  if (harness.ingressPort > 0) {
    return harness.ingressPort;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForPort(harness);
}

async function waitForDirectPort(harness: PairingDaemonHarness): Promise<number> {
  if (harness.directPort > 0) {
    return harness.directPort;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  return waitForDirectPort(harness);
}

function registerRequest(input: {
  requestId: string;
  daemonPublicKeyB64: string;
  devicePublicKeyB64: string;
  deviceName?: string;
  pairingCode?: string;
}): string {
  return JSON.stringify({
    type: "session",
    message: {
      type: "pairing.device.register.request",
      requestId: input.requestId,
      daemonPublicKeyB64: input.daemonPublicKeyB64,
      devicePublicKeyB64: input.devicePublicKeyB64,
      ...(input.deviceName ? { deviceName: input.deviceName } : {}),
      ...(input.pairingCode ? { pairingCode: input.pairingCode } : {}),
    },
  });
}

function identifyRequest(input: {
  requestId: string;
  deviceName: string;
  devicePublicKeyB64?: string;
}): string {
  return JSON.stringify({
    type: "session",
    message: {
      type: "pairing.device.identify.request",
      requestId: input.requestId,
      deviceName: input.deviceName,
      ...(input.devicePublicKeyB64 ? { devicePublicKeyB64: input.devicePublicKeyB64 } : {}),
    },
  });
}

function cancelRequest(input: {
  requestId: string;
  targetRequestId: string;
  reason?: string;
}): string {
  return JSON.stringify({
    type: "session",
    message: {
      type: "pairing.device.cancel.request",
      requestId: input.requestId,
      targetRequestId: input.targetRequestId,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}

function signedHello(input: {
  clientId: string;
  nonce: string;
  key: DeviceKeyPair;
  devicePublicKeyB64: string;
}): string {
  return JSON.stringify({
    type: "hello",
    clientId: input.clientId,
    clientType: "mobile",
    protocolVersion: 1,
    nonce: input.nonce,
    signature: signNonce(input.key, input.nonce),
    devicePublicKeyB64: input.devicePublicKeyB64,
  });
}

describe("tailnet pairing handshake over a real WebSocket", () => {
  test("challenge → register → signed hello upgrades the session", async () => {
    const { harness, devices } = createPairingServerHarness();
    harnesses.push(harness);
    const port = await waitForPort(harness);
    const key = generateDeviceKeyPair();
    const publicKeyB64 = exportDevicePublicKey(key.publicKey);

    const client = createBufferedTailnetClient(port);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", (error) => reject(error));
    });

    // Daemon issues a single-use challenge on attach.
    const challenge = (await client.waitFor((m) => {
      const message = m as { type?: string };
      return message.type === "challenge";
    })) as { type: string; nonce: string };
    expect(challenge.nonce).toBeTruthy();

    // Unpaired device registers its public key.
    client.socket.send(
      registerRequest({
        requestId: "req-register-1",
        daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
        devicePublicKeyB64: publicKeyB64,
        deviceName: "My Phone",
      }),
    );
    const registerResponse = (await client.waitFor((m) => {
      const message = m as { type?: string; message?: { type?: string } };
      return (
        message.type === "session" && message.message?.type === "pairing.device.register.response"
      );
    })) as {
      message: {
        type: string;
        payload: { requestId: string; ok: boolean; deviceId: string };
      };
    };
    expect(registerResponse.message.payload).toMatchObject({
      requestId: "req-register-1",
      ok: true,
    });
    expect(registerResponse.message.payload.deviceId).toBeTruthy();
    expect(devices.list()).toHaveLength(1);

    // Signed hello with the daemon-issued nonce upgrades to a session.
    client.socket.send(
      signedHello({
        clientId: "client-mobile-1",
        nonce: challenge.nonce,
        key,
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    const serverInfo = (await client.waitFor((m) => {
      const message = m as { type?: string; message?: { payload?: { status?: string } } };
      return message.type === "session" && message.message?.payload?.status === "server_info";
    })) as { message: { payload: { serverId: string } } };
    expect(serverInfo.message.payload.serverId).toBe("srv-test");

    client.socket.close();
  });

  test("replays a pending request to a desktop that connects after the tailnet device", async () => {
    const { harness } = createPairingServerHarness({ enablePairingCode: true });
    harnesses.push(harness);
    const tailnetPort = await waitForPort(harness);
    const directPort = await waitForDirectPort(harness);

    // The mobile/tailnet socket arrives first. There is no trusted desktop
    // socket yet, so the initial broadcast has nowhere to go.
    const mobile = createBufferedTailnetClient(tailnetPort);
    await new Promise<void>((resolve, reject) => {
      mobile.socket.once("open", () => resolve());
      mobile.socket.once("error", (error) => reject(error));
    });
    await mobile.waitFor((message) => (message as { type?: string }).type === "challenge");
    mobile.socket.send(
      identifyRequest({
        requestId: "req-replay-identity",
        deviceName: "Replay device",
      }),
    );

    // A real local desktop session arrives after the request was emitted. The
    // daemon must replay the still-valid request during hello.
    const desktop = createBufferedTailnetClient(`ws://127.0.0.1:${directPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      desktop.socket.once("open", () => resolve());
      desktop.socket.once("error", (error) => reject(error));
    });
    desktop.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-desktop-replay",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );

    await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { payload?: { status?: string } } }).type ===
          "session" &&
        (message as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
          "server_info",
    );
    const request = (await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type === "pairing.device.requested",
    )) as {
      message: {
        type: string;
        payload: { requestId: string; pairingCode: string; expiresAtMs: number };
      };
    };

    expect(request.message.payload.requestId).toBeTruthy();
    expect(request.message.payload.pairingCode).toMatch(/^\d{6}$/);
    expect(request.message.payload.expiresAtMs).toBeGreaterThan(Date.now());

    mobile.socket.close();
    desktop.socket.close();
  });

  test("updates the pending request with the mobile device identity before code entry", async () => {
    const { harness } = createPairingServerHarness({ enablePairingCode: true });
    harnesses.push(harness);
    const tailnetPort = await waitForPort(harness);
    const directPort = await waitForDirectPort(harness);

    const desktop = createBufferedTailnetClient(`ws://127.0.0.1:${directPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      desktop.socket.once("open", () => resolve());
      desktop.socket.once("error", (error) => reject(error));
    });
    desktop.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-desktop-identity",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );
    await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { payload?: { status?: string } } }).type ===
          "session" &&
        (message as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
          "server_info",
    );

    const mobile = createBufferedTailnetClient(tailnetPort);
    await new Promise<void>((resolve, reject) => {
      mobile.socket.once("open", () => resolve());
      mobile.socket.once("error", (error) => reject(error));
    });
    await mobile.waitFor((message) => (message as { type?: string }).type === "challenge");

    mobile.socket.send(
      identifyRequest({
        requestId: "req-identify-1",
        deviceName: "Test device from OS",
        devicePublicKeyB64: "ZGV2aWNlLWtleQ==",
      }),
    );
    const request = (await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type === "pairing.device.requested" &&
        (message as { message?: { payload?: { deviceName?: string } } }).message?.payload
          ?.deviceName === "Test device from OS",
    )) as {
      message: {
        payload: {
          requestId: string;
          pairingCode: string;
          deviceName?: string;
          devicePublicKeyB64?: string;
        };
      };
    };

    expect(request.message.payload).toMatchObject({
      deviceName: "Test device from OS",
      devicePublicKeyB64: "ZGV2aWNlLWtleQ==",
    });
    expect(request.message.payload.pairingCode).toMatch(/^\d{6}$/);
    mobile.socket.close();
    desktop.socket.close();
  });

  test("reuses one request and code when the same device reconnects while waiting", async () => {
    const { harness, devices } = createPairingServerHarness({ enablePairingCode: true });
    harnesses.push(harness);
    const tailnetPort = await waitForPort(harness);
    const directPort = await waitForDirectPort(harness);
    const key = generateDeviceKeyPair();
    const publicKeyB64 = exportDevicePublicKey(key.publicKey);

    const desktop = createBufferedTailnetClient(`ws://127.0.0.1:${directPort}/ws`);
    await waitForSocketOpen(desktop);
    desktop.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-desktop-single-request",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );
    await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { payload?: { status?: string } } }).type ===
          "session" &&
        (message as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
          "server_info",
    );

    const firstMobile = createBufferedTailnetClient(tailnetPort);
    await waitForSocketOpen(firstMobile);
    await firstMobile.waitFor((message) => (message as { type?: string }).type === "challenge");
    firstMobile.socket.send(
      identifyRequest({
        requestId: "req-single-first-identity",
        deviceName: "Single request device",
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    const firstRequest = (await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type === "pairing.device.requested",
    )) as {
      message: {
        payload: { requestId: string; pairingCode: string; expiresAtMs: number };
      };
    };

    const secondMobile = createBufferedTailnetClient(tailnetPort);
    await waitForSocketOpen(secondMobile);
    const secondChallenge = (await secondMobile.waitFor(
      (message) => (message as { type?: string }).type === "challenge",
    )) as { nonce: string };
    const updatePromise = desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type === "pairing.device.requested" &&
        (
          message as {
            message?: { payload?: { requestId?: string; devicePublicKeyB64?: string } };
          }
        ).message?.payload?.requestId === firstRequest.message.payload.requestId,
    );
    secondMobile.socket.send(
      identifyRequest({
        requestId: "req-single-second-identity",
        deviceName: "Single request device",
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    const updatedRequest = (await updatePromise) as {
      message: {
        payload: { requestId: string; pairingCode: string; expiresAtMs: number };
      };
    };

    expect(updatedRequest.message.payload.requestId).toBe(firstRequest.message.payload.requestId);
    expect(updatedRequest.message.payload.pairingCode).toBe(
      firstRequest.message.payload.pairingCode,
    );
    expect(updatedRequest.message.payload.expiresAtMs).toBe(
      firstRequest.message.payload.expiresAtMs,
    );
    const requestedIds = desktop.messages
      .filter(
        (message) =>
          (message as { type?: string; message?: { type?: string } }).type === "session" &&
          (message as { message?: { type?: string } }).message?.type === "pairing.device.requested",
      )
      .map(
        (message) =>
          (
            message as {
              message?: { payload?: { requestId?: string } };
            }
          ).message?.payload?.requestId,
      );
    expect(new Set(requestedIds)).toEqual(new Set([firstRequest.message.payload.requestId]));

    secondMobile.socket.send(
      registerRequest({
        requestId: "req-single-register",
        daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
        devicePublicKeyB64: publicKeyB64,
        deviceName: "Single request device",
        pairingCode: firstRequest.message.payload.pairingCode,
      }),
    );
    await secondMobile.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type ===
          "pairing.device.register.response",
    );
    secondMobile.socket.send(
      signedHello({
        clientId: "client-mobile-single-request",
        nonce: secondChallenge.nonce,
        key,
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    await secondMobile.waitFor(
      (message) =>
        (message as { type?: string; message?: { payload?: { status?: string } } }).type ===
          "session" &&
        (message as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
          "server_info",
    );
    await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type === "pairing.device.completed",
    );

    expect(devices.list()).toHaveLength(1);
    firstMobile.socket.close();
    secondMobile.socket.close();
    desktop.socket.close();
  });

  test("declines a pending request, notifies both clients, and closes mobile", async () => {
    const { harness, devices } = createPairingServerHarness({ enablePairingCode: true });
    harnesses.push(harness);
    const tailnetPort = await waitForPort(harness);
    const directPort = await waitForDirectPort(harness);

    const desktop = createBufferedTailnetClient(`ws://127.0.0.1:${directPort}/ws`);
    await waitForSocketOpen(desktop);
    desktop.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-desktop-cancel",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );
    await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { payload?: { status?: string } } }).type ===
          "session" &&
        (message as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
          "server_info",
    );

    const mobile = createBufferedTailnetClient(tailnetPort);
    await waitForSocketOpen(mobile);
    await mobile.waitFor((message) => (message as { type?: string }).type === "challenge");
    mobile.socket.send(
      identifyRequest({
        requestId: "req-cancel-identity",
        deviceName: "Test mobile device",
        devicePublicKeyB64: "ZGV2aWNlLWtleQ==",
      }),
    );

    const request = (await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type === "pairing.device.requested",
    )) as { message: { payload: { requestId: string; pairingCode: string } } };
    expect(request.message.payload.pairingCode).toMatch(/^\d{6}$/);

    const mobileClose = mobile.waitForClose();
    desktop.socket.send(
      cancelRequest({
        requestId: "req-cancel-operation",
        targetRequestId: request.message.payload.requestId,
      }),
    );

    const cancellationEvent = await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type === "pairing.device.cancelled",
    );
    expect(cancellationEvent).toMatchObject({
      message: {
        payload: { requestId: request.message.payload.requestId },
      },
    });
    const cancellationResponse = await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { type?: string } }).type === "session" &&
        (message as { message?: { type?: string } }).message?.type ===
          "pairing.device.cancel.response",
    );
    expect(cancellationResponse).toMatchObject({
      message: {
        payload: {
          requestId: "req-cancel-operation",
          targetRequestId: request.message.payload.requestId,
          ok: true,
        },
      },
    });

    await expect(
      mobile.waitFor(
        (message) =>
          (message as { type?: string; message?: { type?: string } }).type === "session" &&
          (message as { message?: { type?: string } }).message?.type === "pairing.device.cancelled",
      ),
    ).resolves.toMatchObject({
      message: {
        payload: { requestId: request.message.payload.requestId },
      },
    });
    await expect(mobileClose).resolves.toMatchObject({
      code: 4408,
      reason: "Pairing request declined",
    });
    expect(devices.list()).toHaveLength(0);

    desktop.socket.close();
  });

  test("idempotently completes a duplicate registration from a reconnecting device", async () => {
    const { harness, devices } = createPairingServerHarness({ enablePairingCode: true });
    harnesses.push(harness);
    const tailnetPort = await waitForPort(harness);
    const directPort = await waitForDirectPort(harness);
    const key = generateDeviceKeyPair();
    const publicKeyB64 = exportDevicePublicKey(key.publicKey);

    const desktop = createBufferedTailnetClient(`ws://127.0.0.1:${directPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      desktop.socket.once("open", () => resolve());
      desktop.socket.once("error", (error) => reject(error));
    });
    desktop.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-desktop-idempotent",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );
    await desktop.waitFor(
      (message) =>
        (message as { type?: string; message?: { payload?: { status?: string } } }).type ===
          "session" &&
        (message as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
          "server_info",
    );

    const connectAndRegister = async (requestId: string, previousRequestId?: string) => {
      const requestPromise = desktop.waitFor((message) => {
        const candidate = message as {
          type?: string;
          message?: { type?: string; payload?: { requestId?: string } };
        };
        return (
          candidate.type === "session" &&
          candidate.message?.type === "pairing.device.requested" &&
          candidate.message.payload?.requestId !== previousRequestId
        );
      });
      const mobile = createBufferedTailnetClient(tailnetPort);
      await new Promise<void>((resolve, reject) => {
        mobile.socket.once("open", () => resolve());
        mobile.socket.once("error", (error) => reject(error));
      });
      const challenge = (await mobile.waitFor(
        (message) => (message as { type?: string }).type === "challenge",
      )) as { nonce: string };
      mobile.socket.send(
        identifyRequest({
          requestId: `${requestId}-identity`,
          deviceName: "Idempotent device",
          devicePublicKeyB64: publicKeyB64,
        }),
      );
      const request = (await requestPromise) as {
        message: {
          type: string;
          payload: { requestId: string; pairingCode: string; expiresAtMs: number };
        };
      };

      mobile.socket.send(
        registerRequest({
          requestId,
          daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
          devicePublicKeyB64: publicKeyB64,
          pairingCode: request.message.payload.pairingCode,
        }),
      );
      const response = (await mobile.waitFor(
        (message) =>
          (message as { type?: string; message?: { type?: string } }).type === "session" &&
          (message as { message?: { type?: string } }).message?.type ===
            "pairing.device.register.response",
      )) as { message: { payload: { ok: boolean; deviceId: string } } };
      mobile.socket.send(
        signedHello({
          clientId: "client-mobile-idempotent",
          nonce: challenge.nonce,
          key,
          devicePublicKeyB64: publicKeyB64,
        }),
      );
      await mobile.waitFor(
        (message) =>
          (message as { type?: string; message?: { payload?: { status?: string } } }).type ===
            "session" &&
          (message as { message?: { payload?: { status?: string } } }).message?.payload?.status ===
            "server_info",
      );
      return { mobile, request, deviceId: response.message.payload.deviceId };
    };

    const first = await connectAndRegister("req-idempotent-first");
    await desktop.waitFor(
      (message) =>
        (
          message as {
            type?: string;
            message?: { type?: string; payload?: { requestId?: string } };
          }
        ).type === "session" &&
        (message as { message?: { type?: string; payload?: { requestId?: string } } }).message
          ?.type === "pairing.device.completed" &&
        (message as { message?: { payload?: { requestId?: string } } }).message?.payload
          ?.requestId === first.request.message.payload.requestId,
    );
    first.mobile.socket.close();

    const second = await connectAndRegister(
      "req-idempotent-second",
      first.request.message.payload.requestId,
    );
    expect(second.request.message.payload.pairingCode).not.toBe(
      first.request.message.payload.pairingCode,
    );
    const completion = (await desktop.waitFor(
      (message) =>
        (
          message as {
            type?: string;
            message?: { type?: string; payload?: { requestId?: string } };
          }
        ).type === "session" &&
        (message as { message?: { type?: string; payload?: { requestId?: string } } }).message
          ?.type === "pairing.device.completed" &&
        (message as { message?: { payload?: { requestId?: string } } }).message?.payload
          ?.requestId === second.request.message.payload.requestId,
    )) as { message: { payload: { deviceId: string } } };

    expect(completion.message.payload.deviceId).toBe(first.deviceId);
    expect(second.deviceId).toBe(first.deviceId);
    expect(devices.list()).toHaveLength(1);

    second.mobile.socket.close();
    desktop.socket.close();
  });

  test("rejects a hello without a challenge response fail-closed with 4401", async () => {
    const { harness } = createPairingServerHarness();
    harnesses.push(harness);
    const port = await waitForPort(harness);

    const client = createBufferedTailnetClient(port);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", (error) => reject(error));
    });
    await client.waitFor((m) => (m as { type?: string }).type === "challenge");

    client.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-rogue",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );
    const close = await client.waitForClose();
    expect(close.code).toBe(4401);
  });

  test("rejects a signature from an unpaired device with 4401", async () => {
    const { harness } = createPairingServerHarness();
    harnesses.push(harness);
    const port = await waitForPort(harness);
    const rogueKey = generateDeviceKeyPair();
    const roguePublicKeyB64 = exportDevicePublicKey(rogueKey.publicKey);

    const client = createBufferedTailnetClient(port);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", (error) => reject(error));
    });
    const challenge = (await client.waitFor((m) => {
      return (m as { type?: string }).type === "challenge";
    })) as { type: string; nonce: string };

    client.socket.send(
      signedHello({
        clientId: "client-rogue",
        nonce: challenge.nonce,
        key: rogueKey,
        devicePublicKeyB64: roguePublicKeyB64,
      }),
    );
    const close = await client.waitForClose();
    expect(close.code).toBe(4401);
  });

  test("direct gate off by default: a plain direct hello is accepted without a challenge", async () => {
    const { harness } = createPairingServerHarness();
    harnesses.push(harness);
    const directPort = await waitForDirectPort(harness);

    const client = createBufferedTailnetClient(`ws://127.0.0.1:${directPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", (error) => reject(error));
    });

    client.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-local",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );
    const serverInfo = (await client.waitFor((m) => {
      const message = m as { type?: string; message?: { payload?: { status?: string } } };
      return message.type === "session" && message.message?.payload?.status === "server_info";
    })) as { message: { payload: { serverId: string } } };
    expect(serverInfo.message.payload.serverId).toBe("srv-test");

    client.socket.close();
  });

  test("direct gate on: issues a challenge and rejects an unsigned direct hello with 4401", async () => {
    const { harness } = createPairingServerHarness({ requireSignedHelloForDirect: true });
    harnesses.push(harness);
    const directPort = await waitForDirectPort(harness);

    const client = createBufferedTailnetClient(`ws://127.0.0.1:${directPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", (error) => reject(error));
    });

    const challenge = (await client.waitFor(
      (m) => (m as { type?: string }).type === "challenge",
    )) as { type: string; nonce: string };
    expect(challenge.nonce).toBeTruthy();

    client.socket.send(
      JSON.stringify({
        type: "hello",
        clientId: "client-local",
        clientType: "mobile",
        protocolVersion: 1,
      }),
    );
    const close = await client.waitForClose();
    expect(close.code).toBe(4401);
  });

  test("direct gate on: a paired device's signed hello upgrades over direct", async () => {
    const { harness, devices } = createPairingServerHarness({ requireSignedHelloForDirect: true });
    harnesses.push(harness);
    const directPort = await waitForDirectPort(harness);
    const key = generateDeviceKeyPair();
    const publicKeyB64 = exportDevicePublicKey(key.publicKey);
    // Mirror the desktop owner self-bootstrap: the local device is already trusted.
    devices.register({ devicePublicKeyB64: publicKeyB64, deviceName: "Local owner" });

    const client = createBufferedTailnetClient(`ws://127.0.0.1:${directPort}/ws`);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", (error) => reject(error));
    });

    const challenge = (await client.waitFor(
      (m) => (m as { type?: string }).type === "challenge",
    )) as { type: string; nonce: string };

    client.socket.send(
      signedHello({
        clientId: "client-local",
        nonce: challenge.nonce,
        key,
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    const serverInfo = (await client.waitFor((m) => {
      const message = m as { type?: string; message?: { payload?: { status?: string } } };
      return message.type === "session" && message.message?.payload?.status === "server_info";
    })) as { message: { payload: { serverId: string } } };
    expect(serverInfo.message.payload.serverId).toBe("srv-test");

    client.socket.close();
  });

  test("rejects a valid signature when its nonce belongs to another socket", async () => {
    const { harness, devices } = createPairingServerHarness();
    harnesses.push(harness);
    const port = await waitForPort(harness);
    const key = generateDeviceKeyPair();
    const publicKeyB64 = exportDevicePublicKey(key.publicKey);

    const first = createBufferedTailnetClient(port);
    const second = createBufferedTailnetClient(port);
    await Promise.all([first, second].map((client) => waitForSocketOpen(client)));
    const firstChallenge = (await first.waitFor((m) => {
      return (m as { type?: string }).type === "challenge";
    })) as { type: string; nonce: string };
    await second.waitFor((m) => (m as { type?: string }).type === "challenge");

    first.socket.send(
      registerRequest({
        requestId: "req-register-cross-socket",
        daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    await first.waitFor((m) => {
      const message = m as { message?: { type?: string } };
      return message.message?.type === "pairing.device.register.response";
    });
    expect(devices.list()).toHaveLength(1);

    second.socket.send(
      signedHello({
        clientId: "client-cross-socket",
        nonce: firstChallenge.nonce,
        key,
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    const close = await second.waitForClose();
    expect(close.code).toBe(4401);
    first.socket.close();
    second.socket.close();
  });

  test("nonce is single-use: replaying a signed hello is rejected", async () => {
    const { harness } = createPairingServerHarness();
    harnesses.push(harness);
    const port = await waitForPort(harness);
    const key = generateDeviceKeyPair();
    const publicKeyB64 = exportDevicePublicKey(key.publicKey);

    const client = createBufferedTailnetClient(port);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", (error) => reject(error));
    });
    const challenge = (await client.waitFor((m) => {
      return (m as { type?: string }).type === "challenge";
    })) as { type: string; nonce: string };
    client.socket.send(
      registerRequest({
        requestId: "req-register-2",
        daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    await client.waitFor((m) => {
      const message = m as { message?: { type?: string } };
      return message.message?.type === "pairing.device.register.response";
    });

    client.socket.send(
      signedHello({
        clientId: "client-replay",
        nonce: challenge.nonce,
        key,
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    await client.waitFor((m) => {
      const message = m as { message?: { payload?: { status?: string } } };
      return message.message?.payload?.status === "server_info";
    });

    // Second connection presenting the same consumed nonce must fail closed.
    const second = createBufferedTailnetClient(port);
    await new Promise<void>((resolve, reject) => {
      second.socket.once("open", () => resolve());
      second.socket.once("error", (error) => reject(error));
    });
    await second.waitFor((m) => (m as { type?: string }).type === "challenge");
    second.socket.send(
      signedHello({
        clientId: "client-replay-2",
        nonce: challenge.nonce,
        key,
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    const close = await second.waitForClose();
    expect(close.code).toBe(4401);
    second.socket.close();
    client.socket.close();
  });

  test("registering against the wrong daemon public key is rejected", async () => {
    const { harness } = createPairingServerHarness();
    harnesses.push(harness);
    const port = await waitForPort(harness);
    const key = generateDeviceKeyPair();
    const publicKeyB64 = exportDevicePublicKey(key.publicKey);

    const client = createBufferedTailnetClient(port);
    await new Promise<void>((resolve, reject) => {
      client.socket.once("open", () => resolve());
      client.socket.once("error", (error) => reject(error));
    });
    await client.waitFor((m) => (m as { type?: string }).type === "challenge");

    client.socket.send(
      registerRequest({
        requestId: "req-register-3",
        daemonPublicKeyB64: "d3JvbmctZGFlbW9uLWtleQ==",
        devicePublicKeyB64: publicKeyB64,
      }),
    );
    const response = (await client.waitFor((m) => {
      const message = m as { message?: { type?: string } };
      return message.message?.type === "pairing.device.register.response";
    })) as { message: { payload: { ok: boolean; error: string } } };
    expect(response.message.payload.ok).toBe(false);
    expect(response.message.payload.error).toBe("daemon public key mismatch");
    client.socket.close();
  });
});
