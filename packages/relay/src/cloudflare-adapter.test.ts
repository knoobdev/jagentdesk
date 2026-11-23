import { afterEach, describe, expect, it, vi } from "vitest";
import nacl from "tweetnacl";
import relayWorker, { RelayDurableObject } from "./cloudflare-adapter.js";
import {
  MAX_RELAY_WEBSOCKET_MESSAGE_BYTES,
  MAX_RELAY_CLIENTS_PER_SERVER,
  MAX_RELAY_CONNECTS_PER_IP_PER_MINUTE,
  MAX_RELAY_BUFFERED_FRAMES_PER_CONNECTION,
  RELAY_CLOSE_FRAME_TOO_LARGE,
  RELAY_CLOSE_CHALLENGE_TIMEOUT,
  RELAY_CLOSE_OWNERSHIP_MISMATCH,
  RELAY_CLOSE_TOO_MANY_CLIENTS,
  RELAY_CLOSE_BUFFER_OVERFLOW,
} from "./limits.js";
import { bytesToBase64Url, encodeRelayAuth, relayChallengeMessage } from "./ownership.js";

type DurableObjectStateArg = ConstructorParameters<typeof RelayDurableObject>[0];
type RelayEnvArg = Parameters<typeof relayWorker.fetch>[1];

type MockSocket = WebSocket & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  serializeAttachment: ReturnType<typeof vi.fn>;
  deserializeAttachment: ReturnType<typeof vi.fn>;
};

function createMockSocket(attachment: unknown = null): MockSocket {
  let storedAttachment = attachment;
  return {
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn((value: unknown) => {
      storedAttachment = value;
    }),
    deserializeAttachment: vi.fn(() => storedAttachment),
  } as unknown as MockSocket;
}

function createMockState() {
  const socketsByTag = new Map<string, WebSocket[]>();
  const storage = new Map<string, unknown>();
  const state = {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key) ?? null),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value);
      }),
      setAlarm: vi.fn(async () => undefined),
      deleteAlarm: vi.fn(async () => undefined),
    },
    acceptWebSocket: vi.fn((ws: WebSocket, tags: string[] = []) => {
      for (const tag of tags) {
        const list = socketsByTag.get(tag) ?? [];
        list.push(ws);
        socketsByTag.set(tag, list);
      }
    }),
    getWebSockets: vi.fn((tag?: string): WebSocket[] => {
      if (!tag) {
        const seen = new Set<WebSocket>();
        for (const sockets of socketsByTag.values()) {
          for (const socket of sockets) seen.add(socket);
        }
        return Array.from(seen);
      }
      return socketsByTag.get(tag) ?? [];
    }),
  };

  return {
    state,
    storage,
    setTagSockets: (tag: string, sockets: WebSocket[]) => {
      socketsByTag.set(tag, sockets);
    },
  };
}

