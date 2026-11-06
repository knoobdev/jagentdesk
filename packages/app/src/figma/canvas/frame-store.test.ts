import { describe, expect, it, vi } from "vitest";
import type { FigmaComponentMeta, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  FrameStore,
  getFrameStore,
  dropFrameStores,
  frameStoreRegistrySize,
  MAX_STORE_REGISTRY_SIZE,
  type FetchNodeSubtrees,
  type NodeBatch,
} from "./frame-store";
import { makeNode } from "./__fixtures__/figma";

function recordingFetcher() {
  const calls: string[][] = [];
  const fetchNodes: FetchNodeSubtrees = vi.fn(async (ids) => {
    calls.push([...ids]);
    const nodes: Record<string, FigmaNode | null> = {};
    const components: Record<string, FigmaComponentMeta> = {};
    for (const id of ids) {
      nodes[id] = id === "missing" ? null : makeNode({ id });
      if (!nodes[id]) continue;
      components[id] = {
        key: `k-${id}`,
        name: `Component ${id}`,
        // "1:2" keeps the field absent, the rest report local components.
        ...(id === "1:2" ? {} : { remote: false }),
      };
    }
    return { nodes, components };
  });
  return { calls, fetchNodes };
}

/** Flush the microtask queue long enough for awaiting fetch continuations to settle. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
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
    let resolveFirst: (batch: NodeBatch) => void = () => {};
    const fetchNodes = vi.fn(
      () =>
        new Promise<NodeBatch>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const store = new FrameStore(fetchNodes);
    void store.load(["1:1"]);
    expect(store.isPending("1:1")).toBe(true);
    void store.load(["1:1", "1:2"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(1));
    resolveFirst({
      nodes: { "1:1": makeNode({ id: "1:1" }), "1:2": makeNode({ id: "1:2" }) },
      components: {},
    });
    await vi.waitFor(() => expect(store.isPending("1:1")).toBe(false));
    expect(fetchNodes).toHaveBeenCalledTimes(1);
  });

  it("retries ids whose batch failed instead of caching them as missing", async () => {
    let attempt = 0;
    const fetchNodes = vi.fn(async (ids: readonly string[]) => {
      attempt += 1;
      if (attempt === 1) throw new Error("rate limited");
      const nodes: Record<string, FigmaNode | null> = {};
      for (const id of ids) nodes[id] = makeNode({ id });
      return { nodes, components: {} };
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
    const fetchNodes = vi.fn(() => new Promise<NodeBatch>(() => {}));
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

  it("captures component metadata from loaded batches, absent remote included", async () => {
    const { fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes);
    expect(store.componentMeta("1:1")).toBeUndefined();
    await store.load(["1:1", "1:2"]);
    expect(store.componentMeta("1:1")).toEqual({
      key: "k-1:1",
      name: "Component 1:1",
      remote: false,
    });
    expect(store.componentMeta("1:2")).toEqual({ key: "k-1:2", name: "Component 1:2" });
    store.invalidate();
    expect(store.componentMeta("1:1")).toBeUndefined();
  });

  it("caps component metadata at the store capacity, oldest first", async () => {
    const { fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes, 2, 50);
    await store.load(["1:1", "1:2", "1:3"]);
    // Regression: metadata was an unbounded Map, so a component-heavy file kept every meta
    // ever seen while the subtree cache itself was LRU-capped.
    expect(store.componentMeta("1:1")).toBeUndefined();
    expect(store.componentMeta("1:2")).toEqual({ key: "k-1:2", name: "Component 1:2" });
    expect(store.componentMeta("1:3")).toEqual({
      key: "k-1:3",
      name: "Component 1:3",
      remote: false,
    });
  });

  it("discards an in-flight batch that crosses invalidate() and re-fetches after", async () => {
    // Regression: invalidate() cleared `inflight`, but a response already awaiting the fetcher
    // still landed in the fresh cache, so the "next load re-fetches" promise silently kept
    // serving pre-invalidation data.
    const releases: Array<(batch: NodeBatch) => void> = [];
    const fetchNodes = vi.fn(
      () =>
        new Promise<NodeBatch>((resolve) => {
          releases.push(resolve);
        }),
    );
    const store = new FrameStore(fetchNodes);
    const settled = store.load(["1:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(1));
    store.invalidate();
    releases[0]!({
      nodes: { "1:1": makeNode({ id: "1:1", name: "stale" }) },
      components: { "1:1": { key: "k-stale", name: "Stale" } },
    });
    await settled;
    expect(store.get("1:1")).toBeUndefined();
    expect(store.componentMeta("1:1")).toBeUndefined();

    void store.load(["1:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(2));
    releases[1]!({
      nodes: { "1:1": makeNode({ id: "1:1", name: "fresh" }) },
      components: {},
    });
    await vi.waitFor(() => expect(store.get("1:1")?.name).toBe("fresh"));
  });

  it("keeps the new generation's in-flight ids when a dead batch rejects late", async () => {
    // Regression: the catch branch deleted the batch's ids from `inflight` unconditionally, so a
    // rejection surfacing after invalidate() + a fresh load of the same ids cleared the NEW
    // flush's in-flight marks — isPending lied and the wrong waiter could settle.
    const settles: Array<{
      resolve: (batch: NodeBatch) => void;
      reject: (error: Error) => void;
    }> = [];
    const fetchNodes = vi.fn(
      () =>
        new Promise<NodeBatch>((resolve, reject) => {
          settles.push({ resolve, reject });
        }),
    );
    const store = new FrameStore(fetchNodes);
    void store.load(["1:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(1));
    store.invalidate();
    void store.load(["1:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(2));
    expect(store.isPending("1:1")).toBe(true);

    settles[0]!.reject(new Error("dead generation"));
    await drainMicrotasks();
    expect(store.isPending("1:1")).toBe(true); // the live batch still owns the id

    settles[1]!.resolve({
      nodes: { "1:1": makeNode({ id: "1:1", name: "fresh" }) },
      components: {},
    });
    await vi.waitFor(() => expect(store.get("1:1")?.name).toBe("fresh"));
    expect(store.isPending("1:1")).toBe(false);
  });

  it("settles load() waiters when invalidate() drops the only in-flight batch", async () => {
    // The fetcher never resolves: after invalidate() no running request can ever finish, so the
    // waiter must settle from invalidate() itself instead of hanging.
    const fetchNodes = vi.fn(() => new Promise<NodeBatch>(() => {}));
    const store = new FrameStore(fetchNodes);
    const settled = store.load(["1:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(1));
    store.invalidate();
    let resolved = false;
    void settled.then(
      () => (resolved = true),
      () => (resolved = false),
    );
    await drainMicrotasks();
    expect(resolved).toBe(true);
  });

  it("notifies on a capacity replacement that keeps loadedCount equal", async () => {
    const { fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes, 2, 50);
    await store.load(["1:1", "1:2"]);
    const listener = vi.fn();
    store.subscribe(listener);
    const revisionBefore = store.revisionSnapshot();
    expect(store.loadedCount()).toBe(2);

    await store.load(["1:3"]); // evicts 1:1, count stays 2
    expect(store.loadedCount()).toBe(2);
    expect(store.revisionSnapshot()).toBeGreaterThan(revisionBefore);
    expect(listener).toHaveBeenCalled();
    expect(store.get("1:1")).toBeUndefined();
    expect(store.get("1:3")?.id).toBe("1:3");
  });

  it("leaves a batch fetched entirely after invalidate() alone in charge of its results", async () => {
    const { calls, fetchNodes } = recordingFetcher();
    const store = new FrameStore(fetchNodes);
    store.invalidate();
    await store.load(["1:1"]);
    expect(calls).toEqual([["1:1"]]);
    expect(store.get("1:1")?.id).toBe("1:1");
  });
});

describe("FrameStore.parentOf", () => {
  async function loadedStore() {
    const leaf = makeNode({ id: "1:61", name: "Sign in" });
    const group = makeNode({ id: "1:60", name: "Form", children: [leaf] });
    const frame = makeNode({ id: "1:1", name: "Home", children: [group] });
    const fetchNodes: FetchNodeSubtrees = vi.fn(async () => ({
      nodes: { "1:1": frame },
      components: {},
    }));
    const store = new FrameStore(fetchNodes);
    await store.load(["1:1"]);
    return store;
  }

  it("returns the direct parent found inside a loaded subtree", async () => {
    const store = await loadedStore();
    expect(store.parentOf("1:61")?.id).toBe("1:60");
    expect(store.parentOf("1:60")?.id).toBe("1:1");
  });

  it("returns null for a cached top-level frame and undefined when nothing contains the id", async () => {
    const store = await loadedStore();
    expect(store.parentOf("1:1")).toBeNull();
    expect(store.parentOf("9:9")).toBeUndefined();
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

  it("rebinds the fetch path when a shared store is requested with a newer fetcher", async () => {
    // Regression: the registry reused the store with the fetcher captured at creation, so after
    // a host reconnect every subtree request went to the dead client until the next file change.
    const callsA: string[][] = [];
    const fetcherA = vi.fn(async (ids: readonly string[]) => {
      callsA.push([...ids]);
      return { nodes: { [ids[0] as string]: makeNode({ id: ids[0] as string }) }, components: {} };
    });
    const callsB: string[][] = [];
    const fetcherB = vi.fn(async (ids: readonly string[]) => {
      callsB.push([...ids]);
      return { nodes: { [ids[0] as string]: makeNode({ id: ids[0] as string }) }, components: {} };
    });
    const store = getFrameStore("rebind", "file", undefined, fetcherA);
    const same = getFrameStore("rebind", "file", undefined, fetcherB);
    expect(same).toBe(store);
    void same.load(["1:1"]);
    await vi.waitFor(() => expect(fetcherB).toHaveBeenCalledTimes(1));
    expect(fetcherA).not.toHaveBeenCalled();
    expect(callsB).toEqual([["1:1"]]);
  });

  it("evicts the least recently used stores past the registry cap", () => {
    const { fetchNodes } = recordingFetcher();
    const created: FrameStore[] = [];
    for (let i = 0; i < MAX_STORE_REGISTRY_SIZE + 3; i += 1) {
      created.push(getFrameStore(`cap${i}`, "capfile", undefined, fetchNodes));
    }
    expect(frameStoreRegistrySize()).toBe(MAX_STORE_REGISTRY_SIZE);
    // The newest survive; the evicted oldest ones come back as fresh stores on demand.
    const newest = created[created.length - 1] as FrameStore;
    expect(
      getFrameStore(`cap${MAX_STORE_REGISTRY_SIZE + 2}`, "capfile", undefined, fetchNodes),
    ).toBe(newest);
    const oldest = created[0] as FrameStore;
    expect(getFrameStore("cap0", "capfile", undefined, fetchNodes)).not.toBe(oldest);
  });

  it("releases cached subtrees when a store is evicted from the registry", async () => {
    // Regression: unlinking the entry left a full LRU cache on the orphan store — bounded
    // count, but every evicted store kept its complete multi-frame subtree retention alive.
    const { fetchNodes } = recordingFetcher();
    const evicted = getFrameStore("evict-me", "evictfile", undefined, fetchNodes);
    await evicted.load(["1:1"]);
    expect(evicted.get("1:1")?.id).toBe("1:1");
    for (let i = 0; i < MAX_STORE_REGISTRY_SIZE; i += 1) {
      getFrameStore(`post${i}`, `postfile${i}`, undefined, fetchNodes);
    }
    expect(frameStoreRegistrySize()).toBe(MAX_STORE_REGISTRY_SIZE);
    expect(evicted.loadedCount()).toBe(0);
    expect(evicted.loadedIds()).toEqual([]);
    expect(getFrameStore("evict-me", "evictfile", undefined, fetchNodes)).not.toBe(evicted);
  });

  it("keeps a reused store inside the registry by refreshing its recency", () => {
    const { fetchNodes } = recordingFetcher();
    const survivor = getFrameStore("hot", "capfile", undefined, fetchNodes);
    for (let i = 0; i < MAX_STORE_REGISTRY_SIZE; i += 1) {
      getFrameStore(`fill${i}`, `fillfile${i}`, undefined, fetchNodes);
      // Each round re-touches the survivor, so it never becomes the oldest entry.
      expect(getFrameStore("hot", "capfile", undefined, fetchNodes)).toBe(survivor);
    }
    expect(frameStoreRegistrySize()).toBe(MAX_STORE_REGISTRY_SIZE);
  });

  it("cannot let a late response repopulate a store dropped mid-flight", async () => {
    // Regression: dropFrameStores only unlinked the entry, so a batch still awaiting the fetcher
    // landed in the obsolete store's cache afterwards and the instance looked freshly loaded.
    const releases: Array<(batch: NodeBatch) => void> = [];
    const fetchNodes = vi.fn(
      () =>
        new Promise<NodeBatch>((resolve) => {
          releases.push(resolve);
        }),
    );
    const store = getFrameStore("dropped", "latefile", undefined, fetchNodes);
    const waiter = store.load(["1:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(1));
    dropFrameStores("dropped", "latefile");
    await waiter; // invalidate-on-drop settles the waiter instead of hanging on the dead batch
    releases[0]!({ nodes: { "1:1": makeNode({ id: "1:1" }) }, components: {} });
    await drainMicrotasks();
    expect(store.get("1:1")).toBeUndefined(); // the dead-generation response was discarded

    void store.load(["1:1"]); // a post-drop load on the still-mounted instance re-fetches
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(2));
    releases[1]!({ nodes: { "1:1": makeNode({ id: "1:1", name: "again" }) }, components: {} });
    await vi.waitFor(() => expect(store.get("1:1")?.name).toBe("again"));
  });
});

describe("FrameStore shallow SECTION queue (ADR-0039)", () => {
  function shallowFetcher(childrenOf: (id: string) => FigmaNode[] = () => []) {
    const calls: Array<{ ids: string[]; options?: { depth?: number } }> = [];
    const fetchNodes = vi.fn(async (ids: readonly string[], options?: { depth?: number }) => {
      calls.push({ ids: [...ids], ...(options ? { options } : {}) });
      const nodes: Record<string, FigmaNode | null> = {};
      for (const id of ids) nodes[id] = makeNode({ id, type: "SECTION", children: childrenOf(id) });
      return { nodes, components: { [ids[0] as string]: { key: "k", name: "C" } } };
    });
    return { calls, fetchNodes };
  }

  it("requests depth: 1 through the fetcher while full subtrees ask with no options", async () => {
    const { calls, fetchNodes } = shallowFetcher();
    const store = new FrameStore(fetchNodes);
    await store.loadSections(["10:1"]);
    await store.load(["1:1"]);
    expect(calls).toEqual([
      { ids: ["10:1"], options: { depth: 1 } },
      { ids: ["1:1"] }, // the subtree path must keep its exact old shape
    ]);
  });

  it("keeps the two caches separate: a shallow payload never satisfies get(), and vice versa", async () => {
    const { fetchNodes } = shallowFetcher();
    const store = new FrameStore(fetchNodes);
    await store.loadSections(["10:1"]);
    expect(store.sectionNode("10:1")?.type).toBe("SECTION");
    expect(store.get("10:1")).toBeUndefined(); // criterion 17: never paint a fragment as a tree

    await store.load(["1:1"]);
    expect(store.get("1:1")?.id).toBe("1:1");
    expect(store.sectionNode("1:1")).toBeUndefined();
  });

  it("does not populate component metadata from shallow batches", async () => {
    const { fetchNodes } = shallowFetcher();
    const store = new FrameStore(fetchNodes);
    await store.loadSections(["10:1"]);
    expect(store.componentMeta("10:1")).toBeUndefined(); // keepsComponents: false
    await store.load(["10:1"]);
    expect(store.componentMeta("10:1")).toEqual({ key: "k", name: "C" });
  });

  it("dedupes pending and cached section ids across load() storm passes", async () => {
    const { calls, fetchNodes } = shallowFetcher();
    const store = new FrameStore(fetchNodes);
    const first = store.loadSections(["10:1"]);
    void store.loadSections(["10:1"]);
    await drainMicrotasks();
    void store.loadSections(["10:1"]); // already cached → no third call
    await first;
    expect(calls.map((c) => c.ids)).toEqual([["10:1"]]);
  });

  it("bounds the section cache on its own capacity and reports its ids", async () => {
    const { fetchNodes } = shallowFetcher();
    const store = new FrameStore(fetchNodes, 2, 50);
    await store.loadSections(["10:1", "10:2", "10:3"]); // evicts 10:1
    expect(store.sectionLoadedIds()).toEqual(["10:2", "10:3"]);
    expect(store.sectionNode("10:1")).toBeUndefined();
    // A full-subtree cache hit must not count as a section hit: capacity is per queue.
    await store.load(["10:1"]);
    expect(store.loadedIds()).toEqual(["10:1"]);
    expect(store.sectionNode("10:1")).toBeUndefined();
  });

  it("discards a late shallow success from a dead generation", async () => {
    const releases: Array<(batch: NodeBatch) => void> = [];
    const fetchNodes = vi.fn(
      () =>
        new Promise<NodeBatch>((resolve) => {
          releases.push(resolve);
        }),
    );
    const store = new FrameStore(fetchNodes);
    const settled = store.loadSections(["10:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(1));
    store.invalidate();
    releases[0]!({
      nodes: { "10:1": makeNode({ id: "10:1", type: "SECTION", name: "stale" }) },
      components: {},
    });
    await settled;
    expect(store.sectionNode("10:1")).toBeUndefined();

    void store.loadSections(["10:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(2));
    releases[1]!({
      nodes: { "10:1": makeNode({ id: "10:1", type: "SECTION", name: "fresh" }) },
      components: {},
    });
    await vi.waitFor(() => expect(store.sectionNode("10:1")?.name).toBe("fresh"));
  });

  it("lets a failed shallow fetch retry on the next exposure", async () => {
    let fail = true;
    const fetchNodes = vi.fn(async (ids: readonly string[]) => {
      if (fail) throw new Error("rate limited");
      return {
        nodes: { [ids[0] as string]: makeNode({ id: ids[0] as string, type: "SECTION" }) },
        components: {},
      };
    });
    const store = new FrameStore(fetchNodes);
    await store.loadSections(["10:1"]);
    expect(store.sectionNode("10:1")).toBeUndefined();
    expect(store.isSectionPending("10:1")).toBe(false); // not stuck pending forever
    fail = false;
    await store.loadSections(["10:1"]);
    expect(store.sectionNode("10:1")?.type).toBe("SECTION");
    expect(fetchNodes).toHaveBeenCalledTimes(2);
  });

  it("settles loadSections() waiters when invalidate() drops the only in-flight batch", async () => {
    const fetchNodes = vi.fn(() => new Promise<NodeBatch>(() => {}));
    const store = new FrameStore(fetchNodes);
    const settled = store.loadSections(["10:1"]);
    await vi.waitFor(() => expect(fetchNodes).toHaveBeenCalledTimes(1));
    expect(store.isSectionPending("10:1")).toBe(true);
    store.invalidate();
    let resolved = false;
    void settled.then(
      () => (resolved = true),
      () => (resolved = false),
    );
    await drainMicrotasks();
    expect(resolved).toBe(true);
    expect(store.isSectionPending("10:1")).toBe(false);
  });

  it("keeps isPending and isSectionPending independent ledgers", async () => {
    const fetchNodes = vi.fn(() => new Promise<NodeBatch>(() => {})); // never settles
    const store = new FrameStore(fetchNodes);
    void store.load(["1:1"]);
    void store.loadSections(["10:1"]);
    await drainMicrotasks();
    expect(store.isPending("1:1")).toBe(true);
    expect(store.isSectionPending("1:1")).toBe(false);
    expect(store.isSectionPending("10:1")).toBe(true);
    expect(store.isPending("10:1")).toBe(false);
  });
});
