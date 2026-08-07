import { beforeEach, describe, expect, test, vi } from "vitest";

const { mockDaemonClientInstances } = vi.hoisted(() => ({
  mockDaemonClientInstances: [] as Array<{ url: string }>,
}));

// Stub the CLI client-id store so the tailnet offer path never touches the
// real home directory during tests.
vi.mock("./client-id.js", () => ({
  getOrCreateCliClientId: async () => "cid_tailnet_test",
}));

// Replace the daemon client with a recorder so we can assert the exact
// WebSocket URL the tailnet offer path dials without opening a socket.
vi.mock("@jagentdesk/client/internal/daemon-client", () => {
  class MockDaemonClient {
    constructor(config: { url: string }) {
      mockDaemonClientInstances.push({ url: config.url });
    }

    async connect(): Promise<void> {}

    async close(): Promise<void> {}

    get lastError(): string | null {
      return null;
    }
  }
  return { DaemonClient: MockDaemonClient };
});

import { connectToDaemon } from "./client.js";
import { selectTailnetStatus } from "../commands/daemon/status.js";

function encodeOfferFragment(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildOfferUrl(payload: unknown): string {
  return `https://example.test/#offer=${encodeOfferFragment(payload)}`;
}

function buildV3TailnetOfferUrl(options: { useTls?: boolean } = {}): string {
  return buildOfferUrl({
    v: 3,
    serverId: "server-test",
    daemonPublicKeyB64: "dGVzdA",
    tailnetAddress: "tailnet.test:6767",
    ...(options.useTls !== undefined ? { useTls: options.useTls } : {}),
  });
}

describe("connectToDaemon tailnet offer handling", () => {
  beforeEach(() => {
    mockDaemonClientInstances.length = 0;
  });

  test("a v3 tailnet offer dials ws://<tailnetAddress>/ws", async () => {
    const client = await connectToDaemon({ host: buildV3TailnetOfferUrl() });
    expect(client).toBeDefined();
    expect(mockDaemonClientInstances).toHaveLength(1);
    expect(mockDaemonClientInstances[0]?.url).toBe("ws://tailnet.test:6767/ws");
  });

  test("a v3 tailnet offer with useTls dials wss://<tailnetAddress>/ws", async () => {
    await connectToDaemon({ host: buildV3TailnetOfferUrl({ useTls: true }) });
    expect(mockDaemonClientInstances).toHaveLength(1);
    expect(mockDaemonClientInstances[0]?.url).toBe("wss://tailnet.test:6767/ws");
  });

  test("an offer without the current Tailscale shape is rejected without attempting a connection", async () => {
    await expect(
      connectToDaemon({
        host: buildOfferUrl({
          v: 2,
          serverId: "server-test",
          daemonPublicKeyB64: "dGVzdA",
          tailnetAddress: undefined,
        }),
      }),
    ).rejects.toThrow("Invalid pairing offer URL");
    expect(mockDaemonClientInstances).toHaveLength(0);
  });
});

describe("selectTailnetStatus tailnet host row", () => {
  test("trims whitespace from the tailnet host before appending the listen port", () => {
    expect(selectTailnetStatus({ host: "  tailnet.test  ", listen: "0.0.0.0:6767" })).toBe(
      "tailnet.test:6767",
    );
  });

  test("extracts the port from an IPv6 listen target", () => {
    expect(selectTailnetStatus({ host: "tailnet.test", listen: "[::]:6767" })).toBe(
      "tailnet.test:6767",
    );
  });
});
