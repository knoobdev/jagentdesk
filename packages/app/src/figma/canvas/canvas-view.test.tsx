/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaFrameSummary, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";
import { makeFrameSummary, makeNode } from "./__fixtures__/figma";
import { CanvasView, MAX_RASTER_TILES, NativeCanvasLayer, pruneRasterCache } from "./canvas-view";
import { FrameStore } from "./frame-store";
import type { SectionAwareSummary } from "./section-outline";
import { type Camera, cameraToFit, framesBoundingRect, framesInViewport } from "./viewport";

// The app's tsconfig compiles JSX classic (expo `jsx: "react-native"`), so component modules
// under test reference a module-global React. Setup does not define it; the heavier import
// chains of sibling tests pull in a module that does.
const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
globalWithReact.React ??= React;

const { theme, hosts, assets, viewLayout } = vi.hoisted(() => ({
  theme: {
    fontSize: { xs: 11 },
    colors: { foregroundMuted: "#888" },
  },
  // Mutable per-serverId client registry: tests can register, unregister (offline), or swap
  // hosts exactly like the runtime store does.
  hosts: { current: {} as Record<string, { id: string } | null> },
  // Records what the paint path asks the asset caches for, so "no flood" is assertable.
  assets: { thumbnail: [] as string[] },
  // The host View reports this layout once on mount, giving the viewer a viewport to cull.
  viewLayout: { current: { width: 800, height: 600 } },
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    testID,
    style,
    onLayout,
  }: Record<string, unknown> & { onLayout?: (event: unknown) => void }) => {
    React.useEffect(() => {
      if (typeof onLayout === "function")
        onLayout({ nativeEvent: { layout: { ...viewLayout.current } } });
      // Mount-once: the viewer's onLayout handler is a stable useCallback.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement("div", { "data-testid": String(testID ?? ""), style }, children);
  },
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Image: ({
    source,
    accessibilityLabel,
  }: {
    source?: { uri?: string };
    accessibilityLabel?: string;
  }) =>
    React.createElement("img", {
      "data-testid": "tile",
      src: source?.uri ?? "",
      alt: accessibilityLabel ?? "",
    }),
  PanResponder: {
    create: () => ({ panHandlers: {} }),
  },
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: "web" },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("@/constants/platform", () => ({ isWeb: false, isNative: true }));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => hosts.current[serverId] ?? null,
  getHostRuntimeStore: () => ({ getSnapshot: () => null }),
}));
vi.mock("@/figma/renderer", () => ({
  createFigmaRenderer: () => ({ draw: vi.fn(), hitTest: vi.fn() }),
}));
vi.mock("./use-figma-assets", () => ({
  useFigmaAssets: () => ({
    subscribe: () => () => undefined,
    requestThumbnail: (id: string) => {
      assets.thumbnail.push(id);
      return null;
    },
    imageForRef: () => null,
    fallbackForNode: () => null,
    fontAvailable: () => false,
    onMissing: () => undefined,
  }),
}));
vi.mock("./api", () => ({
  callFigma: vi.fn(),
}));

import { callFigma } from "./api";

const callFigmaMock = vi.mocked(callFigma);
const CAMERA = { zoom: 1, offsetX: 0, offsetY: 0 };
const noopSelect = (_nodeId: string | null): void => undefined;
const noopCamera = (_next: typeof CAMERA): void => undefined;

/** The daemon answers every render batch with a tile tagged by the serving host and version. */
function serveRenderTiles() {
  callFigmaMock.mockImplementation((async (client, _method, payload) => {
    const host = (client as { id?: string } | null)?.id ?? "?";
    const version = String((payload as { version?: string }).version ?? "live");
    const ids = (payload as { ids: string[] }).ids;
    const images: Record<string, { mimeType: string; dataBase64: string }> = {};
    for (const id of ids)
      images[id] = { mimeType: "image/png", dataBase64: `${host}|${version}:${id}` };
    return { images };
  }) as typeof callFigma);
}

function framesFrom(prefix: string, count: number, step = 200): FigmaFrameSummary[] {
  return Array.from({ length: count }, (_, index) =>
    makeFrameSummary(`${prefix}:${index}`, index * step, 0, 100, 80),
  );
}

