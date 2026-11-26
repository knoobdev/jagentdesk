import { createHostLogger } from "@/runtime/host-logger";
import { connectToDaemon, describeConnectTimeout } from "./test-daemon-connection";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClientConfig } from "@jagentdesk/client/internal/daemon-client";
import type { DaemonConnectionDependencies, DaemonProbeClient } from "./test-daemon-connection";

class FakeDaemonClient implements DaemonProbeClient {
  readonly lastError: string | null;

  constructor(
    private readonly probe: FakeDaemonProbe,
    readonly config: DaemonClientConfig,
  ) {
    this.lastError = probe.nextLastError;
  }

  async connect(): Promise<void> {
    if (this.probe.hangNextConnection) {
      return new Promise<void>(() => {});
    }
    if (this.probe.nextConnectError) {
      throw this.probe.nextConnectError;
    }
  }

  getLastServerInfoMessage() {
    return {
      serverId: "srv_probe_test",
      hostname: "probe-host",
    };
  }

  async close(): Promise<void> {
    this.probe.closedClients.push(this);
  }
}

class FakeDaemonProbe {
  diagnosticLines: string[] = [];
  createdClients: FakeDaemonClient[] = [];
  closedClients: FakeDaemonClient[] = [];
  clientIdsRequested = 0;
  nextConnectError: Error | null = null;
  nextLastError: string | null = null;
  hangNextConnection = false;

  readonly deps: DaemonConnectionDependencies<FakeDaemonClient> = {
    createLogger: (readServerId) => {
      const capture = (...values: unknown[]) =>
        this.diagnosticLines.push(values.map(String).join(" "));
      return createHostLogger(readServerId, { log: capture, warn: capture, error: capture });
    },
    getClientId: async () => {
      this.clientIdsRequested += 1;
      return "cid_shared_probe_test";
    },
    resolveAppVersion: () => null,
    createLocalTransportFactory: () => null,
    buildLocalTransportUrl: ({ transportType, transportPath }) =>
      `jagentdesk+local://${transportType}?path=${encodeURIComponent(transportPath)}`,
    createClient: (config) => {
      const client = new FakeDaemonClient(this, config);
      this.createdClients.push(client);
      return client;
    },
  };

  failNextConnection(error: Error, lastError: string | null): void {
    this.nextConnectError = error;
    this.nextLastError = lastError;
  }

  createdConfigs(): DaemonClientConfig[] {
    return this.createdClients.map((client) => client.config);
  }
}

