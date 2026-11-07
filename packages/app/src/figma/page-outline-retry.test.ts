import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFigmaHost, type FigmaHostRetryPort } from "./page-outline-retry";
afterEach(() => vi.useRealTimers());
function connection() {
  let online = false;
  const listeners = new Set<() => void>();
  const probes: string[] = [];
  const resets: string[] = [];
  const runtime: FigmaHostRetryPort = {
    getSnapshot: () => ({ client: { isConnected: online } }),
    subscribe: (_serverId, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    resetLocalRetries: (id) => {
      resets.push(id);
    },
    runProbeCycleNow: async (id) => {
      probes.push(id);
    },
  };
  return {
    runtime,
    probes,
    resets,
    listeners,
    connect: () => {
      online = true;
      for (const listener of listeners) listener();
    },
  };
}
describe("page Retry connection readiness", () => {
  it("waits beyond a no-op probe and observes the replacement connection before reading", async () => {
    const host = connection();
    let done = false;
    const result = waitForFigmaHost(host.runtime, "srv_a1b2c3", new AbortController().signal).then(
      () => {
        done = true;
        return undefined;
      },
    );
    await Promise.resolve();
    expect(done).toBe(false);
    expect(host.probes).toEqual(["srv_a1b2c3"]);
    expect(host.resets).toEqual(["srv_a1b2c3"]);
    host.connect();
    await result;
    expect(done).toBe(true);
    expect(host.listeners.size).toBe(0);
  });
  it("does not reconnect a healthy host", async () => {
    const host = connection();
    host.connect();
    await waitForFigmaHost(host.runtime, "srv_a1b2c3", new AbortController().signal);
    expect(host.probes).toEqual([]);
  });
  it("cancels and releases the listener when the file or page changes", async () => {
    const host = connection();
    const abort = new AbortController();
    const result = waitForFigmaHost(host.runtime, "srv_a1b2c3", abort.signal);
    const assertion = expect(result).rejects.toThrow("Page retry cancelled");
    abort.abort();
    await assertion;
    expect(host.listeners.size).toBe(0);
  });
  it("ends an offline wait with an actionable error", async () => {
    vi.useFakeTimers();
    const host = connection();
    const result = waitForFigmaHost(host.runtime, "srv_a1b2c3", new AbortController().signal);
    const assertion = expect(result).rejects.toThrow("The host is still offline");
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    expect(host.listeners.size).toBe(0);
  });
});
