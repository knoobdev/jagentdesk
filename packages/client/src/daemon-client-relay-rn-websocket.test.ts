import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildRelayWebSocketUrl } from "@jagentdesk/protocol/daemon-endpoints";
import {
  exportPublicKey,
  generateKeyPair,
  openDaemonSecureChannel,
  type SecureChannel,
  type Transport as RelayTransport,
  type TransportMessage,
} from "@jagentdesk/relay/e2ee";
import { DaemonClient } from "./daemon-client.js";
import { connectionDiagnostics } from "./connection-diagnostics.js";
import type { WebSocketLike } from "./daemon-client-transport-types.js";

/**
 * The app's relay path end to end with React Native's WebSocket shapes
 * (react-native/Libraries/WebSocket/WebSocket.js): an EventTarget that
 * dispatches `MessageEvent`s whose `data` is a string for text frames and an
 * ArrayBuffer for binary frames, a 3-argument constructor, a strict
 * `binaryType` setter, and `send` that throws while connecting. Behind it sit
 * the real relay E2EE transport, ClientSecureChannel and DaemonClient, and on
 * the far side the daemon's own secure channel issuing the sign-in challenge.
 */

interface RelayScript {
  /** Holds client frames until released, like the Durable Object before the daemon's data socket is authenticated. */
  holdClientFramesMs?: number;
  /** Rewrites or drops daemon → client frames. */
  toClient?: (frame: TransportMessage, index: number) => TransportMessage | null;
  /** What the daemon sends once its channel opens. */
  challenge?: string | null;
}

interface FakeDaemon {
  hellos: Array<Record<string, unknown>>;
  rawHelloCount: number;
  channel: Promise<SecureChannel>;
}

class FakeReactNativeWebSocket extends EventTarget implements WebSocketLike {
  static script: RelayScript = {};
  static daemonKeyPair = generateKeyPair();
  static last: FakeDaemon | null = null;

  readyState = 0;
  bufferedAmount = 0;
  private binaryTypeValue: string | undefined;
  private toDaemon: ((message: TransportMessage) => void) | null = null;

  constructor(
    readonly url: string,
    _protocols?: string[],
    _options?: { headers?: Record<string, string> },
  ) {
    super();
    setTimeout(() => this.connect(), 1);
  }

  get binaryType(): string | undefined {
    return this.binaryTypeValue;
  }

  set binaryType(value: string | undefined) {
    if (value !== "blob" && value !== "arraybuffer") {
      throw new Error("binaryType must be either 'blob' or 'arraybuffer'");
    }
    this.binaryTypeValue = value;
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    if (this.readyState === 0) throw new Error("INVALID_STATE_ERR");
    const message: TransportMessage =
      typeof data === "string"
        ? { data, isBinary: false }
        : {
            data:
              data instanceof ArrayBuffer
                ? data.slice(0)
                : (data.buffer.slice(
                    data.byteOffset,
                    data.byteOffset + data.byteLength,
                  ) as ArrayBuffer),
            isBinary: true,
          };
    this.toDaemon?.(message);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    setTimeout(() => {
      this.readyState = 3;
      this.dispatchEvent(
        Object.assign(new Event("close"), { code: code ?? 1000, reason: reason ?? "" }),
      );
    }, 1);
  }

  private connect(): void {
    const script = FakeReactNativeWebSocket.script;
    const held: TransportMessage[] = [];
    let holding = (script.holdClientFramesMs ?? 0) > 0;
    let toClientIndex = 0;
    const daemonTransport: RelayTransport = {
      send: (data) => {
        const frame: TransportMessage = { data, isBinary: typeof data !== "string" };
        const delivered = script.toClient ? script.toClient(frame, toClientIndex++) : frame;
        if (!delivered) return;
        // Native → JS: each frame is its own event, text as string, binary as ArrayBuffer.
        setTimeout(() => {
          if (this.readyState !== 1) return;
          this.dispatchEvent(new MessageEvent("message", { data: delivered.data }));
        }, 0);
      },
      close: () => {},
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    const daemon: FakeDaemon = {
      hellos: [],
      rawHelloCount: 0,
      channel: openDaemonSecureChannel(daemonTransport, {
        daemonKeyPair: FakeReactNativeWebSocket.daemonKeyPair,
        minimumMode: "protected",
        events: {
          onmessage: (data) => {
            if (typeof data !== "string") return;
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (parsed.type === "hello") daemon.hellos.push(parsed);
          },
        },
      }),
    };
    void daemon.channel.then((channel) => {
      const challenge =
        script.challenge === undefined
          ? JSON.stringify({ type: "challenge", nonce: "nonce-from-daemon" })
          : script.challenge;
      if (challenge !== null) void channel.send(challenge);
      return undefined;
    });
    FakeReactNativeWebSocket.last = daemon;
    const deliver = (message: TransportMessage) =>
      setTimeout(() => daemonTransport.onmessage?.(message), 0);
    this.toDaemon = (message) => {
      if (typeof message.data === "string" && message.data.includes('"e2ee_hello"')) {
        daemon.rawHelloCount += 1;
      }
      if (holding) held.push(message);
      else deliver(message);
    };
    if (holding) {
      setTimeout(() => {
        holding = false;
        for (const message of held.splice(0)) daemonTransport.onmessage?.(message);
      }, script.holdClientFramesMs);
    }
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
}

function nativeStyleFactory(
  url: string,
  options?: { headers?: Record<string, string>; protocols?: string[] },
): WebSocketLike {
  return new FakeReactNativeWebSocket(url, options?.protocols, { headers: options?.headers });
}
nativeStyleFactory.supportsDrain = false;

const clients: DaemonClient[] = [];

function relayClient(overrides: { challengeWaitFallbackMs?: number } = {}) {
  const client = new DaemonClient({
    url: buildRelayWebSocketUrl({
      role: "client",
      endpoint: "relay.test:443",
      useTls: true,
      serverId: "srv_rn_test",
    }),
    clientId: "cid_rn_test",
    clientType: "mobile",
    webSocketFactory: nativeStyleFactory,
    e2ee: {
      enabled: true,
      daemonPublicKeyB64: exportPublicKey(FakeReactNativeWebSocket.daemonKeyPair.publicKey),
    },
    expectChallenge: true,
    challengeWaitFallbackMs: overrides.challengeWaitFallbackMs ?? 3_000,
    connectTimeoutMs: 5_000,
    reconnect: { enabled: false },
    deviceSigning: { devicePublicKeyB64: "cHVibGlj", signNonce: (nonce) => `signed:${nonce}` },
  });
  clients.push(client);
  return client;
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function diagnosticEvents(): string[] {
  return connectionDiagnostics.entries().map((entry) => entry.event);
}

beforeEach(() => {
  connectionDiagnostics.clear();
  FakeReactNativeWebSocket.script = {};
  FakeReactNativeWebSocket.last = null;
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => undefined)));
});

