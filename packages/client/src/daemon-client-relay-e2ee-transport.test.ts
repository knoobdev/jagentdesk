import { DaemonClient } from "./daemon-client.js";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createDaemonChannel,
  exportPublicKey,
  generateKeyPair,
  openDaemonSecureChannel,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  type SecureChannel,
  type Transport as RelayTransport,
  type TransportMessage,
} from "@jagentdesk/relay/e2ee";
import {
  createEncryptedTransport,
  createRelayUpgradeTransportFactory,
  describeEndpointSecurityClose,
  type RelayE2eeTransportOptions,
} from "./daemon-client-relay-e2ee-transport.js";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
} from "./daemon-client-transport-types.js";

const logger: TransportLogger = { warn: () => {} };

interface WireFrame {
  direction: "client-to-relay" | "relay-to-daemon";
  bytes: Buffer;
}

/** In-memory relay wire: each frame is logged and delivered to the peer asynchronously. */
class LinkedTransport implements RelayTransport {
  peer: LinkedTransport | null = null;
  onmessage: ((message: TransportMessage) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: ((error: Error) => void) | null = null;

  constructor(
    private readonly direction: WireFrame["direction"],
    private readonly wireLog: WireFrame[],
  ) {}

  send(data: string | ArrayBuffer): void {
    this.wireLog.push({
      direction: this.direction,
      bytes: Buffer.from(typeof data === "string" ? data : new Uint8Array(data)),
    });
    const peer = this.peer;
    const payload = data;
    queueMicrotask(() => {
      peer?.onmessage?.({ data: payload, isBinary: typeof payload !== "string" });
    });
  }

  close(code = 1000, reason = ""): void {
    const peer = this.peer;
    queueMicrotask(() => {
      peer?.onclose?.(code, reason);
    });
  }
}

/** Browser-style DaemonTransport over a LinkedTransport (what the WSS upgrade yields). */
class ClientBaseTransport implements DaemonTransport {
  private readonly openHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<(event?: unknown) => void>();
  private readonly errorHandlers = new Set<(event?: unknown) => void>();
  private readonly messageHandlers = new Set<(data: unknown, isBinary: boolean) => void>();

  constructor(readonly wire: LinkedTransport) {
    // The relay Transport contract exposes callback properties, not DOM listeners.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    wire.onmessage = (message) => {
      for (const handler of Array.from(this.messageHandlers)) {
        handler(message.data, message.isBinary);
      }
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    wire.onclose = (code, reason) => {
      for (const handler of Array.from(this.closeHandlers)) {
        handler({ code, reason });
      }
    };
  }

  simulateOpen(): void {
    queueMicrotask(() => {
      for (const handler of Array.from(this.openHandlers)) handler();
    });
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (typeof data === "string") {
      this.wire.send(data);
      return;
    }
    this.wire.send(
      data instanceof ArrayBuffer ? data : data.slice().buffer.slice(0, data.byteLength),
    );
  }

  close(code?: number, reason?: string): void {
    this.wire.close(code, reason);
  }

  onMessage(handler: (data: unknown, isBinary: boolean) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onOpen(handler: () => void): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  onClose(handler: (event?: unknown) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  onError(handler: (event?: unknown) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }
}

interface DaemonChannel {
  send(data: string | ArrayBuffer): void | Promise<void>;
  securityMode?(): string;
  isOpen?(): boolean;
}

interface Fixture {
  client: DaemonTransport;
  base: ClientBaseTransport;
  wireLog: WireFrame[];
  daemonInbox: Array<string | ArrayBuffer>;
  getDaemonChannel(): Promise<DaemonChannel>;
  securityModes: string[];
  closes: unknown[];
}

function createFixture(
  clientOptions: Partial<RelayE2eeTransportOptions> = {},
  daemon: "modern" | "protected-only" | "legacy-only" = "modern",
): Fixture {
  const wireLog: WireFrame[] = [];
  const clientWire = new LinkedTransport("client-to-relay", wireLog);
  const daemonWire = new LinkedTransport("relay-to-daemon", wireLog);
  clientWire.peer = daemonWire;
  daemonWire.peer = clientWire;

  const daemonKeyPair = generateKeyPair();
  const daemonInbox: Array<string | ArrayBuffer> = [];
  let resolveChannel: (channel: DaemonChannel) => void = () => {};
  const channelPromise = new Promise<DaemonChannel>((resolve) => {
    resolveChannel = resolve;
  });
  const daemonChannelPromise =
    daemon === "legacy-only"
      ? createDaemonChannel(daemonWire, daemonKeyPair, {
          onmessage: (data) => {
            daemonInbox.push(data);
          },
        }).then((channel) => {
          resolveChannel(channel as unknown as DaemonChannel);
          return channel;
        })
      : openDaemonSecureChannel(daemonWire, {
          daemonKeyPair,
          minimumMode: daemon === "protected-only" ? "protected" : "legacy",
          events: {
            onmessage: (data) => {
              daemonInbox.push(data);
            },
          },
        }).then((channel: SecureChannel) => {
          resolveChannel(channel);
          return channel;
        });

  const base = new ClientBaseTransport(clientWire);
  const securityModes: string[] = [];
  const closes: unknown[] = [];
  const client = createEncryptedTransport(base, {
    logger,
    daemonPublicKeyB64: exportPublicKey(daemonKeyPair.publicKey),
    onSecurityMode: (mode) => securityModes.push(mode),
    ...clientOptions,
  });
  client.onClose((event) => closes.push(event));
  base.simulateOpen();
  void daemonChannelPromise.catch(() => {
    // Rejections surface through the channels' close paths in assertions.
  });

  return {
    client,
    base,
    wireLog,
    daemonInbox,
    securityModes,
    closes,
    getDaemonChannel: () => channelPromise,
  };
}

async function waitForClientOpen(fixture: Fixture): Promise<void> {
  let openResolve: () => void = () => {};
  const openPromise = new Promise<void>((resolve) => {
    openResolve = resolve;
  });
  fixture.client.onOpen(openResolve);
  await openPromise;
}

describe("relay E2EE client transport (spec 35.3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("completes the Noise NK handshake and carries decrypted frames both ways", async () => {
    const fixture = createFixture();
    await waitForClientOpen(fixture);
    // A modern relay pair negotiates the conforming Noise protected mode.
    expect(fixture.securityModes).toEqual(["protected"]);

    fixture.client.send('{"type":"hello"}');
    await vi.waitFor(() => expect(fixture.daemonInbox).toEqual(['{"type":"hello"}']));

    const daemonChannel = await fixture.getDaemonChannel();
    const received: unknown[] = [];
    fixture.client.onMessage((data) => received.push(data));
    await daemonChannel.send("daemon-payload");
    await vi.waitFor(() => expect(received).toEqual(["daemon-payload"]));
  });

