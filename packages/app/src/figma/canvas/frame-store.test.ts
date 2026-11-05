import { describe, expect, it, vi } from "vitest";
import type { FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { FrameStore, getFrameStore, dropFrameStores, type FetchNodeSubtrees } from "./frame-store";
import { makeNode } from "./__fixtures__/figma";

function recordingFetcher() {
  const calls: string[][] = [];
  const fetchNodes: FetchNodeSubtrees = vi.fn(async (ids) => {
    calls.push([...ids]);
    const out: Record<string, FigmaNode | null> = {};
    for (const id of ids) out[id] = id === "missing" ? null : makeNode({ id });
    return out;
  });
  return { calls, fetchNodes };
}

describe("FrameStore lazy batching", () => {
  it("coalesces load calls made in the same tick into one request", async () => {
    const { calls, fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes, 100, 50);
    void store.load(["1:1"]);
    void store.load(["1:2"]);
    void store.load(["1:3"]);
    await store.load(["1:1", "1:2", "1:3"]);
    expect(calls).toEqual([["1:1", "1:2", "1:3"]]);
  });

  it("never asks for more than 50 ids per request", async () => {
    const { calls, fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes, 1000, 50);
    const ids = Array.from({ length: 120 }, (_, index) => `1:${index}`);
    await store.load(ids);
    expect(calls.map((batch) => batch.length)).toEqual([50, 50, 20]);
    for (const batch of calls) expect(batch.length).toBeLessThanOrEqual(50);
    expect(store.loadedCount()).toBe(120);
  });

  it("does not re-fetch what is already cached, and caches confirmed misses", async () => {
    const { calls, fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes);
    await store.load(["1:1", "missing"]);
    expect(store.get("1:1")?.id).toBe("1:1");
    expect(store.get("missing")).toBeNull();
    await store.load(["1:1", "missing", "never"]);
    expect(calls).toEqual([["1:1", "missing"], ["never"]]);
  });

  it("deduplicates concurrent loads of the same id", async () => {
    let resolveFirst: (nodes: Record<string, FigmaNode | null>) => void = () => {};
    const fetchNodes = vi.fn(
      () =>
        new Promise<Record<string, FigmaNode | null>>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const store = new FrameStore(fetchNodes);
    void store.load(["1:1"]);
    expect(store.isPending("1:1")).toBe(true);
    void store.load(["1:1", "1:2"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(1));
    resolveFirst({ "1:1": makeNode({ id: "1:1" }), "1:2": makeNode({ id: "1:2" }) });
    await vi.waitFor(() => expect(store.isPending("1:1")).toBe(false));
    expect(fetchNodes).toHaveBeenCalledTimes(1);
  });

  it("retries ids whose batch failed instead of caching them as missing", async () => {
    let attempt = 0;
    const fetchNodes = vi.fn(async (ids: readonly string[]) => {
      attempt += 1;
      if (attempt === 1) throw new Error("rate limited");
      const out: Record<string, FigmaNode | null> = {};
      for (const id of ids) out[id] = makeNode({ id });
      return out;
    });
    const store = new FrameStore(fetchNodes);
    await store.load(["1:1"]);
    expect(store.get("1:1")).toBeUndefined();
    await store.load(["1:1"]);
    expect(store.get("1:1")?.id).toBe("1:1");
    expect(fetchNodes).toHaveBeenCalledTimes(2);
  });

  it("does not starve the microtask queue while a fetch is in flight", async () => {
    // The fetcher never resolves, so the batch stays in flight while the canvas paint loop
    // keeps calling load() for the same visible ids. Before the fix every one of those calls
    // scheduled a flush that found an empty queue and rescheduled itself forever: the microtask
    // queue never drained, the main thread never yielded, and the page froze.
    const fetchNodes = vi.fn(() => new Promise<Record<string, FigmaNode | null>>(() => {}));
    const store = new FrameStore(fetchNodes);

    const scheduled: Array<() => void> = [];
    const queueSpy = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((cb) => {
      scheduled.push(cb);
    });
    let flushRuns = 0;
    const drain = () => {
      // A self-rescheduling flush never empties the queue, so bound the loop: hitting the cap
      // is itself the freeze.
      for (let iterations = 0; scheduled.length > 0 && iterations < 1_000; iterations++) {
        const task = scheduled.shift()!;
        flushRuns += 1;
        task();
      }
    };

    try {
      void store.load(["1:1"]);
      drain();
      expect(flushRuns).toBe(1);
      expect(fetchNodes).toHaveBeenCalledTimes(1);

      for (let frame = 0; frame < 60; frame++) {
        void store.load(["1:1"]);
        drain();
      }
      expect(flushRuns).toBeLessThanOrEqual(5);
      expect(scheduled).toHaveLength(0);
      expect(store.isPending("1:1")).toBe(true);

      // A genuinely new id still schedules work while another batch is in flight.
      void store.load(["1:2"]);
      drain();
      expect(fetchNodes).toHaveBeenCalledTimes(2);
      expect(fetchNodes).toHaveBeenLastCalledWith(["1:2"]);
    } finally {
      queueSpy.mockRestore();
    }
  });

  it("notifies subscribers when batches land and stop after unsubscribe", async () => {
    const { fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    await store.load(["1:1"]);
    expect(listener).toHaveBeenCalled();
    listener.mockClear();
    unsubscribe();
    await store.load(["1:2"]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("drops everything on invalidate and refetches lazily after", async () => {
    const { calls, fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes);
    await store.load(["1:1"]);
    store.invalidate();
    expect(store.get("1:1")).toBeUndefined();
    expect(store.loadedIds()).toEqual([]);
    await store.load(["1:1"]);
    expect(calls).toEqual([["1:1"], ["1:1"]]);
  });
});

describe("store registry", () => {
  it("shares one store per (scope, file, version) and separates versions", () => {
    const { fetchNodes } = recordingFetcher();
    const a = getFrameStore("s1", "file", undefined, fetchNodes);
    const same = getFrameStore("s1", "file", undefined, fetchNodes);
    const snapshot = getFrameStore("s1", "file", "7", fetchNodes);
    const otherScope = getFrameStore("s2", "file", undefined, fetchNodes);
    expect(a).toBe(same);
    expect(snapshot).not.toBe(a);
    expect(otherScope).not.toBe(a);
    dropFrameStores("s1", "file");
    expect(getFrameStore("s1", "file", undefined, fetchNodes)).not.toBe(a);
    expect(getFrameStore("s2", "file", undefined, fetchNodes)).toBe(otherScope);
  });

  it("drops every scope for a file with the wildcard", () => {
    const { fetchNodes } = recordingFetcher();
    const first = getFrameStore("x1", "fileA", undefined, fetchNodes);
    const second = getFrameStore("x2", "fileA", "3", fetchNodes);
    const untouched = getFrameStore("x1", "fileB", undefined, fetchNodes);
    dropFrameStores("*", "fileA");
    expect(getFrameStore("x1", "fileA", undefined, fetchNodes)).not.toBe(first);
    expect(getFrameStore("x2", "fileA", "3", fetchNodes)).not.toBe(second);
    expect(getFrameStore("x1", "fileB", undefined, fetchNodes)).toBe(untouched);
  });
});
