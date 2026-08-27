import { describe, expect, it } from "vitest";
import { defaultHostAppearance } from "@/hosts/appearance";
import {
  disambiguateHostLabels,
  hostHasLocalConnection,
  hostHasTailnetConnection,
  normalizeStoredHostProfile,
  orderHostsLocalFirst,
  resolveActiveHostServerId,
  upsertHostConnectionInProfiles,
  type HostConnection,
  type HostProfile,
} from "./host-connection";

function makeVisibilityHost(serverId: string, connections: HostConnection[]): HostProfile {
  return {
    serverId,
    label: serverId,
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const visibilityDirect: HostConnection = {
  id: "direct:localhost:6797",
  type: "directTcp",
  endpoint: "localhost:6797",
};
const visibilitySocket: HostConnection = {
  id: "socket:/tmp/jagentdesk.sock",
  type: "directSocket",
  path: "/tmp/jagentdesk.sock",
};
const visibilityTailnet: HostConnection = {
  id: "tailnet:jcode-1:6768",
  type: "tailnet",
  tailnetAddress: "jcode-1.tailf900c1.ts.net:6768",
  daemonPublicKeyB64: "k",
};

describe("hostHasLocalConnection / hostHasTailnetConnection", () => {
  it("treats a tailnet-only host as having no local connection", () => {
    const host = makeVisibilityHost("srv_tail", [visibilityTailnet]);
    expect(hostHasLocalConnection(host)).toBe(false);
    expect(hostHasTailnetConnection(host)).toBe(true);
  });

  it("treats a direct/socket/pipe host as having a local connection", () => {
    expect(hostHasLocalConnection(makeVisibilityHost("srv_tcp", [visibilityDirect]))).toBe(true);
    expect(hostHasLocalConnection(makeVisibilityHost("srv_sock", [visibilitySocket]))).toBe(true);
    expect(hostHasTailnetConnection(makeVisibilityHost("srv_tcp", [visibilityDirect]))).toBe(false);
  });

  it("keeps a dual-connection host local-visible while still tailnet-capable", () => {
    const dual = makeVisibilityHost("srv_dual", [visibilityTailnet, visibilityDirect]);
    expect(hostHasLocalConnection(dual)).toBe(true);
    expect(hostHasTailnetConnection(dual)).toBe(true);
  });
});

describe("disambiguateHostLabels", () => {
  function hostWith(serverId: string, label: string, connection: HostConnection): HostProfile {
    return {
      serverId,
      label,
      appearance: defaultHostAppearance(),
      lifecycle: {},
      connections: [connection],
      preferredConnectionId: connection.id,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("appends the connection hint only to hosts whose label collides", () => {
    const hosts = [
      hostWith("srv_a", "JCode.local", {
        id: "direct:localhost:6796",
        type: "directTcp",
        endpoint: "localhost:6796",
      }),
      hostWith("srv_b", "JCode.local", {
        id: "tailnet:jcode-1:6768",
        type: "tailnet",
        tailnetAddress: "jcode-1.tailf900c1.ts.net:6768",
        daemonPublicKeyB64: "k",
      }),
      hostWith("srv_c", "OtherBox", {
        id: "direct:localhost:6767",
        type: "directTcp",
        endpoint: "localhost:6767",
      }),
    ];

    const result = disambiguateHostLabels(hosts);

    expect(result[0]?.label).toBe("JCode.local (localhost:6796)");
    expect(result[1]?.label).toBe("JCode.local (jcode-1.tailf900c1.ts.net:6768)");
    // A unique label is left untouched.
    expect(result[2]?.label).toBe("OtherBox");
    // serverIds are never mutated.
    expect(result.map((h) => h.serverId)).toEqual(["srv_a", "srv_b", "srv_c"]);
  });

  it("leaves a list with no collisions unchanged", () => {
    const hosts = [
      hostWith("srv_a", "Alpha", {
        id: "direct:localhost:6796",
        type: "directTcp",
        endpoint: "localhost:6796",
      }),
      hostWith("srv_b", "Beta", {
        id: "direct:localhost:6797",
        type: "directTcp",
        endpoint: "localhost:6797",
      }),
    ];

    expect(disambiguateHostLabels(hosts).map((h) => h.label)).toEqual(["Alpha", "Beta"]);
  });
});

function makeHost(serverId: string): HostProfile {
  return {
    serverId,
    label: serverId,
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("orderHostsLocalFirst", () => {
  it("moves the local host to the first position", () => {
    const remote = makeHost("srv_remote");
    const local = makeHost("srv_local");
    const anotherRemote = makeHost("srv_another_remote");

    expect(orderHostsLocalFirst([remote, local, anotherRemote], "srv_local")).toEqual([
      local,
      remote,
      anotherRemote,
    ]);
  });

  it("preserves host order when the local host is missing", () => {
    const hosts = [makeHost("srv_remote"), makeHost("srv_another_remote")];

    expect(orderHostsLocalFirst(hosts, "srv_local")).toBe(hosts);
  });

  it("preserves host order when there is no local host", () => {
    const hosts = [makeHost("srv_remote"), makeHost("srv_another_remote")];

    expect(orderHostsLocalFirst(hosts, null)).toBe(hosts);
  });
});

describe("normalizeStoredHostProfile", () => {
  it("loads direct TCP connections stored before TLS and password fields existed", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_old",
      label: "Old Host",
      connections: [
        {
          id: "direct:127.0.0.1:6767",
          type: "directTcp",
          endpoint: "127.0.0.1:6767",
        },
      ],
      preferredConnectionId: "direct:127.0.0.1:6767",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });

    expect(profile).not.toBeNull();
    expect(profile?.connections[0]).toEqual({
      id: "direct:localhost:6767",
      type: "directTcp",
      endpoint: "localhost:6767",
      useTls: false,
    });
    expect(profile?.connections[0]).not.toHaveProperty("password");
  });

  it("drops unsupported legacy network records from stored hosts", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_legacy_network",
      connections: [
        {
          id: "legacy:old.example.com:80",
          type: "legacy",
          endpoint: "old.example.com:80",
          daemonPublicKeyB64: "pubkey",
        },
      ],
    });

    // JAgentDesk is greenfield: a host whose only connection is an unsupported
    // record has nothing reachable, so the host is dropped entirely.
    expect(profile).toBeNull();
  });

  it("preserves tailnet ids when TLS is absent", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_tailnet",
      connections: [
        {
          id: "tailnet:100.64.0.1:6767",
          type: "tailnet",
          tailnetAddress: "100.64.0.1:6767",
          daemonPublicKeyB64: "pubkey",
        },
      ],
    });

    expect(profile?.connections[0]).toEqual({
      id: "tailnet:100.64.0.1:6767",
      type: "tailnet",
      tailnetAddress: "100.64.0.1:6767",
      daemonPublicKeyB64: "pubkey",
    });
  });

  it("namespaces tailnet ids only when TLS is true", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_tailnet",
      connections: [
        {
          id: "tailnet:tailnet.example.ts.net:443",
          type: "tailnet",
          tailnetAddress: "tailnet.example.ts.net:443",
          useTls: true,
          daemonPublicKeyB64: "pubkey",
        },
      ],
    });

    expect(profile?.connections[0]).toEqual({
      id: "tailnet:wss:tailnet.example.ts.net:443",
      type: "tailnet",
      tailnetAddress: "tailnet.example.ts.net:443",
      useTls: true,
      daemonPublicKeyB64: "pubkey",
    });
  });

  it("gives a host stored before appearance existed the default appearance", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_old",
      connections: [
        { id: "socket:/tmp/jagentdesk.sock", type: "directSocket", path: "/tmp/jagentdesk.sock" },
      ],
    });

    expect(profile?.appearance).toEqual({ color: "none", badgeDisplay: null });
  });

  it("loads a stored appearance the user chose", () => {
    const profile = normalizeStoredHostProfile({
      serverId: "srv_new",
      appearance: { color: "teal", badgeDisplay: "icon" },
      connections: [
        { id: "socket:/tmp/jagentdesk.sock", type: "directSocket", path: "/tmp/jagentdesk.sock" },
      ],
    });

    expect(profile?.appearance).toEqual({ color: "teal", badgeDisplay: "icon" });
  });
});

