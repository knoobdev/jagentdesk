import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify } from "node:crypto";
import pino from "pino";
import {
  startRelayTransport,
  type RelaySocketLike,
  type RelayTransportController,
} from "./relay-transport.js";
import { RELAY_OWNERSHIP_SIGNATURE_PREFIX, type RelayOwnershipSigner } from "./daemon-keypair.js";

function createMockLogger() {
  const messages: { level: "debug" | "info" | "warn" | "error"; args: unknown[] }[] = [];
  const logger = {
    messages,
    child: () => logger,
    debug: (...args: unknown[]) => messages.push({ level: "debug", args }),
    info: (...args: unknown[]) => messages.push({ level: "info", args }),
    warn: (...args: unknown[]) => messages.push({ level: "warn", args }),
    error: (...args: unknown[]) => messages.push({ level: "error", args }),
  };
  return logger;
}

type TestLogger = ReturnType<typeof createMockLogger>;

function hasLogMessage(logger: TestLogger, level: "info" | "warn", message: string): boolean {
  return logger.messages.some((entry) => {
    return entry.level === level && entry.args.some((arg) => arg === message);
  });
}

/** Real Ed25519 signer: the fake relay verifies signatures against its JWK. */
interface TestOwnership {
  signer: RelayOwnershipSigner;
  verifySignature(nonce: string, serverId: string, signatureB64url: string): boolean;
}

function createTestOwnership(): TestOwnership {
  const keys = generateKeyPairSync("ed25519");
  const publicKeyJwk = keys.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    signer: {
      publicKeyB64url: String(publicKeyJwk.x),
      signOwnership(serverId, nonce) {
        return cryptoSign(
          null,
          Buffer.from(`${RELAY_OWNERSHIP_SIGNATURE_PREFIX}:${serverId}:${nonce}`, "utf8"),
          keys.privateKey,
        ).toString("base64url");
      },
    },
    verifySignature(nonce, serverId, signatureB64url) {
      return verify(
        null,
        Buffer.from(`${RELAY_OWNERSHIP_SIGNATURE_PREFIX}:${serverId}:${nonce}`, "utf8"),
        createPublicKey({ format: "jwk", key: publicKeyJwk }),
        Buffer.from(signatureB64url, "base64url"),
      );
    },
  };
}

class FakeRelayWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeRelayWebSocket.CONNECTING;
  sent: Array<string | Uint8Array | ArrayBuffer> = [];
  terminateCalls = 0;
  pingCalls = 0;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(readonly url: string) {}

  on(event: string, listener: (...args: unknown[]) => void) {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  once(event: string, listener: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    this.on(event, wrapped);
  }

  close(code?: number, reason?: string) {
    this.readyState = FakeRelayWebSocket.CLOSED;
    this.emit("close", code ?? 1000, reason ?? "");
  }

  terminate() {
    this.terminateCalls += 1;
    this.readyState = FakeRelayWebSocket.CLOSED;
    this.emit("close", 1006, "");
  }

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) {
    if (this.readyState !== FakeRelayWebSocket.OPEN) {
      throw new Error(`WebSocket not open (readyState=${this.readyState})`);
    }
    this.sent.push(data);
    callback?.();
  }

  ping() {
    if (this.readyState !== FakeRelayWebSocket.OPEN) {
      throw new Error(`WebSocket not open (readyState=${this.readyState})`);
    }
    this.pingCalls += 1;
  }

  open() {
    this.readyState = FakeRelayWebSocket.OPEN;
    this.emit("open");
  }

  message(data: unknown, isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    this.emit("message", data, isBinary);
  }

  pong() {
    this.emit("pong");
  }

  /** Parse frames the transport wrote out (the guard's relay_auth, control pongs). */
  parsedSent(): Array<Record<string, unknown>> {
    return this.sent.map((frame) => JSON.parse(String(frame)) as Record<string, unknown>);
  }

  private off(event: string, listener: (...args: unknown[]) => void) {
    const handlers = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      handlers.filter((handler) => handler !== listener),
    );
  }

  private emit(event: string, ...args: unknown[]) {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of handlers.slice()) {
      handler(...args);
    }
  }
}

