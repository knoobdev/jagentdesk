/**
 * @vitest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateFigmaFile, useFigmaFrameStore, useFrameLoader } from "./use-figma-file";

const { clients } = vi.hoisted(() => ({
  clients: { current: null as unknown },
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => clients.current,
  getHostRuntimeStore: () => ({ getSnapshot: () => null }),
}));

interface FakeClient {
  figmaRequest: ReturnType<typeof vi.fn>;
  generation: number;
}

function makeClient(generation: number): FakeClient {
  return {
    generation,
    figmaRequest: vi.fn(async (method: string, payload: { ids?: string[] }) => {
      expect(method).toBe("figma.file.nodes.request");
      const nodes: Record<string, unknown> = {};
      for (const id of payload.ids ?? []) {
        nodes[id] = { id, name: `node-gen-${generation}`, type: "FRAME" };
      }
      return { nodes, components: {} };
    }),
  };
}

const FILE = "f1234567890abcdef";

beforeEach(() => {
  clients.current = makeClient(1);
});

describe("useFigmaFrameStore lifetime", () => {
  it("keeps one store across re-renders and rotates to a fresh store per reload token", () => {
    const { result, rerender } = renderHook(
      ({ token }: { token: number }) => useFigmaFrameStore("srv", FILE, null, token),
      { initialProps: { token: 0 } },
    );
    const first = result.current;
    expect(first).not.toBeNull();
    rerender({ token: 0 });
    expect(result.current).toBe(first); // remount-free re-renders must not drop loaded subtrees
    rerender({ token: 1 });
    expect(result.current).not.toBe(first);
    expect(result.current).not.toBeNull();
  });

  it("rebinds a reused store to the current client after a reconnect", async () => {
    const stale = makeClient(1);
    const revived = makeClient(2);
    clients.current = stale;
    const { result, rerender } = renderHook(() => useFigmaFrameStore("srv", FILE, null, 0));
    const store = result.current as ReturnType<typeof useFigmaFrameStore>;
    rerender();
    expect(result.current).toBe(store); // same scope → same cache

    clients.current = revived;
    rerender();
    await act(async () => {
      await store!.load(["1:1"]);
    });
    expect(revived.figmaRequest).toHaveBeenCalledTimes(1);
    expect(stale.figmaRequest).not.toHaveBeenCalled();
    expect(store!.get("1:1")).toMatchObject({ name: "node-gen-2" });
  });

  it("invalidateFigmaFile drops every scope so the next load re-fetches through a new store", async () => {
    const client = clients.current as FakeClient;
    const { result, rerender } = renderHook(() => useFigmaFrameStore("srv", FILE, "7", 0));
    const store = result.current as ReturnType<typeof useFigmaFrameStore>;
    await act(async () => {
      await store!.load(["1:1"]);
    });
    expect(client.figmaRequest).toHaveBeenCalledTimes(1);

    invalidateFigmaFile("srv", FILE);
    rerender();
    expect(result.current).toBe(store); // the mounted screen keeps its instance until remount

    const replacement = renderHook(() => useFigmaFrameStore("srv", FILE, "7", 0)).result
      .current as ReturnType<typeof useFigmaFrameStore>;
    expect(replacement).not.toBe(store);
    expect(replacement!.get("1:1")).toBeUndefined();
    await act(async () => {
      await replacement!.load(["1:1"]);
    });
    expect(client.figmaRequest).toHaveBeenCalledTimes(2);
  });

  it("keeps snapshot versions separated from the live store for the same file", () => {
    const live = renderHook(() => useFigmaFrameStore("srv", FILE, null, 0)).result.current;
    const snapshot = renderHook(() => useFigmaFrameStore("srv", FILE, "7", 0)).result.current;
    expect(live).not.toBeNull();
    expect(snapshot).not.toBe(live);
  });
});

describe("useFrameLoader", () => {
  it("kicks loading for the requested ids and re-subscribes without churn on re-render", async () => {
    const client = clients.current as FakeClient;
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => {
        const store = useFigmaFrameStore("srv", FILE, null, 42);
        useFrameLoader(store, ids);
        return store;
      },
      { initialProps: { ids: ["1:1", "1:2"] } },
    );
    await waitFor(() =>
      expect(client.figmaRequest).toHaveBeenCalledWith(
        "figma.file.nodes.request",
        expect.objectContaining({ ids: ["1:1", "1:2"] }),
      ),
    );
    rerender({ ids: ["1:1", "1:2"] });
    rerender({ ids: ["1:1", "1:2"] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.figmaRequest).toHaveBeenCalledTimes(1); // cached ids must not re-request
    expect(result.current!.get("1:1")).toMatchObject({ id: "1:1" });
  });

  it("loads newly visible ids without re-requesting the cached ones", async () => {
    const client = makeClient(9);
    clients.current = client;
    const { rerender } = renderHook(
      ({ ids }: { ids: string[] }) => {
        const store = useFigmaFrameStore("srv", `${FILE}-queue`, null, 43);
        useFrameLoader(store, ids);
        return store;
      },
      { initialProps: { ids: ["1:1"] } },
    );
    await waitFor(() => expect(client.figmaRequest).toHaveBeenCalledTimes(1));
    rerender({ ids: ["1:1", "1:2"] });
    await waitFor(() => expect(client.figmaRequest).toHaveBeenCalledTimes(2));
    expect(client.figmaRequest).toHaveBeenLastCalledWith(
      "figma.file.nodes.request",
      expect.objectContaining({ ids: ["1:2"] }),
    );
  });

  it("re-renders on a capacity replacement that keeps loadedCount equal", async () => {
    // Regression: the external-store snapshot was loadedCount(). A thousand-frame file evicts
    // subtrees past the 300 LRU capacity, so loading a fresh viewport could swap every entry
    // while the count stayed 300 — React saw no change and the canvas never repainted.
    const client = makeClient(7);
    clients.current = client;
    let renderCount = 0;
    const firstIds = Array.from({ length: 300 }, (_, index) => `1:${index}`);
    const secondIds = Array.from({ length: 300 }, (_, index) => `2:${index}`);
    const { result, rerender } = renderHook(
      ({ ids }: { ids: string[] }) => {
        renderCount += 1;
        const store = useFigmaFrameStore("srv", `${FILE}-replace`, null, 44);
        useFrameLoader(store, ids);
        return store;
      },
      { initialProps: { ids: firstIds } },
    );
    await waitFor(() => expect(result.current!.get("1:299")).toBeDefined());
    expect(result.current!.loadedCount()).toBe(300);

    rerender({ ids: secondIds });
    const baseline = renderCount; // the props re-render itself must not count
    await waitFor(() => expect(result.current!.get("2:299")).toBeDefined());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current!.loadedCount()).toBe(300); // count never changed…
    expect(result.current!.get("1:0")).toBeUndefined(); // …but the content fully turned over
    expect(renderCount).toBeGreaterThan(baseline); // and subscribers saw it
  });
});