describe("upsertHostConnectionInProfiles", () => {
  const connection: HostConnection = {
    id: "socket:/tmp/jagentdesk.sock",
    type: "directSocket",
    path: "/tmp/jagentdesk.sock",
  };

  it("gives a newly discovered host the default appearance", () => {
    const [profile] = upsertHostConnectionInProfiles({
      profiles: [],
      serverId: "srv_new",
      connection,
    });

    expect(profile.appearance).toEqual({ color: "none", badgeDisplay: null });
  });

  it("keeps the appearance the user chose when the host reconnects", () => {
    const existing: HostProfile = {
      ...makeHost("srv_known"),
      appearance: { color: "amber", badgeDisplay: "hidden" },
      connections: [],
    };

    const [profile] = upsertHostConnectionInProfiles({
      profiles: [existing],
      serverId: "srv_known",
      connection,
    });

    expect(profile.appearance).toEqual({ color: "amber", badgeDisplay: "hidden" });
  });

  it("dedupes an identical tailnet connection when re-pairing", () => {
    const tailnet: HostConnection = {
      id: "tailnet:100.64.0.1:6767",
      type: "tailnet",
      tailnetAddress: "100.64.0.1:6767",
      daemonPublicKeyB64: "pk",
    };
    const existing: HostProfile = {
      ...makeHost("srv_known"),
      connections: [tailnet],
      preferredConnectionId: tailnet.id,
    };

    const [profile] = upsertHostConnectionInProfiles({
      profiles: [existing],
      serverId: "srv_known",
      connection: { ...tailnet },
    });

    expect(profile.connections).toEqual([tailnet]);
  });

  it("treats tailnet connections with different TLS as distinct", () => {
    const plain: HostConnection = {
      id: "tailnet:100.64.0.1:6767",
      type: "tailnet",
      tailnetAddress: "100.64.0.1:6767",
      daemonPublicKeyB64: "pk",
    };
    const tls: HostConnection = {
      ...plain,
      id: "tailnet:wss:100.64.0.1:6767",
      useTls: true,
    };
    const existing: HostProfile = {
      ...makeHost("srv_known"),
      connections: [plain],
      preferredConnectionId: plain.id,
    };

    const [profile] = upsertHostConnectionInProfiles({
      profiles: [existing],
      serverId: "srv_known",
      connection: tls,
    });

    expect(profile.connections).toEqual([plain, tls]);
  });
});

