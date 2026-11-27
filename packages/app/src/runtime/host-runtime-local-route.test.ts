import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState, DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import { defaultHostAppearance } from "@/hosts/appearance";
import {
  buildConnectionCandidates,
  HostRuntimeController,
  type HostRuntimeControllerDeps,
} from "./host-runtime";
import {
  rememberDesktopSignedLocalHost,
  resetDesktopSignedLocalHostsForTests,
} from "./desktop-signed-local-hosts";

// The built-in plugin surfaces pull in expo-router's CommonJS navigation build, which the unit
// runner cannot load; routing never touches them.
vi.mock("@/plugins/builtin/surfaces", () => ({ prepareBuiltinTurn: vi.fn() }));

// The desktop's bundled daemon is reached on this machine, never through the relay (ADR-0056 §2).

class FakeClient {
  private state: ConnectionState = { status: "connected" };
  private listeners = new Set<(status: ConnectionState) => void>();
  constructor(private readonly rttMs: () => number) {}
  async connect(): Promise<void> {
    this.setState({ status: "connected" });
  }
  async close(): Promise<void> {
    this.setState({ status: "disconnected", reason: "client_closed" });
  }
  ensureConnected(): void {}
  getConnectionState(): ConnectionState {
    return this.state;
  }
  getLastServerInfoMessage(): null {
    return null;
  }
  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }
  get lastError(): string | null {
    return null;
  }
  async measureLatency(): Promise<number> {
    return this.rttMs();
  }
  setReconnectEnabled(): void {}
  getLastLivenessRttMs(): number | null {
    return null;
  }
  on(): () => void {
    return () => undefined;
  }
  isDisposed(): boolean {
    return this.state.status === "disconnected" && this.state.reason === "client_closed";
  }
  private setState(next: ConnectionState): void {
    this.state = next;
    for (const listener of this.listeners) listener(next);
  }
}

const direct: HostConnection = {
  id: "direct:localhost:6768",
  type: "directTcp",
  endpoint: "localhost:6768",
};
const relay: HostConnection = {
  id: "relay:test",
  type: "relay",
  endpoint: "relay.test:443",
  useTls: true,
  daemonPublicKeyB64: "public-key",
};
const tailnet: HostConnection = {
  id: "tailnet:test",
  type: "tailnet",
  tailnetAddress: "host.tailnet.test:6768",
  daemonPublicKeyB64: "public-key",
};

function makeHost(input: Partial<HostProfile>): HostProfile {
  return {
    serverId: "srv_bundled",
    label: "This Mac",
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [direct, relay],
    preferredConnectionId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...input,
  };
}

function makeDeps(
  latency: Record<string, number | Error>,
  clients: FakeClient[],
): HostRuntimeControllerDeps {
  const read = (connectionId: string): number => {
    const value = latency[connectionId];
    if (value instanceof Error) throw value;
    if (typeof value !== "number") throw new Error(`missing latency for ${connectionId}`);
    return value;
  };
  return {
    createClient: ({ connection }) => {
      const client = new FakeClient(() => read(connection.id));
      clients.push(client);
      return client as unknown as DaemonClient;
    },
    connectToDaemon: async ({ host, connection }) => {
      read(connection.id);
      const client = new FakeClient(() => read(connection.id));
      clients.push(client);
      return { client: client as unknown as DaemonClient, serverId: host.serverId, hostname: null };
    },
    getClientId: async () => "cid_test_local_route",
  };
}

async function markDesktopBundledHost(serverId: string): Promise<void> {
  const memory = new Map<string, string>();
  await rememberDesktopSignedLocalHost(serverId, {
    getItem: async (key) => memory.get(key) ?? null,
    setItem: async (key, value) => {
      memory.set(key, value);
    },
  });
}

afterEach(() => {
  resetDesktopSignedLocalHostsForTests();
  vi.useRealTimers();
});

describe("local route for the desktop's bundled daemon", () => {
  it("ranks this machine's routes first, whatever route was preferred", () => {
    const host = makeHost({
      connections: [relay, tailnet, direct],
      preferredConnectionId: relay.id,
      lastConnectionId: relay.id,
    });
    expect(
      buildConnectionCandidates(host, "off", { preferLocal: true }).map(
        (candidate) => candidate.connectionId,
      ),
    ).toEqual([direct.id, relay.id, tailnet.id]);
    // Without the preference the saved order stands, as for any other host.
    expect(
      buildConnectionCandidates(host, "off").map((candidate) => candidate.connectionId),
    ).toEqual([relay.id, direct.id, tailnet.id]);
    // A LAN address is another machine; only loopback, sockets and pipes move up.
    const lan: HostConnection = {
      id: "direct:lan",
      type: "directTcp",
      endpoint: "192.168.1.5:6768",
    };
    expect(
      buildConnectionCandidates(
        makeHost({ connections: [lan, relay], preferredConnectionId: relay.id }),
        "off",
        {
          preferLocal: true,
        },
      ).map((candidate) => candidate.connectionId),
    ).toEqual([relay.id, lan.id]);
  });

  it("connects locally even when the saved preference is relay", async () => {
    await markDesktopBundledHost("srv_bundled");
    const host = makeHost({ preferredConnectionId: relay.id, lastConnectionId: relay.id });
    const clients: FakeClient[] = [];
    const controller = new HostRuntimeController({
      host,
      deps: makeDeps({ [direct.id]: 3, [relay.id]: 40 }, clients),
    });
    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnection?.type).toBe("directTcp");
    expect(controller.getSnapshot().connectionStatus).toBe("online");
    await controller.stop();
  });

  it("moves off relay once the local route answers", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    await markDesktopBundledHost("srv_bundled");
    const host = makeHost({});
    const clients: FakeClient[] = [];
    const latency: Record<string, number | Error> = {
      [direct.id]: new Error("daemon still starting"),
      [relay.id]: 40,
    };
    const controller = new HostRuntimeController({ host, deps: makeDeps(latency, clients) });
    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnectionId).toBe(relay.id);
    const relayClient = clients.at(-1);

    latency[direct.id] = 3;
    vi.advanceTimersByTime(10_001);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe(direct.id);
    expect(controller.getSnapshot().activeConnection?.type).toBe("directTcp");
    expect(controller.getSnapshot().connectionStatus).toBe("online");
    expect(relayClient?.isDisposed()).toBe(true);
    await controller.stop();
  });

  it("keeps any other host on a healthy relay", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
    const host = makeHost({ serverId: "srv_remote" });
    const clients: FakeClient[] = [];
    const latency: Record<string, number | Error> = {
      [direct.id]: new Error("not reachable"),
      [relay.id]: 40,
    };
    const controller = new HostRuntimeController({ host, deps: makeDeps(latency, clients) });
    await controller.start({ autoProbe: false });
    expect(controller.getSnapshot().activeConnectionId).toBe(relay.id);
    latency[direct.id] = 3;
    vi.advanceTimersByTime(10_001);
    await controller.runProbeCycleNow();
    expect(controller.getSnapshot().activeConnectionId).toBe(relay.id);
    await controller.stop();
  });
});
