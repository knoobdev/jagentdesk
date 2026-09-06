import { describe, expect, it, vi } from "vitest";

// The store reads the persisted connection mode at boot; pin it to "local" so
// the REQ 2 filter (hide tailnet-only hosts in local mode) is exercised.
vi.mock("@/tailscale", () => ({
  getConnectionMode: vi.fn(async () => "local" as const),
  clearConnectionMode: vi.fn(async () => {}),
  subscribeConnectionMode: () => () => {},
  getTailscaleLoginAdapter: () => ({}),
}));

import { clearConnectionMode } from "@/tailscale";
import { HostRuntimeStore, nextLocalRetryState, type HostRuntimeStorage } from "./host-runtime";

function memoryStorage(entries: Record<string, string>): HostRuntimeStorage {
  const values = new Map(Object.entries(entries));
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
}

const registry = JSON.stringify([
  {
    serverId: "srv_local",
    label: "Laptop",
    connections: [{ type: "directTcp", endpoint: "localhost:6797" }],
  },
  {
    serverId: "srv_tail",
    label: "Studio",
    connections: [
      {
        type: "tailnet",
        tailnetAddress: "node-1.example.ts.net:6768",
        daemonPublicKeyB64: "k",
      },
    ],
  },
]);

function neverConnectDeps() {
  return {
    createClient: () => {
      throw new Error("createClient should not be called");
    },
    connectToDaemon: async () => {
      throw new Error("unreachable");
    },
    getClientId: async () => "cid_test",
  };
}

describe("HostRuntimeStore.getHosts (REQ 2 local-mode filter)", () => {
  it("hides tailnet-only hosts in local mode but keeps local hosts, and reports tailnet presence", async () => {
    const store = new HostRuntimeStore({
      storage: memoryStorage({
        "@jagentdesk:daemon-registry": registry,
        "@jagentdesk:e2e": "1",
      }),
      deps: neverConnectDeps(),
    });
    await store.boot();

    const visibleIds = store.getHosts().map((host) => host.serverId);
    expect(visibleIds).toEqual(["srv_local"]);
    // A tailnet connection still exists in the registry even though it is hidden.
    expect(store.hasTailnetHost()).toBe(true);

    // The memoized display list is stable across repeated reads.
    expect(store.getHosts()).toBe(store.getHosts());
  });
});

describe("HostRuntimeStore.removeHost — reset connection mode when registry empties", () => {
  it("clears the persisted mode only when the LAST host is removed", async () => {
    vi.mocked(clearConnectionMode).mockClear();
    const store = new HostRuntimeStore({
      storage: memoryStorage({
        "@jagentdesk:daemon-registry": registry,
        "@jagentdesk:e2e": "1",
      }),
      deps: neverConnectDeps(),
    });
    await store.boot();

    // Removing one of two hosts leaves the registry non-empty: mode stays put so
    // the user is not bounced to the login gate while a host still exists.
    await store.removeHost("srv_tail");
    expect(clearConnectionMode).not.toHaveBeenCalled();

    // Removing the final host empties the registry and returns the app to the
    // Tailscale/Local choice gate instead of silently locking into Local.
    await store.removeHost("srv_local");
    expect(clearConnectionMode).toHaveBeenCalledTimes(1);
  });
});

describe("nextLocalRetryState (REQ 4 retry-counter logic)", () => {
  const base = { maxRetries: 3, exhausted: false } as const;

  it("never counts failures on a tailnet connection", () => {
    expect(
      nextLocalRetryState({
        ...base,
        connectionType: "tailnet",
        previousTag: "connecting",
        nextTag: "error",
        currentCount: 2,
      }),
    ).toEqual({ count: 2, exhausted: false });
  });

  it("increments on a connect failure and exhausts at maxRetries", () => {
    let count = 0;
    let exhausted = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = nextLocalRetryState({
        connectionType: "directTcp",
        previousTag: "connecting",
        nextTag: "error",
        currentCount: count,
        exhausted,
        maxRetries: 3,
      });
      count = result.count;
      exhausted = result.exhausted;
    }
    expect(count).toBe(3);
    expect(exhausted).toBe(true);
  });

  it("resets on reaching online", () => {
    expect(
      nextLocalRetryState({
        ...base,
        connectionType: "directTcp",
        previousTag: "connecting",
        nextTag: "online",
        currentCount: 2,
        exhausted: true,
      }),
    ).toEqual({ count: 0, exhausted: false });
  });

  it("does not count a transition that did not come from connecting/online", () => {
    expect(
      nextLocalRetryState({
        ...base,
        connectionType: "directTcp",
        previousTag: "offline",
        nextTag: "error",
        currentCount: 1,
      }),
    ).toEqual({ count: 1, exhausted: false });
  });

  it("stops counting once already exhausted", () => {
    expect(
      nextLocalRetryState({
        connectionType: "directTcp",
        previousTag: "connecting",
        nextTag: "error",
        currentCount: 3,
        exhausted: true,
        maxRetries: 3,
      }),
    ).toEqual({ count: 3, exhausted: true });
  });
});
