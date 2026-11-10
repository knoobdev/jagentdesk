import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDaemonWebSocketUrl } from "@/utils/daemon-endpoints";
import { clientUsesAddress, reviveTailnetHosts } from "./foreground-revive";

const { reviveMock } = vi.hoisted(() => ({
  reviveMock: vi.fn<(target: string) => Promise<string | null>>(),
}));

vi.mock("./adapter", () => ({
  getTailscaleLoginAdapter: () => ({ revive: reviveMock }),
}));

interface FakeStoreInput {
  serverId: string;
  activeConnectionId: string | null;
  connection: { id: string; type: string; tailnetAddress?: string; useTls?: boolean };
}

function makeStore(input: FakeStoreInput) {
  const rebuildCalls: Array<[string, string]> = [];
  return {
    rebuildCalls,
    getHosts: () => [
      {
        serverId: input.serverId,
        connections: [input.connection],
      },
    ],
    getSnapshot: (serverId: string) =>
      serverId === input.serverId ? { activeConnectionId: input.activeConnectionId } : null,
    getClient: (serverId: string) =>
      serverId === input.serverId
        ? {
            url: buildDaemonWebSocketUrl("127.0.0.1:4242", {
              useTls: input.connection.useTls ?? false,
            }),
          }
        : null,
    rebuildTailnetClient: async (serverId: string, connectionId: string) => {
      rebuildCalls.push([serverId, connectionId]);
    },
  };
}

const CONNECTION = {
  id: "tailnet:100.64.0.1:6768",
  type: "tailnet",
  tailnetAddress: "100.64.0.1:6768",
};

beforeEach(() => {
  reviveMock.mockReset();
});

describe("reviveTailnetHosts", () => {
  it("keeps the client when the revived loopback address is unchanged", async () => {
    reviveMock.mockResolvedValue("127.0.0.1:4242");
    const store = makeStore({
      serverId: "s1",
      activeConnectionId: CONNECTION.id,
      connection: CONNECTION,
    });
    await reviveTailnetHosts(store);
    expect(store.rebuildCalls).toEqual([]);
  });

  it("rebuilds the client when the revived loopback address differs", async () => {
    reviveMock.mockResolvedValue("127.0.0.1:5319");
    const store = makeStore({
      serverId: "s1",
      activeConnectionId: CONNECTION.id,
      connection: CONNECTION,
    });
    await reviveTailnetHosts(store);
    expect(store.rebuildCalls).toEqual([["s1", CONNECTION.id]]);
  });

  it("still rebuilds when the daemon is offline, because revive resolves anyway", async () => {
    // The native Revive returns the loopback address with nil error even
    // when the daemon stays unreachable after the node restart; the normal
    // reconnect loop handles the offline daemon (spec 05.7.4).
    reviveMock.mockResolvedValue("127.0.0.1:5319");
    const store = makeStore({
      serverId: "s1",
      activeConnectionId: CONNECTION.id,
      connection: CONNECTION,
    });
    await expect(reviveTailnetHosts(store)).resolves.toBeUndefined();
    expect(store.rebuildCalls).toEqual([["s1", CONNECTION.id]]);
  });

  it("leaves recovery to the retry loop when revive throws", async () => {
    reviveMock.mockRejectedValue(new Error("tsnet node restart failed"));
    const store = makeStore({
      serverId: "s1",
      activeConnectionId: CONNECTION.id,
      connection: CONNECTION,
    });
    await expect(reviveTailnetHosts(store)).resolves.toBeUndefined();
    expect(store.rebuildCalls).toEqual([]);
  });

  it("does not rebuild when revive reports no address", async () => {
    reviveMock.mockResolvedValue(null);
    const store = makeStore({
      serverId: "s1",
      activeConnectionId: CONNECTION.id,
      connection: CONNECTION,
    });
    await reviveTailnetHosts(store);
    expect(store.rebuildCalls).toEqual([]);
  });

  it("skips hosts whose active connection is not the tailnet one", async () => {
    const store = makeStore({
      serverId: "s1",
      activeConnectionId: "direct:127.0.0.1:6767",
      connection: CONNECTION,
    });
    await reviveTailnetHosts(store);
    expect(reviveMock).not.toHaveBeenCalled();
    expect(store.rebuildCalls).toEqual([]);
  });
});

describe("clientUsesAddress", () => {
  it("matches the URL the client would be built with for the address", () => {
    const url = buildDaemonWebSocketUrl("127.0.0.1:4242", { useTls: false });
    expect(clientUsesAddress(url, "127.0.0.1:4242", false)).toBe(true);
    expect(clientUsesAddress(url, "127.0.0.1:5319", false)).toBe(false);
  });
});