function mountLayer(props: Partial<React.ComponentProps<typeof NativeCanvasLayer>> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const visible = props.visible ?? framesFrom("1", 2);
  const view = (
    <NativeCanvasLayer
      serverId="srv"
      fileKey="file"
      version={null}
      visible={visible}
      camera={CAMERA}
      selectedNodeId={null}
      onSelectNode={noopSelect}
      onCamera={noopCamera}
      {...props}
    />
  );
  act(() => root.render(view));
  return {
    container,
    rerenderWith: (next: Partial<React.ComponentProps<typeof NativeCanvasLayer>>) => {
      act(() => root.render(<NativeCanvasLayer {...(view.props as never)} {...next} />));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

function renderedTiles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('img[data-testid="tile"]')).map((node) =>
    node.getAttribute("src"),
  ) as string[];
}

/** Deferred render batches so a test controls exactly when each response lands or fails. */
function deferredRenderBatches() {
  const batches: Array<{
    ids: string[];
    clientId: string;
    resolve: (host: string, version: string) => void;
    reject: (error: Error) => void;
  }> = [];
  callFigmaMock.mockImplementation(((_client, _method, payload) => {
    const ids = [...((payload as { ids: string[] }).ids ?? [])];
    const clientId = (_client as { id?: string } | null)?.id ?? "?";
    return new Promise<{ images: Record<string, { mimeType: string; dataBase64: string }> }>(
      (resolve, reject) => {
        batches.push({
          ids,
          clientId,
          resolve: (host, version) => {
            const images: Record<string, { mimeType: string; dataBase64: string }> = {};
            for (const id of ids)
              images[id] = { mimeType: "image/png", dataBase64: `${host}|${version}:${id}` };
            resolve({ images });
          },
          reject,
        });
      },
    );
  }) as typeof callFigma);
  return batches;
}

beforeEach(() => {
  callFigmaMock.mockReset();
  hosts.current = { srv: { id: "srv" } };
  assets.thumbnail.length = 0;
  serveRenderTiles();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("pruneRasterCache (no retained drawing objects outside the viewport)", () => {
  const cached = Object.fromEntries(["a1", "a2", "a3", "a4", "a5"].map((id) => [id, `data:${id}`]));

  it("returns the cache untouched while it is under the cap", () => {
    const pruned = pruneRasterCache(cached, ["a1"], 8);
    expect(pruned.rasters).toBe(cached);
    expect(pruned.dropped).toEqual([]);
  });

  it("keeps visible tiles and drops hidden tiles oldest-first past the cap", () => {
    const pruned = pruneRasterCache(cached, ["a4"], 3);
    expect(Object.keys(pruned.rasters)).toEqual(["a3", "a4", "a5"]);
    expect(pruned.dropped).toEqual(["a1", "a2"]);
  });

  it("lets visible tiles exceed the cap — never evict what is being painted", () => {
    const pruned = pruneRasterCache(cached, ["a1", "a2", "a3", "a4", "a5"], 1);
    expect(Object.keys(pruned.rasters)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(pruned.dropped).toEqual([]);
  });

  it("keeps insertion order for survivors", () => {
    const pruned = pruneRasterCache(cached, [], 2);
    expect(Object.keys(pruned.rasters)).toEqual(["a4", "a5"]);
    expect(pruned.dropped).toEqual(["a1", "a2", "a3"]);
  });
});

describe("NativeCanvasLayer lazy render requests", () => {
  it("requests each visible frame once and never re-asks for cached tiles", async () => {
    const layer = mountLayer();
    await flush();
    expect(callFigmaMock).toHaveBeenCalledTimes(1);
    expect(callFigmaMock).toHaveBeenCalledWith(
      expect.anything(),
      "figma.file.render.request",
      expect.objectContaining({ fileKey: "file", ids: ["1:0", "1:1"], scale: 2 }),
    );
    expect(
      Array.from(layer.container.querySelectorAll('img[data-testid="tile"]')).map((node) =>
        node.getAttribute("src"),
      ),
    ).toEqual(["data:image/png;base64,srv|live:1:0", "data:image/png;base64,srv|live:1:1"]);

    layer.rerenderWith({ visible: framesFrom("1", 2) });
    await flush();
    expect(callFigmaMock).toHaveBeenCalledTimes(1); // same ids → deduplicated
    layer.unmount();
  });

  it("never asks for more than 20 ids per render request", async () => {
    const layer = mountLayer({ visible: framesFrom("1", 25) });
    await flush();
    expect(
      callFigmaMock.mock.calls.map(([, , payload]) => (payload as { ids: string[] }).ids.length),
    ).toEqual([20, 5]);
    layer.unmount();
  });

  it("swapping the version drops stale tiles and re-requests the same ids for the new version", async () => {
    const visible = framesFrom("1", 2);
    const layer = mountLayer({ visible });
    await flush();
    expect(callFigmaMock).toHaveBeenCalledTimes(1);

    layer.rerenderWith({ visible, version: "7" });
    await flush();
    expect(callFigmaMock).toHaveBeenCalledTimes(2);
    expect(callFigmaMock).toHaveBeenLastCalledWith(
      expect.anything(),
      "figma.file.render.request",
      expect.objectContaining({ ids: ["1:0", "1:1"], version: "7" }),
    );
    await flush();
    // Regression: rasters and the request ledger survived a version swap, so the viewer kept
    // painting the old snapshot's tiles forever without refetching.
    const srcs = Array.from(layer.container.querySelectorAll('img[data-testid="tile"]')).map(
      (node) => node.getAttribute("src"),
    );
    expect(srcs).toEqual(["data:image/png;base64,srv|7:1:0", "data:image/png;base64,srv|7:1:1"]);
    layer.unmount();
  });

  it("caps retained tiles: scrolled-away tiles are dropped and re-requested on scroll back", async () => {
    const oldVisible = framesFrom("2", MAX_RASTER_TILES - 8);
    const layer = mountLayer({ visible: oldVisible });
    await flush();
    expect(callFigmaMock).toHaveBeenCalledTimes(3); // 56 ids in 20-id batches

    const newVisible = framesFrom("3", MAX_RASTER_TILES + 6);
    layer.rerenderWith({ visible: newVisible });
    await flush();
    const srcs = Array.from(layer.container.querySelectorAll('img[data-testid="tile"]')).map(
      (node) => node.getAttribute("src"),
    );
    expect(srcs).toHaveLength(MAX_RASTER_TILES + 6); // all visible kept...
    expect(srcs.some((src) => src.includes("2:"))).toBe(false); // ...every hidden tile released
    expect(
      callFigmaMock.mock.calls.map(([, , payload]) => (payload as { ids: string[] }).ids.length),
    ).toEqual([20, 20, 16, 20, 20, 20, 10]);

    // Scrolling the old frames back in must request them again: the ledger forgets dropped ids.
    layer.rerenderWith({ visible: oldVisible });
    await flush();
    expect(callFigmaMock).toHaveBeenCalledWith(
      expect.anything(),
      "figma.file.render.request",
      expect.objectContaining({ ids: expect.arrayContaining(["2:0"]) }),
    );
    layer.unmount();
  });

  it("switching hosts on the same file/version/ids drops the other host's tiles", async () => {
    // Regression: the scope key omitted serverId, so A→B on the same (fileKey, version) kept
    // the identical ledger — no clear, no re-request, and host A's tiles painted forever.
    const batches = deferredRenderBatches();
    const visible = framesFrom("1", 2);
    const layer = mountLayer({ visible });
    await flush();
    expect(batches).toHaveLength(1);
    hosts.current.srvB = { id: "srvB" };

    layer.rerenderWith({ serverId: "srvB" });
    await flush();
    expect(batches).toHaveLength(2); // the new host must actually be asked
    expect(batches[1]!.clientId).toBe("srvB");

    batches[0]!.resolve("srv", "live"); // A's response lands only AFTER the switch
    await flush();
    expect(renderedTiles(layer.container)).toEqual([]); // stale success from a dead scope
    batches[1]!.resolve("srvB", "live");
    await flush();
    expect(renderedTiles(layer.container)).toEqual([
      "data:image/png;base64,srvB|live:1:0",
      "data:image/png;base64,srvB|live:1:1",
    ]);
    layer.unmount();
  });

  it("clears tiles on a server switch even while the new host is offline", async () => {
    // Regression: the effect returned on `!client` BEFORE the scope reset, so switching to a
    // host that had not connected yet left the previous host's tiles on screen indefinitely.
    const layer = mountLayer();
    await flush();
    expect(renderedTiles(layer.container)).toHaveLength(2);

    layer.rerenderWith({ serverId: "srvB" }); // srvB has no client yet (offline)
    await flush();
    expect(renderedTiles(layer.container)).toEqual([]);
    expect(callFigmaMock).toHaveBeenCalledTimes(1); // nothing to ask with; no new requests

    hosts.current.srvB = { id: "srvB" };
    layer.rerenderWith({ serverId: "srvB", visible: framesFrom("1", 2) }); // re-render picks it up
    await flush();
    expect(renderedTiles(layer.container)).toEqual([
      "data:image/png;base64,srvB|live:1:0",
      "data:image/png;base64,srvB|live:1:1",
    ]);
    layer.unmount();
  });

  it("keeps the new scope's ledger when an old-scope batch rejects late", async () => {
    // Regression: the catch deleted the batch ids from `requested` unconditionally, so a
    // rejection from the dead scope un-marked the ids the NEW scope had just re-requested, and
    // the next effect pass double-fetched while the live request was still pending.
    const batches = deferredRenderBatches();
    const visible = framesFrom("1", 2);
    const layer = mountLayer({ visible });
    await flush();
    expect(batches).toHaveLength(1);

    layer.rerenderWith({ version: "7" }); // scope change re-requests the same ids
    await flush();
    expect(batches).toHaveLength(2);
    expect(batches[1]!.ids).toEqual(["1:0", "1:1"]);

    batches[0]!.reject(new Error("old scope died"));
    await flush();
    // Same scope, fresh visible array: re-runs the effect; the live batch's ledger ids must
    // survive the stale rejection, so nothing is re-requested.
    layer.rerenderWith({ version: "7", visible: framesFrom("1", 2) });
    await flush();
    expect(batches).toHaveLength(2);

    batches[1]!.resolve("srv", "7");
    await flush();
    expect(renderedTiles(layer.container)).toEqual([
      "data:image/png;base64,srv|7:1:0",
      "data:image/png;base64,srv|7:1:1",
    ]);
    layer.unmount();
  });
});

describe("NativeCanvasLayer overview gate (ADR-0039)", () => {
  it("requests no rasters for frames projected a few pixels wide", async () => {
    const visible = framesFrom("1", 400); // 100×80 frames at 0.02 zoom project to ~2 px
    const layer = mountLayer({ visible, camera: { zoom: 0.02, offsetX: 0, offsetY: 0 } });
    await flush();
    await flush();
    expect(callFigmaMock).not.toHaveBeenCalled();
    layer.unmount();
  });

  it("requests rasters again once the zoom gives the same frames projected detail", async () => {
    const visible = framesFrom("1", 3);
    const layer = mountLayer({ visible, camera: { zoom: 0.02, offsetX: 0, offsetY: 0 } });
    await flush();
    expect(callFigmaMock).not.toHaveBeenCalled();
    layer.rerenderWith({ camera: CAMERA });
    await flush();
    expect(callFigmaMock).toHaveBeenCalledWith(
      expect.anything(),
      "figma.file.render.request",
      expect.objectContaining({ ids: ["1:0", "1:1", "1:2"] }),
    );
    layer.unmount();
  });
});

// ── CanvasView adaptive loading (spec 32.5.1, ADR-0039) ────────────────────────────────

function framesGrid(count: number): FigmaFrameSummary[] {
  return Array.from({ length: count }, (_, index) =>
    makeFrameSummary(`7:${index}`, (index % 50) * 220, Math.floor(index / 50) * 170, 200, 150),
  );
}

function sectionFrame(id: string, width: number, height: number): SectionAwareSummary {
  return { ...makeFrameSummary(id, 0, 0, width, height), type: "SECTION", childrenLoaded: false };
}

function viewerFetcher(respond?: (id: string, depth: number | undefined) => FigmaNode | null) {
  const calls: Array<{ ids: string[]; depth?: number }> = [];
  const fetchNodes = vi.fn(async (ids: readonly string[], options?: { depth?: number }) => {
    calls.push({ ids: [...ids], ...(options?.depth ? { depth: options.depth } : {}) });
    const nodes: Record<string, FigmaNode | null> = {};
    for (const id of ids) nodes[id] = respond ? respond(id, options?.depth) : makeNode({ id });
    return { nodes, components: {} };
  });
  return {
    calls,
    fetchNodes,
    subtreeIds: () => calls.filter((c) => c.depth === undefined).flatMap((c) => c.ids),
    sectionIds: () => calls.filter((c) => c.depth === 1).flatMap((c) => c.ids),
  };
}

function mountViewer(opts: {
  frames: readonly FigmaFrameSummary[];
  camera: Camera;
  store: FrameStore | null;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const props: React.ComponentProps<typeof CanvasView> = {
    serverId: "srv",
    fileKey: "file",
    version: null,
    page: { id: "0:1", name: "Page", frames: [...opts.frames], flowStartingPoints: [] },
    store: opts.store,
    camera: opts.camera,
    onCamera: noopCamera,
    selectedNodeId: null,
    onSelectNode: noopSelect,
    overrides: {},
  };
  act(() => root.render(<CanvasView {...props} />));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    rerender: (next: Partial<React.ComponentProps<typeof CanvasView>>) => {
      act(() => root.render(<CanvasView {...props} {...next} />));
    },
  };
}

/** Round-trip the store's queueMicrotask drain, the fetcher promises, and the notify re-render. */
async function settleLoads(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("CanvasView adaptive loading (ADR-0039)", () => {
  it("Fit on thousands of small frames loads nothing: metadata boxes only", async () => {
    const frames = framesGrid(1500);
    const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
    const { fetchNodes } = viewerFetcher();
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera, store });
    await settleLoads();
    expect(fetchNodes).not.toHaveBeenCalled(); // no subtree requests at overview
    expect(callFigmaMock).not.toHaveBeenCalled(); // and no thumbnail raster flood
    expect(assets.thumbnail).toEqual([]);
    viewer.unmount();
  });

  it("zooming onto one frame requests only the roots under the camera", async () => {
    const frames = framesGrid(1500);
    const camera: Camera = { zoom: 1, offsetX: -100, offsetY: -75 };
    const { fetchNodes, subtreeIds, sectionIds } = viewerFetcher();
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera, store });
    await settleLoads();
    const expected = framesInViewport(frames, camera, 800, 600, 120).map((f) => f.id);
    expect(expected.length).toBeGreaterThan(0);
    expect(new Set(subtreeIds())).toEqual(new Set(expected));
    expect(fetchNodes).toHaveBeenCalledTimes(1); // one ≤50-id batch, no flood of 1500
    expect(sectionIds()).toEqual([]);
    viewer.unmount();
  });

  it("camera moves over cached data repeat no API", async () => {
    const frames = framesGrid(1500);
    const camera: Camera = { zoom: 1, offsetX: -100, offsetY: -75 };
    const fit = cameraToFit(framesBoundingRect(frames), 800, 600);
    const { fetchNodes } = viewerFetcher();
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera, store });
    await settleLoads();
    expect(fetchNodes).toHaveBeenCalledTimes(1);

    viewer.rerender({ camera: { ...camera, offsetX: camera.offsetX + 2 } });
    await settleLoads();
    viewer.rerender({ camera }); // the same camera object again
    await settleLoads();
    viewer.rerender({ camera: fit });
    await settleLoads();
    viewer.rerender({ camera });
    await settleLoads();
    expect(fetchNodes).toHaveBeenCalledTimes(1); // already-cached ids never re-hit the network
    viewer.unmount();
  });

  it("defers unknown Section children at overview and never full-tree-loads a SECTION", async () => {
    const frames = [sectionFrame("10:1", 12000, 9000)];
    const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
    const { fetchNodes, subtreeIds, sectionIds } = viewerFetcher();
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera, store });
    await settleLoads();
    expect(fetchNodes).not.toHaveBeenCalled(); // overview: no depth-1 read yet either
    expect(subtreeIds()).toEqual([]);
    expect(sectionIds()).toEqual([]);
    viewer.unmount();
  });

  it("reads Section children with depth: 1 when vector detail arrives, recursively", async () => {
    const frames = [sectionFrame("10:1", 1200, 900)];
    const camera: Camera = { zoom: 1, offsetX: 0, offsetY: 0 };
    const { fetchNodes, subtreeIds, sectionIds } = viewerFetcher((id, depth) => {
      if (depth === 1 && id === "10:1")
        return makeNode({
          id: "10:1",
          type: "SECTION",
          children: [
            {
              id: "10:2",
              name: "Child screen",
              type: "FRAME",
              absoluteBoundingBox: { x: 50, y: 50, width: 200, height: 150 },
            },
            {
              id: "10:9",
              name: "Nested section",
              type: "SECTION",
              absoluteBoundingBox: { x: 300, y: 200, width: 600, height: 400 },
            },
          ] as FigmaNode[],
        });
      if (depth === 1 && id === "10:9")
        return makeNode({
          id: "10:9",
          type: "SECTION",
          children: [
            {
              id: "10:10",
              name: "Deep screen",
              type: "FRAME",
              absoluteBoundingBox: { x: 320, y: 220, width: 240, height: 180 },
            },
          ] as FigmaNode[],
        });
      if (depth === undefined) return makeNode({ id });
      return null;
    });
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera, store });
    await settleLoads();
    expect(sectionIds()).toEqual(["10:1", "10:9"]); // shallow reads, nested Section recursed
    expect(new Set(subtreeIds())).toEqual(new Set(["10:2", "10:10"])); // leaf roots only
    expect(subtreeIds()).not.toContain("10:1"); // the Section itself was never a tree load
    expect(subtreeIds()).not.toContain("10:9");
    expect(store.get("10:1")).toBeUndefined(); // fragments stay out of the full-subtree cache
    expect(store.sectionNode("10:1")?.type).toBe("SECTION");
    viewer.unmount();
  });
});