function createFakeWebSockets() {
  const sockets: FakeRelayWebSocket[] = [];
  return {
    sockets,
    createWebSocket(url: string) {
      const socket = new FakeRelayWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}

/** Answer the ownership challenge like the relay Durable Object does. */
function authenticate(socket: FakeRelayWebSocket, ownership: TestOwnership, serverId: string) {
  const nonce = "nonce-" + socket.url.slice(-6);
  socket.message(JSON.stringify({ type: "relay_challenge", v: 1, nonce }));
  const auth = socket.parsedSent().find((frame) => frame.type === "relay_auth");
  expect(auth).toBeDefined();
  expect(auth?.publicKey).toBe(ownership.signer.publicKeyB64url);
  expect(ownership.verifySignature(nonce, serverId, String(auth?.signature))).toBe(true);
  socket.message(JSON.stringify({ type: "relay_auth_ok" }));
}

describe("relay-transport control lifecycle", () => {
  const controllers: RelayTransportController[] = [];
  let relay: ReturnType<typeof createFakeWebSockets>;
  let ownership: TestOwnership;

  beforeEach(() => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    relay = createFakeWebSockets();
    ownership = createTestOwnership();
  });

  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.stop()));
    controllers.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function start(
    options: { attachSocket?: (socket: RelaySocketLike, metadata?: unknown) => Promise<void> } = {},
  ) {
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket: options.attachSocket ?? (async () => {}),
      relayEndpoint: "relay.jagentdesk.sh:443",
      relayUseTls: true,
      serverId: "srv_test",
      relayOwnership: ownership.signer,
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);
    return { logger, controller };
  }

  test("answers the ownership challenge on the control socket before anything else", () => {
    const { logger } = start();
    const control = relay.sockets[0];
    expect(control).toBeDefined();

    control.open();
    // Nothing reaches the transport logic until the guard authenticates:
    // a control message sent pre-auth is buffered, not acted on.
    authenticate(control, ownership, "srv_test");
    expect(control.parsedSent()[0]?.type).toBe("relay_auth");

    expect(hasLogMessage(logger, "info", "relay_control_connected")).toBe(false);
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    expect(hasLogMessage(logger, "info", "relay_control_connected")).toBe(true);
  });

  test("rejects a relay that sends no ownership challenge", () => {
    const { logger } = start();
    const control = relay.sockets[0];
    control.open();
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    expect(hasLogMessage(logger, "info", "relay_control_connected")).toBe(false);
    expect(control.readyState).toBe(FakeRelayWebSocket.CLOSED);
    expect(control.sent.some((frame) => String(frame).includes("relay_auth"))).toBe(false);
  });

  test("logs relay_control_connected only after first valid control message", () => {
    const { logger } = start();
    const control = relay.sockets[0];
    expect(control).toBeDefined();

    control.open();
    authenticate(control, ownership, "srv_test");
    expect(hasLogMessage(logger, "info", "relay_control_connected")).toBe(false);
    expect(control.pingCalls).toBeGreaterThan(0);

    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    expect(hasLogMessage(logger, "info", "relay_control_connected")).toBe(true);
  });

  test("terminates and reconnects when control socket opens but never becomes ready", () => {
    vi.useFakeTimers();
    const { logger } = start();
    const firstControl = relay.sockets[0];
    firstControl.open();
    authenticate(firstControl, ownership, "srv_test");

    vi.advanceTimersByTime(8_000);
    expect(hasLogMessage(logger, "warn", "relay_control_ready_timeout_terminating")).toBe(true);
    expect(firstControl.terminateCalls).toBe(1);

    vi.advanceTimersByTime(1_500);
    expect(relay.sockets.length).toBeGreaterThanOrEqual(2);
  });

  test("terminates stale control sockets after missed keepalives", () => {
    vi.useFakeTimers();
    const { logger } = start();
    const control = relay.sockets[0];
    control.open();
    authenticate(control, ownership, "srv_test");
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    logger.messages.length = 0;

    vi.advanceTimersByTime(90_000);
    expect(hasLogMessage(logger, "warn", "relay_control_stale_terminating")).toBe(true);
    expect(control.terminateCalls).toBe(1);
  });

  test("authenticates the data socket, then attaches it with relay metadata", async () => {
    const attachedSockets: RelaySocketLike[] = [];
    const attachedMetadata: unknown[] = [];
    start({
      attachSocket: async (socket, metadata) => {
        attachedSockets.push(socket);
        attachedMetadata.push(metadata);
      },
    });

    const control = relay.sockets[0];
    control.open();
    authenticate(control, ownership, "srv_test");
    control.message(JSON.stringify({ type: "connected", connectionId: "clt_test" }));

    const dataSocket = relay.sockets[1];
    expect(dataSocket).toBeDefined();
    dataSocket.open();
    await Promise.resolve();

    expect(attachedSockets).toHaveLength(1);
    expect(attachedMetadata).toEqual([
      {
        transport: "relay",
        externalSessionKey: "session:clt_test",
        relayConnectionId: "clt_test",
      },
    ]);

    // Ownership preflight runs on data sockets too, before session traffic.
    authenticate(dataSocket, ownership, "srv_test");
    expect(dataSocket.parsedSent()[0]?.type).toBe("relay_auth");

    // Post-auth messages flow through the guard to the attached socket.
    const received: unknown[] = [];
    attachedSockets[0].on("message", (data) => received.push(data));
    dataSocket.message('{"type":"hello"}');
    expect(received).toEqual(['{"type":"hello"}']);
  });

  test("uses relayUseTls for control and data socket URLs", () => {
    start();
    const control = relay.sockets[0];
    control.open();
    authenticate(control, ownership, "srv_test");
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    control.message(JSON.stringify({ type: "connected", connectionId: "clt_test" }));

    expect(relay.sockets[0]?.url).toMatch(/^wss:\/\/relay\.jagentdesk\.sh\/ws\?/);
    expect(relay.sockets[1]?.url).toMatch(/^wss:\/\/relay\.jagentdesk\.sh\/ws\?/);
  });

  test("bare endpoints dial port 443", () => {
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket: async () => {},
      relayEndpoint: "jagentdesk-relay.workers.dev",
      relayUseTls: true,
      serverId: "srv_test",
      relayOwnership: ownership.signer,
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);
    expect(relay.sockets[0]?.url).toMatch(/^wss:\/\/jagentdesk-relay\.workers\.dev\/ws\?/);
  });
});