describe("resolveActiveHostServerId", () => {
  it("uses the selected host when one is set", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_selected",
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_selected")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_selected")],
      }),
    ).toBe("srv_selected");
  });

  it("falls back to the local host when it is connected", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_remote")],
      }),
    ).toBe("srv_local");
  });

  it("skips a stopped local daemon and uses the first connected host", () => {
    // Regression: a stopped local daemon's serverId persists but isn't in `hosts`.
    // Falling back to it would resolve the section to an unknown id ("host not found").
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local_stopped",
        hosts: [makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_remote")],
      }),
    ).toBe("srv_remote");
  });

  it("returns null when no hosts are connected", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: null,
        localServerId: "srv_local_stopped",
        hosts: [],
        orderedHosts: [],
      }),
    ).toBeNull();
  });

  it("ignores a selected host that is not connected", () => {
    // A stale selection (e.g. the host was removed) must not be used unless it is
    // currently connected, or the section resolves to an unknown id ("host not found").
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_stale_selection",
        localServerId: null,
        hosts: [makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_remote")],
      }),
    ).toBe("srv_remote");
  });

  it("falls through a disconnected selection to the connected local host", () => {
    expect(
      resolveActiveHostServerId({
        selectedServerId: "srv_stale_selection",
        localServerId: "srv_local",
        hosts: [makeHost("srv_local"), makeHost("srv_remote")],
        orderedHosts: [makeHost("srv_local"), makeHost("srv_remote")],
      }),
    ).toBe("srv_local");
  });
});