describe("test-daemon-connection connectToDaemon", () => {
  let probe: FakeDaemonProbe;

  beforeEach(() => {
    vi.stubGlobal("__DEV__", false);
    probe = new FakeDaemonProbe();
  });

  it("retains the learned host identity in adopted probe logs after close", async () => {
    const result = await connectToDaemon(
      { id: "direct:test", type: "directTcp", endpoint: "127.0.0.1:6934" },
      undefined,
      probe.deps,
    );
    await result.client.close();
    result.client.config.logger!.error({ err: new Error("socket closed") }, "connection_error");
    const record = JSON.parse(probe.diagnosticLines[0]!.slice("connection_error ".length));
    expect(record.serverId).toBe("srv_probe_test");
    expect(record.err.message).toBe("socket closed");
  });

  it("reuses the app clientId for direct connections", async () => {
    const first = await connectToDaemon(
      {
        id: "direct:lan:6767",
        type: "directTcp",
        endpoint: "lan:6767",
      },
      undefined,
      probe.deps,
    );
    await first.client.close();

    const second = await connectToDaemon(
      {
        id: "direct:lan:6767",
        type: "directTcp",
        endpoint: "lan:6767",
      },
      undefined,
      probe.deps,
    );
    await second.client.close();

    const [firstConfig, secondConfig] = probe.createdConfigs();
    expect(firstConfig?.clientId).toBe("cid_shared_probe_test");
    expect(secondConfig?.clientId).toBe("cid_shared_probe_test");
    expect(probe.clientIdsRequested).toBe(2);
  });

  it("encodes the local socket target into the client config", async () => {
    const result = await connectToDaemon(
      {
        id: "socket:/tmp/jagentdesk.sock",
        type: "directSocket",
        path: "/tmp/jagentdesk.sock",
      },
      undefined,
      probe.deps,
    );
    await result.client.close();

    expect(probe.createdConfigs()[0]?.url).toBe(
      "jagentdesk+local://socket?path=%2Ftmp%2Fjagentdesk.sock",
    );
  });

  it("passes direct TCP connection passwords into the client config", async () => {
    const result = await connectToDaemon(
      {
        id: "direct:lan:6767",
        type: "directTcp",
        endpoint: "lan:6767",
        password: "shared-secret",
      },
      undefined,
      probe.deps,
    );
    await result.client.close();

    expect(probe.createdConfigs()[0]?.password).toBe("shared-secret");
  });

  it("dials tailnet connections directly with no e2ee config", async () => {
    const tlsResult = await connectToDaemon(
      {
        id: "tailnet:wss:[::1]:8443",
        type: "tailnet",
        tailnetAddress: "[::1]:8443",
        useTls: true,
        daemonPublicKeyB64: "pubkey",
      },
      undefined,
      probe.deps,
    );
    await tlsResult.client.close();

    const plainResult = await connectToDaemon(
      {
        id: "tailnet:tailnet.example.ts.net:6767",
        type: "tailnet",
        tailnetAddress: "tailnet.example.ts.net:6767",
        useTls: false,
        daemonPublicKeyB64: "pubkey",
      },
      undefined,
      probe.deps,
    );
    await plainResult.client.close();

    const [tlsConfig, plainConfig] = probe.createdConfigs();
    expect(tlsConfig?.url).toBe("wss://[::1]:8443/ws?paired=1");
    expect(plainConfig?.url).toBe("ws://tailnet.example.ts.net:6767/ws?paired=1");
    expect(tlsConfig).not.toHaveProperty("e2ee");
    expect(plainConfig).not.toHaveProperty("e2ee");
  });

  it("surfaces auth rejection as an incorrect password", async () => {
    probe.failNextConnection(
      new Error("Transport closed (code 4001)"),
      "Transport closed (code 4001)",
    );

    await expect(
      connectToDaemon(
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
          password: "wrong-secret",
        },
        undefined,
        probe.deps,
      ),
    ).rejects.toMatchObject({
      message: "Incorrect password",
    });
  });

  it("keeps generic transport failures generic when a password was supplied", async () => {
    probe.failNextConnection(new Error("Transport error"), "Transport error");

    await expect(
      connectToDaemon(
        {
          id: "direct:lan:6767",
          type: "directTcp",
          endpoint: "lan:6767",
          password: "shared-secret",
        },
        undefined,
        probe.deps,
      ),
    ).rejects.toMatchObject({
      message: "Transport error",
    });
  });

  it("cancels an in-flight probe and closes its client when the caller leaves", async () => {
    probe.hangNextConnection = true;
    const controller = new AbortController();
    const attempt = connectToDaemon(
      {
        id: "direct:tailnet-host:6768",
        type: "directTcp",
        endpoint: "tailnet-host:6768",
      },
      { signal: controller.signal, timeoutMs: 60_000 },
      probe.deps,
    );

    controller.abort();

    await expect(attempt).rejects.toMatchObject({ message: "Connection attempt cancelled" });
    expect(probe.closedClients).toHaveLength(1);
  });
});

describe("describeConnectTimeout", () => {
  it("names the stage a timed-out attempt stopped at", () => {
    expect(describeConnectTimeout({ connectStage: "challenged", lastError: null })).toBe(
      "Connection timed out: this device did not answer the host's sign-in challenge.",
    );
    expect(describeConnectTimeout({ connectStage: "hello_sent", lastError: null })).toBe(
      "Connection timed out waiting for the host to accept this device.",
    );
  });

  it("adds the error recorded during the attempt", () => {
    expect(
      describeConnectTimeout({
        connectStage: "opened",
        lastError: "Failed to handle a message from the host: boom",
      }),
    ).toBe(
      "Connection timed out: the host did not ask this device to sign in. (Failed to handle a message from the host: boom)",
    );
  });

  it("keeps the plain sentence for a client that reports no stage", () => {
    expect(describeConnectTimeout({ lastError: null })).toBe("Connection timed out");
  });
});