async function withMockWebSocketPair(
  run: (sockets: { clientWs: MockSocket; serverWs: MockSocket }) => Promise<void> | void,
): Promise<void> {
  const serverWs = createMockSocket();
  const clientWs = createMockSocket();
  const WebSocketPairMock = class {
    [index: number]: WebSocket;
    constructor() {
      this[0] = clientWs as unknown as WebSocket;
      this[1] = serverWs as unknown as WebSocket;
    }
  };

  const previousPair = (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair;
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = WebSocketPairMock;
  try {
    await run({ clientWs, serverWs });
  } finally {
    if (previousPair === undefined) {
      delete (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair;
    } else {
      (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = previousPair;
    }
  }
}

/** Frames captured on a mock socket's send spy, without extra callback nesting. */
function sentFrames(ws: MockSocket): string[] {
  const out: string[] = [];
  for (const call of ws.send.mock.calls) out.push(String(call[0]));
  return out;
}

const swallow = () => undefined;

// tweetnacl is CommonJS loaded in the host realm; vitest sandbox globals like
// TextEncoder return a cross-realm Uint8Array that fails tweetnacl's
// `instanceof` check. Re-wrap bytes through the constructor tweetnacl itself uses.
function signBytes(text: string): Uint8Array {
  const HostUint8Array = Object.getPrototypeOf(nacl.sign.keyPair().publicKey)
    .constructor as unknown as Uint8ArrayConstructor;
  return new HostUint8Array(new TextEncoder().encode(text));
}

/** Daemon-side answer to a `relay_challenge` frame captured on a mock socket. */
function signChallengeAsDaemon(
  serverWs: MockSocket,
  serverId: string,
  daemonKeys: nacl.SigningKeyPair,
): string {
  const challengeRaw = sentFrames(serverWs).find((text) => text.includes('"relay_challenge"'));
  if (!challengeRaw) throw new Error("no relay_challenge frame was sent");
  const challenge = JSON.parse(challengeRaw) as { nonce: string };
  const signature = nacl.sign.detached(
    signBytes(relayChallengeMessage(serverId, challenge.nonce)),
    daemonKeys.secretKey,
  );
  return JSON.stringify(encodeRelayAuth(daemonKeys.publicKey, signature));
}

async function authenticateServerSocket(
  relay: RelayDurableObject,
  serverWs: MockSocket,
  serverId: string,
  daemonKeys: nacl.SigningKeyPair,
): Promise<void> {
  await relay.webSocketMessage(serverWs, signChallengeAsDaemon(serverWs, serverId, daemonKeys));
}

describe("RelayDurableObject versioning", () => {
  it("rejects v1 sockets with 400", async () => {
    const { state } = createMockState();
    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    const req = new Request("https://relay.test/ws?role=client&serverId=srv_test&v=1", {
      headers: { Upgrade: "websocket" },
    });
    const response = await relay.fetch(req);
    expect(response.status).toBe(400);
    expect(state.acceptWebSocket).not.toHaveBeenCalled();
  });

  it("rejects sockets without v with 400", async () => {
    const { state } = createMockState();
    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    const req = new Request("https://relay.test/ws?role=client&serverId=srv_test", {
      headers: { Upgrade: "websocket" },
    });
    const response = await relay.fetch(req);
    expect(response.status).toBe(400);
    expect(state.acceptWebSocket).not.toHaveBeenCalled();
  });

  it("assigns a connectionId when v2 client connects without one", async () => {
    const { state } = createMockState();
    await withMockWebSocketPair(async ({ serverWs }) => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request("https://relay.test/ws?role=client&serverId=srv_test&v=2", {
        headers: { Upgrade: "websocket" },
      });
      await relay.fetch(req).catch(swallow);
      expect(state.acceptWebSocket).toHaveBeenCalled();
      const attachment = serverWs.deserializeAttachment();
      expect(attachment).toMatchObject({
        role: "client",
        connectionId: expect.stringMatching(/^conn_/),
        authState: "ok",
      });
    });
  });
});

describe("RelayDurableObject ownership challenge", () => {
  it("sends relay_challenge as the first frame on server sockets", async () => {
    const { state } = createMockState();
    await withMockWebSocketPair(async ({ serverWs }) => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request("https://relay.test/ws?role=server&serverId=srv_test&v=2", {
        headers: { Upgrade: "websocket" },
      });
      await relay.fetch(req).catch(swallow);
      const firstFrame = JSON.parse(String(serverWs.send.mock.calls[0][0]));
      expect(firstFrame).toMatchObject({ type: "relay_challenge", v: 1 });
      expect(firstFrame.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  it("accepts a valid signature, pins the first key, replies relay_auth_ok", async () => {
    const { state, storage } = createMockState();
    const daemonKeys = nacl.sign.keyPair();
    await withMockWebSocketPair(async ({ serverWs }) => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request("https://relay.test/ws?role=server&serverId=srv_test&v=2", {
        headers: { Upgrade: "websocket" },
      });
      await relay.fetch(req).catch(swallow);

      await authenticateServerSocket(relay, serverWs, "srv_test", daemonKeys);

      expect(sentFrames(serverWs)).toContain(JSON.stringify({ type: "relay_auth_ok" }));
      expect(serverWs.close).not.toHaveBeenCalled();
      expect(storage.get("relay:serverPublicKey")).toBe(base64Url(daemonKeys.publicKey));
    });
  });

  it("closes with 4403 when the pinned key differs", async () => {
    const { state, storage } = createMockState();
    const ownerKeys = nacl.sign.keyPair();
    const attackerKeys = nacl.sign.keyPair();
    storage.set("relay:serverPublicKey", base64Url(ownerKeys.publicKey));

    await withMockWebSocketPair(async ({ serverWs }) => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request("https://relay.test/ws?role=server&serverId=srv_test&v=2", {
        headers: { Upgrade: "websocket" },
      });
      await relay.fetch(req).catch(swallow);

      // Attacker signs its own honest challenge with the wrong key: signature
      // verifies but the pinned key check must reject it.
      await authenticateServerSocket(relay, serverWs, "srv_test", attackerKeys);

      expect(serverWs.close).toHaveBeenCalledWith(
        RELAY_CLOSE_OWNERSHIP_MISMATCH,
        expect.any(String),
      );
    });
  });

  it("closes with 4403 on an invalid signature", async () => {
    const { state } = createMockState();
    const daemonKeys = nacl.sign.keyPair();
    await withMockWebSocketPair(async ({ serverWs }) => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request("https://relay.test/ws?role=server&serverId=srv_test&v=2", {
        headers: { Upgrade: "websocket" },
      });
      await relay.fetch(req).catch(swallow);

      const badAuth = signChallengeAsDaemon(serverWs, "srv_test", daemonKeys);
      const tampered = JSON.parse(badAuth) as { signature: string };
      tampered.signature = base64Url(nacl.sign.keyPair().publicKey);
      await relay.webSocketMessage(serverWs, JSON.stringify(tampered));

      expect(serverWs.close).toHaveBeenCalledWith(
        RELAY_CLOSE_OWNERSHIP_MISMATCH,
        expect.any(String),
      );
    });
  });

  it("drops server frames and skips notifications before relay_auth_ok", async () => {
    const { state, setTagSockets } = createMockState();
    await withMockWebSocketPair(async ({ serverWs }) => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request("https://relay.test/ws?role=server&serverId=srv_test&v=2", {
        headers: { Upgrade: "websocket" },
      });
      await relay.fetch(req).catch(swallow);

      const otherControl = createMockSocket({
        role: "server",
        version: "2",
        serverId: "srv_test",
        createdAt: Date.now(),
        authState: "pending",
      });
      setTagSockets("server-control", [serverWs, otherControl]);

      await relay.webSocketMessage(serverWs, JSON.stringify({ type: "ping" }));
      await relay.webSocketMessage(otherControl, Buffer.from("binary").buffer as ArrayBuffer);

      // No pong, no forwarding of unauthenticated server traffic.
      for (const frame of sentFrames(serverWs)) {
        expect(frame).not.toContain('"pong"');
      }
      expect(otherControl.send).not.toHaveBeenCalled();
    });
  });

  it("closes with 4401 when the challenge is not answered in 10 s", async () => {
    vi.useFakeTimers();
    try {
      const { state } = createMockState();
      await withMockWebSocketPair(async ({ serverWs }) => {
        const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
        const req = new Request("https://relay.test/ws?role=server&serverId=srv_test&v=2", {
          headers: { Upgrade: "websocket" },
        });
        await relay.fetch(req).catch(swallow);

        vi.advanceTimersByTime(10_001);
        await relay.scheduled();

        expect(serverWs.close).toHaveBeenCalledWith(
          RELAY_CLOSE_CHALLENGE_TIMEOUT,
          expect.any(String),
        );
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RelayDurableObject limits", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes a socket sending a frame over 32 MiB with 4009", async () => {
    const { state } = createMockState();
    const big = new ArrayBuffer(MAX_RELAY_WEBSOCKET_MESSAGE_BYTES + 1);
    const client = createMockSocket({
      role: "client",
      version: "2",
      connectionId: "c_big",
      serverId: "srv_test",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      authState: "ok",
    });

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    await relay.webSocketMessage(client, big);

    expect(client.close).toHaveBeenCalledWith(RELAY_CLOSE_FRAME_TOO_LARGE, expect.any(String));
  });

  it("rejects the 17th concurrent client of a serverId with 4429", async () => {
    const { state, setTagSockets } = createMockState();
    setTagSockets(
      "client",
      Array.from({ length: MAX_RELAY_CLIENTS_PER_SERVER }, () => createMockSocket()),
    );

    await withMockWebSocketPair(async ({ serverWs }) => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request(
        "https://relay.test/ws?role=client&serverId=srv_test&connectionId=c_17&v=2",
        { headers: { Upgrade: "websocket" } },
      );
      await relay.fetch(req).catch(swallow);
      expect(serverWs.close).toHaveBeenCalledWith(RELAY_CLOSE_TOO_MANY_CLIENTS, expect.any(String));
    });
  });

  it("closes clients with 4413 when buffered frames exceed 256", async () => {
    const { state, setTagSockets } = createMockState();
    const clientId = "c_overflow";
    const client = createMockSocket({
      role: "client",
      version: "2",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      authState: "ok",
    });
    setTagSockets(`client:${clientId}`, [client]);
    setTagSockets("client", [client]);
    setTagSockets(`server:${clientId}`, []);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    for (let i = 0; i < MAX_RELAY_BUFFERED_FRAMES_PER_CONNECTION + 1; i += 1) {
      await relay.webSocketMessage(client, `frame-${i}`);
    }

    expect(client.close).toHaveBeenCalledWith(RELAY_CLOSE_BUFFER_OVERFLOW, expect.any(String));
  });

  it("rate-limits connects per CF-Connecting-IP with HTTP 429", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));
    const env = { RELAY: { idFromName, get } } as unknown as RelayEnvArg;

    let lastStatus = 0;
    for (let i = 0; i < MAX_RELAY_CONNECTS_PER_IP_PER_MINUTE + 1; i += 1) {
      const response = await relayWorker.fetch(
        new Request("https://relay.test/ws?serverId=srv_rate&role=server&v=2", {
          headers: { "CF-Connecting-IP": "203.0.113.77" },
        }),
        env,
      );
      lastStatus = response.status;
    }

    expect(lastStatus).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(MAX_RELAY_CONNECTS_PER_IP_PER_MINUTE);
  });

  it("closes idle sockets after 10 minutes", async () => {
    vi.useFakeTimers();
    try {
      const { state } = createMockState();
      const clientId = "c_idle";
      const client = createMockSocket({
        role: "client",
        version: "2",
        connectionId: clientId,
        serverId: "srv_test",
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        authState: "ok",
      });
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      // Register through acceptWebSocket so the state fake can list it.
      state.acceptWebSocket(client as unknown as WebSocket, ["client", `client:${clientId}`]);

      vi.advanceTimersByTime(10 * 60_000 + 1);
      await relay.scheduled();

      expect(client.close).toHaveBeenCalledWith(1000, "Idle timeout");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RelayDurableObject forwarding", () => {
  it("buffers client frames until the daemon data socket passes auth, then forwards both ways", async () => {
    const { state } = createMockState();
    const daemonKeys = nacl.sign.keyPair();
    const serverId = "srv_flow";
    const clientId = "clt_flow";

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    const upgradeHeaders = { headers: { Upgrade: "websocket" } };

    // 1. Daemon control socket + auth.
    let controlSocket: MockSocket | null = null;
    await withMockWebSocketPair(async ({ serverWs }) => {
      controlSocket = serverWs;
      await relay
        .fetch(
          new Request(`https://relay.test/ws?role=server&serverId=${serverId}&v=2`, upgradeHeaders),
        )
        .catch(swallow);
      await authenticateServerSocket(relay, serverWs, serverId, daemonKeys);
    });
    const control = controlSocket as unknown as MockSocket;

    // 2. Client socket.
    let clientSocket: MockSocket | null = null;
    await withMockWebSocketPair(async ({ serverWs }) => {
      clientSocket = serverWs;
      await relay
        .fetch(
          new Request(
            `https://relay.test/ws?role=client&serverId=${serverId}&connectionId=${clientId}&v=2`,
            upgradeHeaders,
          ),
        )
        .catch(swallow);
    });
    const client = clientSocket as unknown as MockSocket;
    expect(control.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "connected", connectionId: clientId }),
    );

    // 3. Daemon data socket + client frame while still unauthenticated.
    let dataSocket: MockSocket | null = null;
    await withMockWebSocketPair(async ({ serverWs }) => {
      dataSocket = serverWs;
      await relay
        .fetch(
          new Request(
            `https://relay.test/ws?role=server&serverId=${serverId}&connectionId=${clientId}&v=2`,
            upgradeHeaders,
          ),
        )
        .catch(swallow);

      await relay.webSocketMessage(client, "hello-while-pending");
      expect(serverWs.send).not.toHaveBeenCalledWith("hello-while-pending");

      await authenticateServerSocket(relay, serverWs, serverId, daemonKeys);

      // Buffered frame flushed post-auth.
      expect(serverWs.send).toHaveBeenCalledWith("hello-while-pending");

      // 4. Server -> client forwarding.
      await relay.webSocketMessage(serverWs, "reply-from-daemon");
      expect(client.send).toHaveBeenCalledWith("reply-from-daemon");
    });
    void dataSocket;
  });
});

describe("RelayDurableObject control nudge/reset behavior", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function authenticatedControl(): MockSocket {
    return createMockSocket({
      role: "server",
      version: "2",
      serverId: "srv_test",
      createdAt: Date.now(),
      authState: "ok",
    });
  }

  it("does not nudge or reset control after the client already disconnected", () => {
    vi.useFakeTimers();
    const clientId = "clt_stale_timer";
    const control = authenticatedControl();
    const { state, setTagSockets } = createMockState();

    setTagSockets("server-control", [control]);
    setTagSockets("client", []);
    setTagSockets(`client:${clientId}`, []);
    setTagSockets(`server:${clientId}`, []);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    (
      relay as unknown as { nudgeOrResetControlForConnection(id: string): void }
    ).nudgeOrResetControlForConnection(clientId);

    vi.advanceTimersByTime(15_000);

    expect(control.send).not.toHaveBeenCalled();
    expect(control.close).not.toHaveBeenCalled();
  });

  it("resets control when the client remains connected but no server-data socket appears", () => {
    vi.useFakeTimers();
    const clientId = "clt_waiting_for_daemon";
    const control = authenticatedControl();
    const client = createMockSocket({
      role: "client",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const { state, setTagSockets } = createMockState();

    setTagSockets("server-control", [control]);
    setTagSockets("client", [client]);
    setTagSockets(`client:${clientId}`, [client]);
    setTagSockets(`server:${clientId}`, []);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    (
      relay as unknown as { nudgeOrResetControlForConnection(id: string): void }
    ).nudgeOrResetControlForConnection(clientId);

    vi.advanceTimersByTime(10_000);
    expect(control.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    expect(control.close).toHaveBeenCalledWith(1011, "Control unresponsive");
  });

  it("does not replace existing client sockets for the same connectionId", async () => {
    const existingClient = createMockSocket({
      version: "2",
      role: "client",
      connectionId: "clt_same_session",
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const { state, setTagSockets } = createMockState();
    setTagSockets("client:clt_same_session", [existingClient]);
    setTagSockets("client", [existingClient]);

    await withMockWebSocketPair(async () => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request(
        "https://relay.test/ws?role=client&serverId=srv_test&connectionId=clt_same_session&v=2",
        {
          headers: {
            Upgrade: "websocket",
          },
        },
      );

      await relay.fetch(req).catch(swallow);
      expect(existingClient.close).not.toHaveBeenCalled();
    });
  });

  it("keeps server data socket alive while at least one client socket remains", () => {
    const clientId = "clt_multi";
    const disconnectedClient = createMockSocket({
      version: "2",
      role: "client",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const stillConnectedClient = createMockSocket({
      version: "2",
      role: "client",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const serverData = createMockSocket();
    const control = authenticatedControl();
    const { state, setTagSockets } = createMockState();

    setTagSockets("server-control", [control]);
    setTagSockets(`server:${clientId}`, [serverData]);
    setTagSockets("client", [stillConnectedClient]);
    setTagSockets(`client:${clientId}`, [stillConnectedClient]);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    relay.webSocketClose(
      disconnectedClient as unknown as WebSocket,
      1001,
      "Client disconnected",
      true,
    );

    expect(serverData.close).not.toHaveBeenCalled();
    expect(control.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: "disconnected", connectionId: clientId }),
    );
  });
});

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64Url(bytes);
}

describe("relay worker endpoint routing", () => {
  it("rejects missing v with 400 (v1 dropped)", async () => {
    const fetch = vi.fn();
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));

    const response = await relayWorker.fetch(
      new Request("https://relay.test/ws?serverId=srv_test&role=server"),
      { RELAY: { idFromName, get } } as unknown as RelayEnvArg,
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid v parameter (expected 2)");
    expect(idFromName).not.toHaveBeenCalled();
  });

  it("rejects v=1 with 400", async () => {
    const fetch = vi.fn();
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));

    const response = await relayWorker.fetch(
      new Request("https://relay.test/ws?serverId=srv_test&role=server&v=1"),
      { RELAY: { idFromName, get } } as unknown as RelayEnvArg,
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid v parameter (expected 2)");
    expect(idFromName).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("routes v=2 to the serverId-scoped DO", async () => {
    const fetch = vi.fn(
      async (request: Request) => new Response(`ok:${new URL(request.url).searchParams.get("v")}`),
    );
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));

    const response = await relayWorker.fetch(
      new Request("https://relay.test/ws?serverId=srv_test&role=server&v=2"),
      { RELAY: { idFromName, get } } as unknown as RelayEnvArg,
    );

    expect(idFromName).toHaveBeenCalledWith("srv_test");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe("ok:2");
  });

  it("rejects parameterless requests with a missing-role 400", async () => {
    const fetch = vi.fn();
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));

    const response = await relayWorker.fetch(new Request("https://relay.test/"), {
      RELAY: { idFromName, get },
    } as unknown as RelayEnvArg);

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Missing or invalid role parameter");
  });

  it("rejects invalid v values", async () => {
    const fetch = vi.fn();
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));

    const response = await relayWorker.fetch(
      new Request("https://relay.test/ws?serverId=srv_test&role=server&v=nope"),
      { RELAY: { idFromName, get } } as unknown as RelayEnvArg,
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid v parameter (expected 2)");
    expect(idFromName).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