describe("relay connection over a React Native WebSocket", () => {
  test("answers the challenge after the relay delivers a hello and its retry together", async () => {
    // The user's daemon log: hellos at +1240 and +1251 ms, two readies, one record out.
    FakeReactNativeWebSocket.script = { holdClientFramesMs: 1_100 };
    const client = relayClient();
    void client.connect().catch(() => undefined);
    await settle(1_400);

    const daemon = FakeReactNativeWebSocket.last!;
    expect(daemon.rawHelloCount).toBe(2);
    expect(daemon.hellos).toEqual([
      expect.objectContaining({
        nonce: "nonce-from-daemon",
        signature: "signed:nonce-from-daemon",
      }),
    ]);
    expect(client.connectStage).toBe("hello_sent");
    const events = diagnosticEvents();
    expect(events).toEqual(
      expect.arrayContaining([
        "connect_attempt",
        "ws_open",
        "e2ee_hello_sent",
        "e2ee_open",
        "e2ee_duplicate_ready",
        "transport_open",
        "challenge_received",
        "signing",
        "hello_sent",
      ]),
    );
    expect(events.indexOf("e2ee_open")).toBeLessThan(events.indexOf("challenge_received"));
    const firstFrame = connectionDiagnostics
      .entries()
      .find((entry) => entry.event === "ws_frame_before_open");
    expect(firstFrame?.fields).toEqual({
      kind: "text",
      shape: "string",
      bytes: expect.any(Number),
    });
  });

  test("a lost ready fails the handshake at once and names it, instead of a challenge timeout", async () => {
    FakeReactNativeWebSocket.script = {
      toClient: (frame, index) => (index === 0 ? null : frame),
    };
    const client = relayClient();
    const connecting = client.connect();
    await expect(connecting).rejects.toThrow(/before e2ee_ready/);
    expect(client.lastError).toMatch(/non-JSON data before e2ee_ready/);
    expect(FakeReactNativeWebSocket.last!.hellos).toEqual([]);
    expect(diagnosticEvents()).toContain("e2ee_handshake_failed");
    expect(diagnosticEvents()).not.toContain("challenge_timeout");
  });

  test("a ready delivered as a binary frame fails the handshake with that reason", async () => {
    FakeReactNativeWebSocket.script = {
      toClient: (frame) =>
        typeof frame.data === "string" && frame.data.includes('"e2ee_ready"')
          ? { data: new TextEncoder().encode(frame.data).buffer as ArrayBuffer, isBinary: true }
          : frame,
    };
    const client = relayClient();
    await expect(client.connect()).rejects.toThrow(/binary frame/);
    const before = connectionDiagnostics
      .entries()
      .find((entry) => entry.event === "ws_frame_before_open");
    expect(before?.fields).toMatchObject({ kind: "binary", shape: "ArrayBuffer" });
  });

  test("a challenge that fails validation is named in the timeout", async () => {
    FakeReactNativeWebSocket.script = {
      challenge: JSON.stringify({ type: "challenge", nonce: "" }),
    };
    const client = relayClient({ challengeWaitFallbackMs: 300 });
    await expect(client.connect()).rejects.toThrow(
      /Relay challenge timed out; refusing unsigned hello\. A "challenge" message from the host failed validation/,
    );
    expect(diagnosticEvents()).toEqual(
      expect.arrayContaining(["message", "message_dropped", "challenge_timeout"]),
    );
  });

  test("a challenge that never comes is named in the timeout", async () => {
    FakeReactNativeWebSocket.script = { challenge: null };
    const client = relayClient({ challengeWaitFallbackMs: 300 });
    await expect(client.connect()).rejects.toThrow(
      "Relay challenge timed out; refusing unsigned hello. No message from the host arrived after the connection opened.",
    );
  });

  test("diagnostics never carry the nonce, the signature or message bodies", async () => {
    FakeReactNativeWebSocket.script = { holdClientFramesMs: 50 };
    const client = relayClient();
    void client.connect().catch(() => undefined);
    await settle(300);
    expect(FakeReactNativeWebSocket.last!.hellos).toHaveLength(1);
    const text = connectionDiagnostics.format();
    expect(text).not.toContain("nonce-from-daemon");
    expect(text).not.toContain("signed:");
    expect(text).not.toContain("cHVibGlj");
    expect(text).not.toContain("cid_rn_test");
  });
});
