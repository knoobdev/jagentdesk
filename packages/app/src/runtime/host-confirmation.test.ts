import { HostRuntimeStore } from "./host-runtime";
import { createHash, webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionOffer } from "@jagentdesk/protocol/connection-offer";
import { connectionsFromOffer, type HostProfile } from "@/types/host-connection";
import { defaultHostAppearance } from "@/hosts/appearance";
// Expo's native digest adapter is unavailable in Node; use the real WebCrypto adapter.
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digest: (algorithm: string, bytes: Uint8Array) => webcrypto.subtle.digest(algorithm, bytes),
}));
import { HostConfirmations, formatDaemonKeyFingerprint } from "./host-confirmation";
const key = Buffer.alloc(32, 7).toString("base64");
const offer: ConnectionOffer = {
  v: 3,
  serverId: "confirmation-host",
  daemonPublicKeyB64: key,
  tailnetAddress: "100.64.0.1:6767",
  relay: { endpoint: "127.0.0.1:6934", useTls: false },
};
function saved(): HostProfile {
  return {
    serverId: offer.serverId,
    label: "My host",
    connections: connectionsFromOffer(offer),
    appearance: defaultHostAppearance(),
    lifecycle: {},
    preferredConnectionId: null,
    createdAt: "",
    updatedAt: "",
  };
}
async function pending(confirmations: HostConfirmations) {
  await vi.waitFor(() => expect(confirmations.getPending()).not.toBeNull());
  return confirmations.getPending()!;
}
describe("host offer confirmation", () => {
  it("waits for approval for a new host and cancellation resolves false", async () => {
    const confirmations = new HostConfirmations();
    const result = confirmations.confirmLink(offer, []);
    const request = await pending(confirmations);
    expect(request.kind).toBe("newHost");
    expect(request.routes).toContain("100.64.0.1:6767");
    confirmations.answer(request.id, false);
    expect(await result).toBe(false);
    expect(confirmations.getPending()).toBeNull();
  });
  it("connects an exactly matching saved host without asking", async () => {
    const confirmations = new HostConfirmations();
    expect(await confirmations.confirmLink(offer, [saved()])).toBe(true);
    expect(confirmations.getPending()).toBeNull();
  });
  it.each(["key", "tailnet", "relay", "tls"])(
    "asks before changing %s and retains previous values",
    async (change) => {
      const confirmations = new HostConfirmations();
      const next = { ...offer, relay: { ...offer.relay! } };
      if (change === "key") next.daemonPublicKeyB64 = Buffer.alloc(32, 8).toString("base64");
      if (change === "tailnet") next.tailnetAddress = "100.64.0.2:6767";
      if (change === "relay") next.relay.endpoint = "127.0.0.1:6935";
      if (change === "tls") next.relay.useTls = true;
      const result = confirmations.confirmLink(next, [saved()]);
      const request = await pending(confirmations);
      expect(request.kind).toBe("changedConnection");
      expect(request.previousRoutes).toContain("100.64.0.1:6767");
      expect(request.keyChanged).toBe(change === "key");
      confirmations.answer(request.id, true);
      expect(await result).toBe(true);
    },
  );
  it("ignores stale answers and aborts a pending screen", async () => {
    const confirmations = new HostConfirmations();
    const first = confirmations.confirmLink(offer, []);
    const old = await pending(confirmations);
    const abort = new AbortController();
    const second = confirmations.confirmLink({ ...offer, serverId: "second" }, [], abort.signal);
    await vi.waitFor(() => expect(confirmations.getPending()?.serverId).toBe("second"));
    expect(await first).toBe(false);
    confirmations.answer(old.id, true);
    expect(confirmations.getPending()?.serverId).toBe("second");
    abort.abort();
    expect(await second).toBe(false);
  });
  it("cancels an older question when a newer link exactly matches a saved host", async () => {
    const confirmations = new HostConfirmations();
    const first = confirmations.confirmLink(offer, []);
    await pending(confirmations);
    expect(await confirmations.confirmLink(offer, [saved()])).toBe(true);
    expect(await first).toBe(false);
    expect(confirmations.getPending()).toBeNull();
  });

  it("does not persist or open a connection when an imported offer is cancelled", async () => {
    const writes: string[] = [];
    const dials: string[] = [];
    const store = new HostRuntimeStore({
      storage: {
        getItem: async () => null,
        setItem: async (name) => {
          writes.push(name);
        },
      },
      deps: {
        getClientId: async () => "confirmation-test",
        createClient: () => {
          dials.push("create");
          throw new Error("Unexpected connection");
        },
        connectToDaemon: async () => {
          dials.push("probe");
          throw new Error("Unexpected probe");
        },
      },
    });
    const url =
      "jagentdesk://app/#offer=" + Buffer.from(JSON.stringify(offer)).toString("base64url");
    const result = store.upsertConnectionFromOfferUrl(url);
    await vi.waitFor(() => expect(store.getPendingHostConfirmation()).not.toBeNull());
    expect(store.getHosts()).toEqual([]);
    expect(writes).toEqual([]);
    expect(dials).toEqual([]);
    store.answerHostConfirmation(store.getPendingHostConfirmation()!.id, false);
    expect(await result).toBeNull();
    expect(store.getHosts()).toEqual([]);
    expect(writes).toEqual([]);
    expect(dials).toEqual([]);
    store.syncHosts([]);
  });

  it("hashes the decoded key into eight SHA-256 groups", async () => {
    expect(await formatDaemonKeyFingerprint(key)).toBe(
      createHash("sha256")
        .update(Buffer.alloc(32, 7))
        .digest("hex")
        .slice(0, 32)
        .match(/.{4}/g)!
        .join(" "),
    );
  });
});