  test("plaintext never appears on the relay wire", async () => {
    const fixture = createFixture();
    await waitForClientOpen(fixture);

    const secret = "TOP-SECRET-agent-output-PASEO-XRAY";
    fixture.client.send(secret);
    await vi.waitFor(() => expect(fixture.daemonInbox).toEqual([secret]));

    const secretBytes = Buffer.from(secret, "utf8");
    for (const frame of fixture.wireLog) {
      expect(frame.bytes.includes(secretBytes.slice(0, 16))).toBe(false);
    }
    expect(fixture.wireLog.length).toBeGreaterThan(0);
  });

  test("downgrade guard closes when the daemon advertises protected support on a legacy channel", async () => {
    const fixture = createFixture({}, "legacy-only");
    await waitForClientOpen(fixture);
    expect(fixture.securityModes).toEqual(["legacy"]);

    const serverInfo = JSON.stringify({
      type: "session",
      message: {
        type: "status",
        payload: { status: "server_info", features: { relayProtectedSecurity: true } },
      },
    });
    const daemonChannel = await fixture.getDaemonChannel();
    await daemonChannel.send(serverInfo);

    await vi.waitFor(() => expect(fixture.closes.length).toBeGreaterThan(0));
    const closeEvent = fixture.closes[0] as { code?: number; reason?: string };
    expect(closeEvent.code).toBe(PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE);
    expect(describeEndpointSecurityClose(closeEvent)).toContain("handshake failed");
  });

  test("a protected-only daemon admits the channel in protected mode", async () => {
    const fixture = createFixture({}, "protected-only");
    await waitForClientOpen(fixture);
    expect(fixture.securityModes).toEqual(["protected"]);

    fixture.client.send("protected-hello");
    await vi.waitFor(() => expect(fixture.daemonInbox).toEqual(["protected-hello"]));
  });

  test("send throws synchronously past the relay frame budget without closing the transport", async () => {
    const fixture = createFixture();
    await waitForClientOpen(fixture);

    const oversized = "a".repeat(33 * 1024 * 1024);
    expect(() => fixture.client.send(oversized)).toThrow(/too large to send/i);
    expect(fixture.closes).toEqual([]);

    // The transport keeps working afterwards.
    fixture.client.send("still-open");
    await vi.waitFor(() => expect(fixture.daemonInbox).toEqual(["still-open"]));
  });

  test("close propagates code and reason to the daemon channel", async () => {
    const fixture = createFixture();
    await waitForClientOpen(fixture);
    const daemonChannel = await fixture.getDaemonChannel();

    fixture.client.close(1001, "going away");
    await vi.waitFor(() => expect(daemonChannel.isOpen?.()).toBe(false));
    expect((fixture.closes[0] as { code?: number }).code).toBe(1001);
  });

  test("relay upgrade factory strips credentials and subprotocols from the base factory", () => {
    const seen: Array<{ url: string; headers?: unknown; protocols?: unknown }> = [];
    const baseFactory: DaemonTransportFactory = ((options: {
      url: string;
      headers?: Record<string, string>;
      protocols?: string[];
    }) => {
      seen.push({ url: options.url, headers: options.headers, protocols: options.protocols });
      return {} as DaemonTransport;
    }) as DaemonTransportFactory;

    const factory = createRelayUpgradeTransportFactory(baseFactory);
    factory({
      url: "wss://relay.test/ws?serverId=srv",
      headers: { Authorization: "secret" },
      protocols: ["daemon-v1"],
    });

    expect(seen).toEqual([
      { url: "wss://relay.test/ws?serverId=srv", headers: undefined, protocols: undefined },
    ]);
  });

  test("describeEndpointSecurityClose ignores unrelated close events", () => {
    expect(describeEndpointSecurityClose({ code: 1006 })).toBeNull();
    expect(describeEndpointSecurityClose(null)).toBeNull();
  });
});

test.each([
  { e2ee: undefined, error: "Relay connections require E2EE" },
  { e2ee: { enabled: true }, error: "daemonPublicKeyB64 is required for relay E2EE" },
])(
  "rejects insecure relay configuration before opening a socket: $error",
  async ({ e2ee, error }) => {
    const factory = vi.fn(() => {
      throw new Error("Unexpected transport creation");
    });
    const client = new DaemonClient({
      url: "wss://desk-relay.jagents.workers.dev/ws?serverId=srv_1&role=client&v=2",
      clientId: "relay-config-test",
      e2ee,
      transportFactory: factory,
      reconnect: { enabled: false },
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    try {
      await expect(client.connect()).rejects.toThrow(error);
      expect(factory).not.toHaveBeenCalled();
    } finally {
      client.close();
    }
  },
);
