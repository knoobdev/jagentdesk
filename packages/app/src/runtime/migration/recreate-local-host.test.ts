import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@jagentdesk/client";
import type { HostDataImportResult } from "@jagentdesk/protocol/migration/host-data-bundle";

import { defaultHostAppearance } from "@/hosts/appearance";
import type { HostConnection, HostProfile } from "@/types/host-connection";
import {
  findLocalConnection,
  NoLocalConnectionError,
  recreateLocalHost,
  type RecreateLocalHostDeps,
} from "./recreate-local-host";

const LOCAL_CONNECTION: HostConnection = {
  id: "direct:localhost:6796",
  type: "directTcp",
  endpoint: "localhost:6796",
};

const TAILNET_CONNECTION: HostConnection = {
  id: "tailnet:100.1.2.3:6768",
  type: "tailnet",
  tailnetAddress: "100.1.2.3:6768",
  daemonPublicKeyB64: "cGs=",
};

function makeHost(serverId: string, connections: HostConnection[]): HostProfile {
  const now = new Date(0).toISOString();
  return {
    serverId,
    label: `host-${serverId}`,
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

const FAKE_CLIENT = {} as DaemonClient;

interface HarnessOptions {
  hosts: HostProfile[];
  probeServerId: string;
  clientsByServer?: Record<string, DaemonClient>;
  migrateResult?: HostDataImportResult;
  migrateError?: Error;
}

function makeHarness(options: HarnessOptions): {
  deps: RecreateLocalHostDeps;
  probe: ReturnType<typeof vi.fn>;
  removeHost: ReturnType<typeof vi.fn>;
  migrate: ReturnType<typeof vi.fn>;
} {
  const clients = options.clientsByServer ?? {};
  const probe = vi.fn(async () => ({
    profile: makeHost(options.probeServerId, [LOCAL_CONNECTION]),
    serverId: options.probeServerId,
    hostname: null,
  }));
  const removeHost = vi.fn(async () => undefined);
  const migrate = vi.fn(async () => {
    if (options.migrateError) {
      throw options.migrateError;
    }
    // recreateLocalHost only reads result.idMap; the harness returns a minimal
    // stand-in (cast through the migrate type) rather than a full import result.
    return options.migrateResult ?? { idMap: { a1: "b1", a2: "b2" } };
  });
  const deps: RecreateLocalHostDeps = {
    hostRuntime: {
      getHosts: () => options.hosts,
      getClient: (serverId: string) => clients[serverId] ?? null,
      getHostLabel: (serverId: string) =>
        options.hosts.find((host) => host.serverId === serverId)?.label ?? null,
      remapReplicaCacheAgentIds: vi.fn(),
      probeAndUpsertConnection:
        probe as unknown as RecreateLocalHostDeps["hostRuntime"]["probeAndUpsertConnection"],
      removeHost,
    },
    migrate: migrate as unknown as typeof import("./host-migration-service").migrateHostData,
  };
  return { deps, probe, removeHost, migrate };
}

describe("findLocalConnection", () => {
  it("prefers the preferred connection when it is local", () => {
    const host = makeHost("s1", [TAILNET_CONNECTION, LOCAL_CONNECTION]);
    host.preferredConnectionId = LOCAL_CONNECTION.id;
    expect(findLocalConnection(host)).toBe(LOCAL_CONNECTION);
  });

  it("falls back to the first non-tailnet connection", () => {
    const host = makeHost("s1", [TAILNET_CONNECTION, LOCAL_CONNECTION]);
    host.preferredConnectionId = TAILNET_CONNECTION.id;
    expect(findLocalConnection(host)).toBe(LOCAL_CONNECTION);
  });

  it("returns null for a tailnet-only host", () => {
    const host = makeHost("s1", [TAILNET_CONNECTION]);
    expect(findLocalConnection(host)).toBeNull();
  });
});

describe("recreateLocalHost", () => {
  it("throws when the host has no local connection", async () => {
    const { deps } = makeHarness({
      hosts: [makeHost("s1", [TAILNET_CONNECTION])],
      probeServerId: "s1",
    });
    await expect(recreateLocalHost("s1", deps)).rejects.toBeInstanceOf(NoLocalConnectionError);
  });

  it("reconnects (no migration) when the re-probe resolves to the same daemon", async () => {
    const { deps, migrate, removeHost } = makeHarness({
      hosts: [makeHost("s1", [LOCAL_CONNECTION])],
      probeServerId: "s1",
      clientsByServer: { s1: FAKE_CLIENT },
    });
    const outcome = await recreateLocalHost("s1", deps);
    expect(outcome).toEqual({ status: "reconnected", serverId: "s1" });
    expect(migrate).not.toHaveBeenCalled();
    expect(removeHost).not.toHaveBeenCalled();
  });

  it("reconnects without migrating when the old daemon is unreachable", async () => {
    // New daemon identity but no live source client → cannot export, so no move.
    const { deps, migrate, removeHost } = makeHarness({
      hosts: [makeHost("s1", [LOCAL_CONNECTION])],
      probeServerId: "s2",
      clientsByServer: { s2: FAKE_CLIENT },
    });
    const outcome = await recreateLocalHost("s1", deps);
    expect(outcome).toEqual({ status: "reconnected", serverId: "s2" });
    expect(migrate).not.toHaveBeenCalled();
    expect(removeHost).not.toHaveBeenCalled();
  });

  it("migrates then removes the old host when a fresh daemon and both clients are live", async () => {
    const oldClient = {} as DaemonClient;
    const newClient = {} as DaemonClient;
    const { deps, migrate, removeHost } = makeHarness({
      hosts: [makeHost("s1", [LOCAL_CONNECTION])],
      probeServerId: "s2",
      clientsByServer: { s1: oldClient, s2: newClient },
    });
    const outcome = await recreateLocalHost("s1", deps);
    expect(outcome).toEqual({ status: "recreated", serverId: "s2", migratedAgentCount: 2 });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(migrate.mock.calls[0]?.[0]).toMatchObject({
      sourceServerId: "s1",
      targetServerId: "s2",
      sourceClient: oldClient,
      targetClient: newClient,
    });
    expect(removeHost).toHaveBeenCalledWith("s1");
  });

  it("keeps the old host when migration fails", async () => {
    const { deps, removeHost } = makeHarness({
      hosts: [makeHost("s1", [LOCAL_CONNECTION])],
      probeServerId: "s2",
      clientsByServer: { s1: {} as DaemonClient, s2: {} as DaemonClient },
      migrateError: new Error("export failed"),
    });
    await expect(recreateLocalHost("s1", deps)).rejects.toThrow("export failed");
    expect(removeHost).not.toHaveBeenCalled();
  });
});
