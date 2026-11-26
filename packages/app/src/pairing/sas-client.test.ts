import { afterEach, describe, expect, it, vi } from "vitest";
import { createPairingEphemeral, pairingBase64Url } from "@jagentdesk/relay/e2ee";
import type { DaemonTransport } from "@jagentdesk/client/internal/daemon-client-transport";
import { PairingError, pairAppDevice, pairingFailureFromError } from "./sas-client";

/** A scripted daemon end of the pairing socket. */
function createPeer() {
  const handlers = {
    open: new Set<() => void>(),
    close: new Set<(event?: unknown) => void>(),
    error: new Set<(event?: unknown) => void>(),
    message: new Set<(data: unknown, binary: boolean) => void | Promise<void>>(),
  };
  const sent: Array<Record<string, unknown>> = [];
  let closed = false;
  const add = <T>(set: Set<T>, handler: T) => {
    set.add(handler);
    return () => set.delete(handler);
  };
  const transport: DaemonTransport = {
    send: (data) => {
      if (closed) throw new Error("closed");
      sent.push(JSON.parse(String(data)));
    },
    close: () => {
      closed = true;
    },
    onOpen: (handler) => add(handlers.open, handler),
    onClose: (handler) => add(handlers.close, handler),
    onError: (handler) => add(handlers.error, handler),
    onMessage: (handler) => add(handlers.message, handler),
  };
  return {
    transport,
    sent,
    get closed() {
      return closed;
    },
    open: () => handlers.open.forEach((h) => h()),
    drop: () => handlers.close.forEach((h) => h({ code: 1012 })),
    error: () => handlers.error.forEach((h) => h(new Error("boom"))),
    /** Does not wait for the handler: a challenge handler waits on the user. */
    deliver: async (message: Record<string, unknown>) => {
      for (const h of handlers.message) void h(JSON.stringify(message), false);
      await Promise.resolve();
    },
  };
}

const host = createPairingEphemeral();
const pk = host.publicKey;

function start(
  peer: ReturnType<typeof createPeer>,
  compare: (code: string) => Promise<boolean> = async () => true,
) {
  return pairAppDevice({
    transport: peer.transport,
    pk,
    publicKey: Buffer.alloc(32, 1).toString("base64"),
    label: "Phone",
    kind: "mobile",
    signal: new AbortController().signal,
    compare,
  });
}
async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(PairingError);
  return (error as PairingError).failure;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("pairAppDevice failures", () => {
  it("reports the daemon's reason instead of one generic sentence", async () => {
    const peer = createPeer();
    const pairing = start(peer);
    peer.open();
    await peer.deliver({ type: "pair_error", code: "pairing_expired", reason: "replaced" });
    const error = await pairing.catch((e: PairingError) => e);
    expect(error).toMatchObject({ failure: "replaced" });
    expect((error as Error).message).toContain("newer pairing link");
    expect(peer.closed).toBe(true);
  });

  it("keeps the old sentence for a daemon that sends no reason", () => {
    expect(pairingFailureFromError({})).toBe("rejected");
    expect(pairingFailureFromError({ reason: "from_the_future" })).toBe("rejected");
    expect(pairingFailureFromError({ reason: "in_use" })).toBe("in_use");
    expect(new PairingError("rejected").message).toBe(
      "Pairing failed. Generate a new link on the host.",
    );
  });

  it("tells a socket that never opened from one that dropped mid-exchange", async () => {
    const neverOpened = createPeer();
    const first = start(neverOpened);
    neverOpened.error();
    expect(await failureOf(first)).toBe("connection_failed");

    const dropped = createPeer();
    const second = start(dropped, () => new Promise(() => {}));
    dropped.open();
    await dropped.deliver({
      type: "pair_challenge",
      pk,
      nonce_host: pairingBase64Url(new Uint8Array(32).fill(5)),
    });
    dropped.drop();
    expect(await failureOf(second)).toBe("connection_lost");
  });

  it("sends exactly one hello even if the transport reports open twice", async () => {
    const peer = createPeer();
    const pairing = start(peer);
    peer.open();
    peer.open();
    expect(peer.sent.filter((m) => m.type === "pair_hello")).toHaveLength(1);
    peer.drop();
    await pairing.catch(() => undefined);
  });
});

describe("pairAppDevice keepalive", () => {
  it("pings every 10 s while the user compares, and gives up when nothing comes back", async () => {
    vi.useFakeTimers();
    const peer = createPeer();
    const pairing = start(peer, () => new Promise(() => {}));
    const outcome = pairing.catch((e: PairingError) => e.failure);
    peer.open();
    await peer.deliver({
      type: "pair_challenge",
      pk,
      nonce_host: pairingBase64Url(new Uint8Array(32).fill(5)),
    });
    vi.advanceTimersByTime(10_000);
    expect(peer.sent.map((m) => m.type)).toEqual(["pair_hello", "ping"]);
    // A pong keeps the exchange alive past the liveness window.
    await peer.deliver({ type: "pong" });
    vi.advanceTimersByTime(20_000);
    expect(peer.sent.filter((m) => m.type === "ping")).toHaveLength(3);
    // Silence: no pong for longer than the liveness window ends the exchange.
    vi.advanceTimersByTime(30_000);
    expect(await outcome).toBe("connection_lost");
    expect(peer.closed).toBe(true);
  });

  it("stops pinging once the exchange is over", async () => {
    vi.useFakeTimers();
    const peer = createPeer();
    const pairing = start(peer);
    peer.open();
    await peer.deliver({ type: "pair_error", code: "pairing_in_use", reason: "in_use" });
    expect(await failureOf(pairing)).toBe("in_use");
    const before = peer.sent.length;
    vi.advanceTimersByTime(60_000);
    expect(peer.sent).toHaveLength(before);
  });
});

describe("pairAppDevice completion", () => {
  async function completeWith(done: Record<string, unknown>) {
    const peer = createPeer();
    const pairing = start(peer);
    peer.open();
    const helloSent = peer.sent[0]!;
    const daemon = createPairingEphemeral();
    await peer.deliver({
      type: "pair_challenge",
      pk,
      nonce_host: pairingBase64Url(new Uint8Array(32).fill(7)),
      pk_host: daemon.publicKey,
    });
    await vi.waitFor(() => expect(peer.sent.at(-1)).toMatchObject({ type: "pair_confirm" }));
    expect(helloSent).toMatchObject({ type: "pair_hello" });
    await peer.deliver(done);
    return pairing;
  }

  it("reports a renewed pairing when the host already had this device's key", async () => {
    await expect(
      completeWith({ type: "pair_done", deviceId: "dev-1", repaired: true }),
    ).resolves.toEqual({ repaired: true });
  });

  it("reports a first pairing when the host sends no repaired flag", async () => {
    await expect(completeWith({ type: "pair_done", deviceId: "dev-2" })).resolves.toEqual({
      repaired: false,
    });
  });
});
