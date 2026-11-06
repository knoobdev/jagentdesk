/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FigmaFrameSummary,
  FigmaNode,
  FigmaRequestParams,
  FigmaResponseData,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import type { DaemonClient } from "@jagentdesk/client/internal/daemon-client";
import { makeFrameSummary, makeNode } from "./__fixtures__/figma";
import {
  CANVAS_ID,
  CanvasView,
  MAX_RASTER_TILES,
  NativeCanvasLayer,
  pruneRasterCache,
  STATUS_FAILED,
  STATUS_LOADING,
  STATUS_ZOOM_HINT,
} from "./canvas-view";
import {
  CONNECT_EDITING_NOTICE,
  sectionEditing,
  STATUS_MOVE_FAILED,
  STATUS_SAVING_MOVE,
} from "./section-interaction";
import { FrameStore, type NodeBatch } from "./frame-store";
import type { SectionAwareSummary } from "./section-outline";
import {
  type Camera,
  cameraToFit,
  figmaToScreen,
  framesBoundingRect,
  framesInViewport,
} from "./viewport";

// The app's tsconfig compiles JSX classic (expo `jsx: "react-native"`), so component modules
// under test reference a module-global React. Setup does not define it; the heavier import
// chains of sibling tests pull in a module that does.
const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
globalWithReact.React ??= React;

const { theme, hosts, assets, viewLayout, platform, renderer } = vi.hoisted(() => ({
  theme: {
    fontSize: { xs: 11 },
    colors: { foregroundMuted: "#888" },
  },
  // Mutable per-serverId client registry: tests can register, unregister (offline), or swap
  // hosts exactly like the runtime store does.
  hosts: { current: {} as Record<string, { id: string } | null> },
  // Records what the paint path asks the asset caches for, so "no flood" is assertable.
  assets: {
    thumbnail: [] as string[],
    beginDraw: vi.fn(),
    endDraw: vi.fn(),
    // Backs the hook mock's status()/retryFailed(): tests push pending/failed numbers to
    // drive the honest loading status without a real cache.
    state: { pending: 0, failed: 0 },
    retryFailed: vi.fn(),
  },
  // The host View reports this layout once on mount, giving the viewer a viewport to cull.
  viewLayout: { current: { width: 800, height: 600 } },
  // The web/native branch of CanvasView, switched per test (native is the default).
  platform: { isWeb: false },
  // Shared renderer mock: tests arm hitTest to model child-vs-Section click ownership.
  renderer: { draw: vi.fn(), hitTest: vi.fn() },
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    testID,
    style,
    onLayout,
    ref,
  }: Record<string, unknown> & {
    children?: React.ReactNode;
    onLayout?: (event: unknown) => void;
  }) => {
    React.useEffect(() => {
      if (typeof onLayout === "function")
        onLayout({ nativeEvent: { layout: { ...viewLayout.current } } });
      // Mount-once: the viewer's onLayout handler is a stable useCallback.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    // The web path finds the host div through this ref to append its <canvas>.
    return React.createElement(
      "div",
      { "data-testid": String(testID ?? ""), style, ref: ref as never },
      children,
    );
  },
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
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

vi.mock("@/constants/platform", () => ({
  get isWeb() {
    return platform.isWeb;
  },
  get isNative() {
    return !platform.isWeb;
  },
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => hosts.current[serverId] ?? null,
  getHostRuntimeStore: () => ({ getSnapshot: () => null }),
}));
vi.mock("@/figma/renderer", () => ({
  createFigmaRenderer: () => renderer,
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
    status: () => ({ ...assets.state }),
    retryFailed: () => assets.retryFailed(),
    beginDraw: () => assets.beginDraw(),
    endDraw: () => assets.endDraw(),
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
/**
 * Typed `callFigma` mock adapter: an implementation of the generic signature cannot narrow
 * `FigmaRequestParams<T>` to the method under test (casting the payload per-call is exactly
 * what breaks once the protocol types are real), so each mock handler declares the concrete
 * protocol params/response for one request type and one cast bridges to the generic shape.
 */
type RenderRequestParams = FigmaRequestParams<"figma.file.render.request">;
type RenderResponseImages = Pick<FigmaResponseData<"figma.file.render.request">, "images">;

function mockRenderRequest(
  handle: (
    client: DaemonClient | null,
    params: RenderRequestParams,
  ) => RenderResponseImages | Promise<RenderResponseImages>,
): void {
  callFigmaMock.mockImplementation(((
    client: DaemonClient | null,
    _type: "figma.file.render.request",
    params: RenderRequestParams,
  ) => handle(client, params)) as unknown as typeof callFigma);
}

function serveRenderTiles() {
  mockRenderRequest(async (client, params) => {
    const host = (client as { id?: string } | null)?.id ?? "?";
    const version = String(params.version ?? "live");
    const images: Record<string, { mimeType: string; dataBase64: string }> = {};
    for (const id of params.ids)
      images[id] = { mimeType: "image/png", dataBase64: `${host}|${version}:${id}` };
    return { images };
  });
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
  const baseProps: React.ComponentProps<typeof NativeCanvasLayer> = {
    serverId: "srv",
    fileKey: "file",
    version: null,
    visible,
    camera: CAMERA,
    selectedNodeId: null,
    onSelectNode: noopSelect,
    onCamera: noopCamera,
    ...props,
  };
  act(() => root.render(<NativeCanvasLayer {...baseProps} />));
  return {
    container,
    rerenderWith: (next: Partial<React.ComponentProps<typeof NativeCanvasLayer>>) => {
      act(() => root.render(<NativeCanvasLayer {...baseProps} {...next} />));
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
  return Array.from(container.querySelectorAll('img[data-testid="tile"]'))
    .map((node) => node.getAttribute("src"))
    .filter((src): src is string => src !== null);
}

/** Deferred render batches so a test controls exactly when each response lands or fails. */
function deferredRenderBatches() {
  const batches: Array<{
    ids: string[];
    clientId: string;
    resolve: (host: string, version: string) => void;
    reject: (error: Error) => void;
  }> = [];
  mockRenderRequest((_client, params) => {
    const ids = [...params.ids];
    const clientId = (_client as { id?: string } | null)?.id ?? "?";
    return new Promise<RenderResponseImages>((resolve, reject) => {
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
    });
  });
  return batches;
}

beforeEach(() => {
  callFigmaMock.mockReset();
  hosts.current = { srv: { id: "srv" } };
  assets.thumbnail.length = 0;
  assets.beginDraw.mockClear();
  assets.endDraw.mockClear();
  assets.retryFailed.mockClear();
  assets.state.pending = 0;
  assets.state.failed = 0;
  renderer.hitTest.mockReset(); // re-armed per test; default: no child under the cursor
  serveRenderTiles();
});

afterEach(() => {
  platform.isWeb = false;
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
    expect(renderedTiles(layer.container)).toEqual([
      "data:image/png;base64,srv|live:1:0",
      "data:image/png;base64,srv|live:1:1",
    ]);

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
    const srcs = renderedTiles(layer.container);
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
    const srcs = renderedTiles(layer.container);
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
  onSelectNode?: (nodeId: string | null) => void;
  onCamera?: (next: Camera) => void;
  selectedNodeId?: string | null;
  sectionEditing?: React.ComponentProps<typeof CanvasView>["sectionEditing"];
  sectionOffsets?: React.ComponentProps<typeof CanvasView>["sectionOffsets"];
  sectionMoveStatus?: React.ComponentProps<typeof CanvasView>["sectionMoveStatus"];
  onMoveSection?: React.ComponentProps<typeof CanvasView>["onMoveSection"];
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
    onCamera: opts.onCamera ?? noopCamera,
    selectedNodeId: opts.selectedNodeId ?? null,
    onSelectNode: opts.onSelectNode ?? noopSelect,
    overrides: {},
    sectionEditing: opts.sectionEditing,
    sectionOffsets: opts.sectionOffsets,
    sectionMoveStatus: opts.sectionMoveStatus,
    onMoveSection: opts.onMoveSection,
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

// ── web-path input/paint regressions (ADR-0039 review round) ──────────────────────────

/** Dispatch a click without movement on the canvas the web viewer appends to its host div. */
function clickCanvas(x: number, y: number): void {
  const canvas = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
  expect(canvas).toBeTruthy();
  const target = canvas as HTMLCanvasElement;
  target.setPointerCapture = () => undefined;
  target.releasePointerCapture = () => undefined;
  const init = { clientX: x, clientY: y, button: 0 };
  act(() => {
    target.dispatchEvent(new MouseEvent("pointerdown", init));
    target.dispatchEvent(new MouseEvent("pointerup", init));
  });
}

/** jsdom has no 2D context; every drawing call is recorded as a no-op through this Proxy. */
function fakeCtx(): CanvasRenderingContext2D {
  const props: Record<string, unknown> = {};
  return new Proxy(props, {
    get: (t, p) => {
      if (p === "getTransform") return () => ({ a: 1 });
      if (!(p in t)) t[p as string] = () => undefined;
      return t[p as string];
    },
  }) as unknown as CanvasRenderingContext2D;
}

async function settlePaint(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => setTimeout(() => resolve(), 0)),
      );
    });
  }
}

describe("CanvasView click select — no Fit flood (ADR-0039)", () => {
  it("one click at Fit loads at most the root under the cursor, never the whole file", async () => {
    platform.isWeb = true;
    const frames = framesGrid(1500);
    const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
    const { fetchNodes, subtreeIds } = viewerFetcher();
    const store = new FrameStore(fetchNodes);
    const selections = vi.fn();
    const viewer = mountViewer({ frames, camera, store, onSelectNode: selections });
    await settleLoads();
    expect(fetchNodes).not.toHaveBeenCalled(); // Fit itself loads nothing

    const target = frames[777] as FigmaFrameSummary;
    const at = figmaToScreen(camera, {
      x: target.bounds.x + target.bounds.width / 2,
      y: target.bounds.y + target.bounds.height / 2,
    });
    clickCanvas(at.x, at.y);
    await settleLoads();
    expect(subtreeIds()).toEqual(["7:777"]); // exactly the clicked root — no 1500-root flood
    expect(fetchNodes).toHaveBeenCalledTimes(1);

    // A point past the grid's right edge (10980 px) contains no root at all: nothing new
    // loads, nothing selects. (The 20-px gutters are sub-pixel at Fit zoom and would drift.)
    const gap = figmaToScreen(camera, { x: 11060, y: 75 });
    clickCanvas(gap.x, gap.y);
    await settleLoads();
    expect(fetchNodes).toHaveBeenCalledTimes(1);
    expect(selections).toHaveBeenLastCalledWith(null);
    viewer.unmount();
  });

  it("loading all viewport candidates was the flood: two distant clicks load two roots only", async () => {
    platform.isWeb = true;
    const frames = framesGrid(1500);
    const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
    const { fetchNodes, subtreeIds } = viewerFetcher();
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera, store });
    await settleLoads();
    for (const id of ["7:0", "7:1234"]) {
      const frame = frames.find((f) => f.id === id) as FigmaFrameSummary;
      const at = figmaToScreen(camera, {
        x: frame.bounds.x + frame.bounds.width / 2,
        y: frame.bounds.y + frame.bounds.height / 2,
      });
      clickCanvas(at.x, at.y);
      await settleLoads();
    }
    expect(new Set(subtreeIds())).toEqual(new Set(["7:0", "7:1234"]));
    expect(fetchNodes).toHaveBeenCalledTimes(2);
    viewer.unmount();
  });

  it("overlapping stack at Fit queues only the TOPMOST unloaded root, not every overlap", async () => {
    platform.isWeb = true;
    // 200 identical-bounds frames at the same spot: the spatially separated grid alone could
    // not expose the fallthrough that queued EVERY missing overlap under the cursor.
    const stack: FigmaFrameSummary[] = Array.from({ length: 200 }, (_, index) =>
      makeFrameSummary(`8:${index}`, 1000, 1000, 200, 150),
    );
    const frames = framesGrid(1500).concat(stack);
    const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
    const { fetchNodes, subtreeIds } = viewerFetcher();
    const store = new FrameStore(fetchNodes);
    const selections = vi.fn();
    const viewer = mountViewer({ frames, camera, store, onSelectNode: selections });
    await settleLoads();
    expect(fetchNodes).not.toHaveBeenCalled();

    const top = stack[stack.length - 1] as FigmaFrameSummary; // last drawn = topmost
    const at = figmaToScreen(camera, { x: top.bounds.x + 100, y: top.bounds.y + 75 });
    clickCanvas(at.x, at.y);
    await settleLoads();
    expect(subtreeIds()).toEqual([top.id]); // ONE root queued, not 200 overlapping loads
    expect(fetchNodes).toHaveBeenCalledTimes(1);
    expect(selections).not.toHaveBeenCalled(); // selection stays as-is; no lower loaded fallback
    viewer.unmount();
  });

  it("an unknown topmost root is not answered by a loaded lower frame's hitTest", async () => {
    platform.isWeb = true;
    const lower = makeFrameSummary("9:0", 1000, 1000, 200, 150);
    const upper = makeFrameSummary("9:99", 950, 950, 400, 300); // covers the click point
    const frames = [lower, upper];
    // Screen (450, 450) maps to Figma (1100, 1100): inside BOTH summaries; the topmost (last
    // drawn) is the one whose tree has not landed.
    const camera: Camera = { zoom: 1, offsetX: -650, offsetY: -650 };
    const fetchNodes = vi.fn(
      async (ids: readonly string[]): Promise<NodeBatch> =>
        ids.includes("9:99")
          ? new Promise<NodeBatch>(() => {}) // the occluder's batch is in flight, never lands
          : { nodes: { "9:0": makeNode({ id: "9:0" }) }, components: {} },
    );
    const store = new FrameStore(fetchNodes);
    await store.load(["9:0"]); // only the LOWER root has a tree, loaded before mount
    const selections = vi.fn();
    const viewer = mountViewer({ frames, camera, store, onSelectNode: selections });
    await settleLoads(); // the pre-paint effect's first-exposure request of the occluder hangs
    expect(store.get("9:0")).toBeTruthy();
    fetchNodes.mockClear();
    clickCanvas(450, 450);
    await settleLoads();
    expect(fetchNodes).not.toHaveBeenCalled(); // dedup by the in-flight ledger, and no 9:0 refetch
    expect(selections).not.toHaveBeenCalled(); // the loaded lower frame was NOT reported
    viewer.unmount();
  });
});

describe("CanvasView SECTION painting (ADR-0039)", () => {
  it("never requests a whole-Section thumbnail raster at thumbnail LOD", async () => {
    platform.isWeb = true;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    try {
      // zoom 0.1 = thumbnail LOD; the 600-wide frame projects ≥ detail, the Section is huge.
      const frames = [
        sectionFrame("10:1", 5000, 4000),
        { ...makeFrameSummary("1:5", 100, 100, 600, 400) },
      ];
      const camera: Camera = { zoom: 0.1, offsetX: 0, offsetY: 0 };
      const { fetchNodes, subtreeIds } = viewerFetcher();
      const store = new FrameStore(fetchNodes);
      const viewer = mountViewer({ frames, camera, store });
      await settlePaint();
      expect(assets.thumbnail).toContain("1:5"); // detail-worthy frame gets its raster
      expect(assets.thumbnail).not.toContain("10:1"); // the Section is chrome in every LOD
      expect(fetchNodes).not.toHaveBeenCalled(); // thumbnail LOD loads no subtrees
      expect(subtreeIds()).toEqual([]);
      viewer.unmount();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it("native raster requests skip SECTION ids", async () => {
    const visible = [sectionFrame("10:1", 1200, 900), ...framesFrom("1", 2)];
    const layer = mountLayer({ visible });
    await flush();
    expect(callFigmaMock).toHaveBeenCalledTimes(1);
    expect(callFigmaMock).toHaveBeenCalledWith(
      expect.anything(),
      "figma.file.render.request",
      expect.objectContaining({ ids: ["1:0", "1:1"] }), // no "10:1": a Section is never tiled
    );
    layer.unmount();
  });
});

// ── per-paint asset retention wrapper (spec 32.5.1, design accepted; real hook by W10) ──

/**
 * The merged sequence of beginDraw/endDraw invocations, in true call order. The wrapper's
 * contract is that paint always appears as strictly paired `begin end` frames — a missing
 * `end` is a frame left open (caches never reconcile), a missing `begin` is a paint that
 * skipped retention, and any `begin begin` overlap means re-entrancy the sync paint forbids.
 */
function retentionSequence(): Array<"begin" | "end"> {
  const events = [
    ...assets.beginDraw.mock.invocationCallOrder.map((order) => ({
      order,
      kind: "begin" as const,
    })),
    ...assets.endDraw.mock.invocationCallOrder.map((order) => ({ order, kind: "end" as const })),
  ];
  events.sort((a, b) => a.order - b.order);
  return events.map((event) => event.kind);
}

function expectBalancedFrames(minPaints = 1): void {
  const sequence = retentionSequence();
  expect(sequence.length).toBeGreaterThanOrEqual(minPaints * 2);
  expect(sequence).toEqual(
    Array.from({ length: sequence.length / 2 }, () => ["begin", "end"]).flat(),
  );
  expect(assets.beginDraw).toHaveBeenCalledTimes(assets.endDraw.mock.calls.length);
}

/** One-shot 2D context: the FIRST call to `method` throws, imitating a mid-paint failure. */
function fakeCtxThrowingOnce(method: string): CanvasRenderingContext2D {
  const props: Record<string, unknown> = {};
  let armed = true;
  return new Proxy(props, {
    get: (t, p) => {
      if (p === "getTransform") return () => ({ a: 1 });
      if (p === method && armed) {
        armed = false;
        return () => {
          throw new Error("mid-paint canvas failure");
        };
      }
      if (!(p in t)) t[p as string] = () => undefined;
      return t[p as string];
    },
  }) as unknown as CanvasRenderingContext2D;
}

describe("CanvasView paint retention wrapper (spec 32.5.1)", () => {
  it("opens and closes exactly one retention frame per normal paint", async () => {
    platform.isWeb = true;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    try {
      const frames = framesGrid(3);
      const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
      const { fetchNodes } = viewerFetcher();
      const viewer = mountViewer({ frames, camera, store: new FrameStore(fetchNodes) });
      await settlePaint(3);
      expectBalancedFrames();
      viewer.unmount();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it("closes the frame through finally when the canvas throws mid-paint", async () => {
    platform.isWeb = true;
    const original = HTMLCanvasElement.prototype.getContext;
    // drawMetadataBox's first strokeRect aborts paint after the frame opened; the begin/end
    // pair must still close (that is what `finally` guarantees).
    HTMLCanvasElement.prototype.getContext = (() => fakeCtxThrowingOnce("strokeRect")) as never;
    try {
      const frames = framesGrid(3);
      const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
      const { fetchNodes } = viewerFetcher();
      const store = new FrameStore(fetchNodes);
      const viewer = mountViewer({ frames, camera, store });
      await settlePaint(3);
      expect(assets.beginDraw).toHaveBeenCalled();
      expectBalancedFrames(); // equal counts: the throw did not leak an open frame
      viewer.unmount();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
    // Recovery: a fresh mount paints normally again — the failure did not strand the wrapper.
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    try {
      const frames = framesGrid(3);
      const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
      const { fetchNodes } = viewerFetcher();
      const viewer = mountViewer({ frames, camera, store: new FrameStore(fetchNodes) });
      await settlePaint(2);
      expectBalancedFrames();
      viewer.unmount();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it("still reconciles when paint early-returns after a valid ctx (null store, empty viewport)", async () => {
    platform.isWeb = true;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => fakeCtx()) as never;
    try {
      const { fetchNodes } = viewerFetcher();
      // (a) store=null returns at the page/store guard — the frame still opens and closes.
      const frames = framesGrid(3);
      const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
      const noStore = mountViewer({ frames, camera, store: null });
      await settlePaint(2);
      expect(assets.beginDraw).toHaveBeenCalled();
      expectBalancedFrames();
      expect(assets.thumbnail).toEqual([]); // nothing past the guard drew
      noStore.unmount();

      // (b) empty viewport: every frame is culled, so ALL caches reconcile against an
      // unobserved set — no exempt rule, the frame still closes.
      assets.beginDraw.mockClear();
      assets.endDraw.mockClear();
      const far = [makeFrameSummary("7:900", 50000, 50000, 200, 150)];
      const empty = mountViewer({
        frames: far,
        camera: { zoom: 1, offsetX: 0, offsetY: 0 },
        store: new FrameStore(fetchNodes),
      });
      await settlePaint(2);
      expectBalancedFrames();
      expect(assets.thumbnail).toEqual([]);
      empty.unmount();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });

  it("never opens a frame when no usable 2D context exists", async () => {
    platform.isWeb = true;
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => null) as never; // jsdom-real: no 2D context
    try {
      const frames = framesGrid(3);
      const camera = cameraToFit(framesBoundingRect(frames), 800, 600);
      const { fetchNodes } = viewerFetcher();
      const viewer = mountViewer({ frames, camera, store: new FrameStore(fetchNodes) });
      await settlePaint(2);
      expect(assets.beginDraw).not.toHaveBeenCalled();
      expect(assets.endDraw).not.toHaveBeenCalled(); // placement: the ctx guard precedes begin
      viewer.unmount();
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
    }
  });
});

// ── honest content status (spec 32.5.1) ────────────────────────────────────────────────

/**
 * A 2D context that records every `fillText` argument, one batch per paint: each draw calls
 * getContext, so after a settled paint `state.texts` holds exactly what the LAST paint drew —
 * status assertions cannot be polluted by an earlier frame's line.
 */
function ctxTextRecorder() {
  const state = {
    texts: [] as string[],
    at: [] as Array<[string, number, number]>,
    translates: [] as Array<[number, number]>,
  };
  const make = (): CanvasRenderingContext2D => {
    state.texts = [];
    state.at = [];
    state.translates = [];
    const props: Record<string, unknown> = {
      fillText: (value: string, x: number, y: number) => {
        state.texts.push(String(value));
        state.at.push([String(value), x, y]);
      },
      translate: (dx: number, dy: number) => state.translates.push([dx, dy]),
    };
    return new Proxy(props, {
      get: (t, p) => {
        if (p === "getTransform") return () => ({ a: 1 });
        if (!(p in t)) t[p as string] = () => undefined;
        return t[p as string];
      },
    }) as unknown as CanvasRenderingContext2D;
  };
  return { state, make };
}

async function withPaintedViewer(
  setup: () =>
    | Promise<{ viewer: { unmount: () => void } }>
    | {
        viewer: { unmount: () => void };
      },
  paint: (
    texts: () => string[],
    ops: () => { at: Array<[string, number, number]>; translates: Array<[number, number]> },
  ) => Promise<void> | void,
): Promise<void> {
  const rec = ctxTextRecorder();
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() => rec.make()) as never;
  let viewer: { unmount: () => void } | null = null;
  try {
    viewer = (await setup()).viewer;
    await paint(
      () => rec.state.texts,
      () => ({ at: rec.state.at, translates: rec.state.translates }),
    );
  } finally {
    viewer?.unmount();
    HTMLCanvasElement.prototype.getContext = original;
  }
}

// Helpers for the pending-ledger tests: a subtree fetch that never lands (module scope keeps
// these out of the nested-callback limit) and an id filter for "which roots were requested".
function neverLandingBatch(): Promise<NodeBatch> {
  return new Promise(() => undefined);
}

function idsNamed(ids: string[], id: string): string[] {
  return ids.filter((candidate) => candidate === id);
}

describe("CanvasView honest content status (spec 32.5.1)", () => {
  it("shows loading while a visible detail subtree is still in flight", async () => {
    platform.isWeb = true;
    await withPaintedViewer(
      () => {
        const fetchNodes = vi.fn(neverLandingBatch);
        const store = new FrameStore(fetchNodes);
        return {
          viewer: mountViewer({
            frames: framesGrid(3),
            camera: { zoom: 1, offsetX: 0, offsetY: 0 },
            store,
          }),
        };
      },
      async (texts) => {
        await settleLoads(); // drain the queue into the inflight ledger
        await settlePaint(2);
        expect(texts()).toContain(STATUS_LOADING);
      },
    );
  });

  it("reports a fully loaded, fully delivered viewport with no status line at all", async () => {
    platform.isWeb = true;
    await withPaintedViewer(
      () => {
        const { fetchNodes } = viewerFetcher(); // resolves every root
        return {
          viewer: mountViewer({
            frames: framesGrid(3),
            camera: { zoom: 1, offsetX: 0, offsetY: 0 },
            store: new FrameStore(fetchNodes),
          }),
        };
      },
      async (texts) => {
        await settleLoads();
        await settlePaint(2);
        expect(texts()).not.toContain(STATUS_LOADING);
        expect(texts()).not.toContain(STATUS_FAILED);
        expect(texts()).not.toContain(STATUS_ZOOM_HINT);
      },
    );
  });

  it("an undelivered asset attempt reports loading, and outranks failures", async () => {
    platform.isWeb = true;
    assets.state.pending = 2;
    assets.state.failed = 3; // loading must beat "failed" while work is still on its way
    await withPaintedViewer(
      () => {
        const { fetchNodes } = viewerFetcher();
        return {
          viewer: mountViewer({
            frames: framesGrid(3),
            camera: { zoom: 1, offsetX: 0, offsetY: 0 },
            store: new FrameStore(fetchNodes),
          }),
        };
      },
      async (texts) => {
        await settleLoads();
        await settlePaint(2);
        expect(texts()).toContain(STATUS_LOADING);
        expect(texts()).not.toContain(STATUS_FAILED);
      },
    );
  });

  it("terminal failed asset attempts show the retry line once nothing is pending", async () => {
    platform.isWeb = true;
    assets.state.failed = 1;
    await withPaintedViewer(
      () => {
        const { fetchNodes } = viewerFetcher();
        return {
          viewer: mountViewer({
            frames: framesGrid(3),
            camera: { zoom: 1, offsetX: 0, offsetY: 0 },
            store: new FrameStore(fetchNodes),
          }),
        };
      },
      async (texts) => {
        await settleLoads();
        await settlePaint(2);
        expect(texts()).toContain(STATUS_FAILED);
      },
    );
  });

  it("a confirmed-missing root reads as failed, and a tap retries exactly that root", async () => {
    platform.isWeb = true;
    const { fetchNodes, subtreeIds } = viewerFetcher(() => null); // every root: confirmed null
    const store = new FrameStore(fetchNodes);
    const selections = vi.fn();
    await withPaintedViewer(
      () => ({
        viewer: mountViewer({
          frames: framesGrid(3),
          camera: { zoom: 1, offsetX: 0, offsetY: 0 },
          store,
          onSelectNode: selections,
        }),
      }),
      async (texts) => {
        await settleLoads();
        await settlePaint(2);
        expect(texts()).toContain(STATUS_FAILED);
        expect(idsNamed(subtreeIds(), "7:0")).toHaveLength(1);

        // Tap the frame whose read confirmed missing: targeted retry of THAT root only.
        clickCanvas(100, 75); // center of 7:0 at (0,0,200,150), camera offset 0 zoom 1
        expect(assets.retryFailed).toHaveBeenCalled(); // failed asset attempts cleared too
        await settleLoads();
        const retried = idsNamed(subtreeIds(), "7:0");
        expect(retried).toHaveLength(2); // re-queued, despite the cached null verdict
        expect(selections).not.toHaveBeenCalled(); // a retry is not a selection
      },
    );
  });

  it("a pure metadata overview says zoom for detail instead of going silent", async () => {
    platform.isWeb = true;
    // 300x225 projected 30px at zoom 0.1 — below the detail threshold: metadata-only is right,
    // but the paper must explain itself (spec 32.5.1: the overview is not a content failure).
    const frames = [makeFrameSummary("9:1", 0, 0, 300, 225)];
    await withPaintedViewer(
      () => {
        const { fetchNodes } = viewerFetcher();
        return {
          viewer: mountViewer({
            frames,
            camera: { zoom: 0.1, offsetX: 0, offsetY: 0 },
            store: new FrameStore(fetchNodes),
          }),
        };
      },
      async (texts) => {
        await settlePaint(2);
        expect(texts()).toContain(STATUS_ZOOM_HINT);
      },
    );
    // ...and the overview demanded zero subtree loads on the way there.
    const { fetchNodes } = viewerFetcher();
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera: { zoom: 0.1, offsetX: 0, offsetY: 0 }, store });
    await settleLoads();
    expect(fetchNodes).not.toHaveBeenCalled();
    viewer.unmount();
  });

  it("a SECTION whose depth-1 children are still queued counts as pending content", async () => {
    platform.isWeb = true;
    const section = sectionFrame("40:1", 900, 600); // full-plan at zoom 1 → shallow expansion
    await withPaintedViewer(
      () => {
        const fetchNodes = vi.fn(neverLandingBatch);
        return {
          viewer: mountViewer({
            frames: [section],
            camera: { zoom: 1, offsetX: 0, offsetY: 0 },
            store: new FrameStore(fetchNodes),
          }),
        };
      },
      async (texts) => {
        await settleLoads();
        await settlePaint(2);
        expect(texts()).toContain(STATUS_LOADING);
      },
    );
  });

  it("a mounted canvas without its store is not content-ready: it says loading", async () => {
    platform.isWeb = true;
    await withPaintedViewer(
      () => ({
        viewer: mountViewer({
          frames: framesGrid(1),
          camera: { zoom: 1, offsetX: 0, offsetY: 0 },
          store: null,
        }),
      }),
      async (texts) => {
        await settlePaint(2);
        expect(texts()).toContain(STATUS_LOADING);
      },
    );
  });
});

describe("NativeCanvasLayer honest content status (spec 32.5.1)", () => {
  const statusNode = (container: HTMLElement) =>
    container.querySelector('[data-testid="figma-canvas-status"]');

  it("overlays loading while a demanded tile batch is still in flight, then goes quiet", async () => {
    const batches = deferredRenderBatches(); // tiles never land until the test says so
    const layer = mountLayer({
      visible: framesFrom("1", 2),
      camera: { zoom: 1, offsetX: 0, offsetY: 0 },
    });
    await flush();
    expect(batches.length).toBeGreaterThan(0);
    expect(statusNode(layer.container)?.textContent).toContain(STATUS_LOADING);

    for (const batch of batches) batch.resolve("srv", "live");
    await flush();
    expect(renderedTiles(layer.container)).toHaveLength(2); // the load was real
    expect(statusNode(layer.container)).toBeNull(); // delivered: no line, no lie
    layer.unmount();
  });

  it("surfaces the ledger's failure line once every tile is present", async () => {
    const layer = mountLayer({
      visible: framesFrom("1", 2),
      camera: { zoom: 1, offsetX: 0, offsetY: 0 },
      statusText: STATUS_FAILED,
    });
    await flush(); // serveRenderTiles (beforeEach) lands the batch
    expect(renderedTiles(layer.container)).toHaveLength(2);
    expect(statusNode(layer.container)?.textContent).toContain(STATUS_FAILED);
    layer.unmount();
  });
});

// ── SECTION selection + drag on the web viewer (spec 32.6.2 / acceptance 19) ───────────

function bigSection(): SectionAwareSummary {
  return {
    id: "40:1",
    name: "Flow Board",
    type: "SECTION",
    bounds: { x: 0, y: 0, width: 1000, height: 800 },
    childrenLoaded: false,
  };
}

function frameChild(
  id: string,
  x: number,
  y: number,
  width = 200,
  height = 150,
): SectionAwareSummary {
  return {
    id,
    name: `Frame ${id}`,
    type: "FRAME",
    bounds: { x, y, width, height },
    parentId: "40:1",
  };
}

const CAMERA_ORIGIN: Camera = { zoom: 1, offsetX: 0, offsetY: 0 };
const EDITABLE = sectionEditing({ capability: true, remoteConnected: true, versionPinned: false });
const READ_ONLY = sectionEditing({
  capability: false,
  remoteConnected: true,
  versionPinned: false,
});

function canvasEl(): HTMLCanvasElement {
  const canvas = document.getElementById(CANVAS_ID) as HTMLCanvasElement | null;
  expect(canvas).toBeTruthy();
  const target = canvas as HTMLCanvasElement;
  target.setPointerCapture = () => undefined;
  target.releasePointerCapture = () => undefined;
  return target;
}

function pointer(type: string, x: number, y: number, button = 0): void {
  canvasEl().dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button }));
}

/** Discrete press-track-release with intermediate moves; one event batch per act() pass. */
function dragCanvas(
  from: { x: number; y: number },
  to: { x: number; y: number },
  options: { button?: number; steps?: number } = {},
): void {
  const button = options.button ?? 0;
  const steps = options.steps ?? 4;
  act(() => pointer("pointerdown", from.x, from.y, button));
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    act(() =>
      pointer("pointermove", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, button),
    );
  }
  act(() => pointer("pointerup", to.x, to.y, button));
}

function pressKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

function releaseKey(key: string): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keyup", { key }));
  });
}

describe("CanvasView SECTION select + drag (spec 32.6.2)", () => {
  it("the label strip selects the Section even where a child frame overlaps it", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher();
    const selections = vi.fn();
    const viewer = mountViewer({
      frames: [bigSection(), frameChild("41:1", 0, 0)],
      camera: CAMERA_ORIGIN,
      store: new FrameStore(fetchNodes),
      onSelectNode: selections,
    });
    await settleLoads();
    clickCanvas(100, 8); // inside the child's box, but on the Section's header band
    expect(selections).toHaveBeenLastCalledWith("40:1");
    viewer.unmount();
  });

  it("a click on a child still selects the child, not the Section", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher(); // child roots resolve loaded
    const selections = vi.fn();
    renderer.hitTest.mockReturnValue({ id: "41:77" }); // the child's tree owns the cursor
    const viewer = mountViewer({
      frames: [bigSection(), frameChild("41:1", 0, 0)],
      camera: CAMERA_ORIGIN,
      store: new FrameStore(fetchNodes),
      onSelectNode: selections,
    });
    await settleLoads();
    clickCanvas(100, 100); // interior of the child, below the header band
    expect(selections).toHaveBeenLastCalledWith("41:77");
    expect(selections).not.toHaveBeenCalledWith("40:1");
    viewer.unmount();
  });

  it("the empty interior selects the Section when no child claims the cursor", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher();
    const selections = vi.fn();
    const viewer = mountViewer({
      frames: [bigSection(), frameChild("41:1", 0, 0)],
      camera: CAMERA_ORIGIN,
      store: new FrameStore(fetchNodes),
      onSelectNode: selections,
    });
    await settleLoads();
    clickCanvas(600, 500); // deep inside the Section, outside every frame
    expect(selections).toHaveBeenLastCalledWith("40:1");
    viewer.unmount();
  });

  it("a header drag of the selected Section previews the subtree and commits ONE write", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher();
    const moves = vi.fn();
    const cameras = vi.fn();
    const viewer = mountViewer({
      frames: [bigSection(), frameChild("41:1", 300, 300)],
      camera: CAMERA_ORIGIN,
      store: new FrameStore(fetchNodes),
      selectedNodeId: "40:1",
      sectionEditing: EDITABLE,
      onMoveSection: moves,
      onCamera: cameras,
    });
    await settleLoads();
    dragCanvas({ x: 500, y: 8 }, { x: 600, y: 108 }, { steps: 6 });
    expect(moves).toHaveBeenCalledTimes(1);
    expect(moves).toHaveBeenCalledWith("40:1", 100, 100); // px delta / zoom 1
    expect(cameras).not.toHaveBeenCalled(); // the gesture never panned the camera
    viewer.unmount();
  });

  it("Esc during a drag cancels the preview with ZERO writes", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher();
    const moves = vi.fn();
    const cameras = vi.fn();
    const viewer = mountViewer({
      frames: [bigSection()],
      camera: CAMERA_ORIGIN,
      store: new FrameStore(fetchNodes),
      selectedNodeId: "40:1",
      sectionEditing: EDITABLE,
      onMoveSection: moves,
      onCamera: cameras,
    });
    await settleLoads();
    act(() => pointer("pointerdown", 500, 8));
    act(() => pointer("pointermove", 560, 68)); // past the threshold: previewing
    pressKey("Escape");
    act(() => pointer("pointerup", 560, 68));
    expect(moves).not.toHaveBeenCalled(); // Esc wrote nothing
    expect(cameras).not.toHaveBeenCalled(); // and nothing panned either
    viewer.unmount();
  });

  it("Space held over the header pans instead of dragging", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher();
    const moves = vi.fn();
    const cameras = vi.fn();
    const viewer = mountViewer({
      frames: [bigSection()],
      camera: CAMERA_ORIGIN,
      store: new FrameStore(fetchNodes),
      selectedNodeId: "40:1",
      sectionEditing: EDITABLE,
      onMoveSection: moves,
      onCamera: cameras,
    });
    await settleLoads();
    pressKey(" ");
    dragCanvas({ x: 500, y: 8 }, { x: 600, y: 108 }, { steps: 6 });
    releaseKey(" ");
    expect(moves).not.toHaveBeenCalled();
    expect(cameras).toHaveBeenCalled();
    viewer.unmount();
  });

  it("the middle button always pans and never selects", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher();
    const moves = vi.fn();
    const cameras = vi.fn();
    const selections = vi.fn();
    const viewer = mountViewer({
      frames: [bigSection()],
      camera: CAMERA_ORIGIN,
      store: new FrameStore(fetchNodes),
      selectedNodeId: "40:1",
      sectionEditing: EDITABLE,
      onMoveSection: moves,
      onCamera: cameras,
      onSelectNode: selections,
    });
    await settleLoads();
    dragCanvas({ x: 500, y: 8 }, { x: 600, y: 108 }, { button: 1, steps: 6 });
    expect(cameras).toHaveBeenCalled();
    expect(moves).not.toHaveBeenCalled();
    expect(selections).not.toHaveBeenCalled(); // middle release is not a click
    viewer.unmount();
  });

  it("a selected Section on a read-only surface says Connect editing and cannot drag", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher();
    const moves = vi.fn();
    await withPaintedViewer(
      () => ({
        viewer: mountViewer({
          frames: [bigSection()],
          camera: CAMERA_ORIGIN,
          store: new FrameStore(fetchNodes),
          selectedNodeId: "40:1",
          sectionEditing: READ_ONLY,
          onMoveSection: moves,
        }),
      }),
      async (texts) => {
        await settlePaint(2);
        expect(texts()).toContain(CONNECT_EDITING_NOTICE);
        dragCanvas({ x: 500, y: 8 }, { x: 560, y: 68 }, { steps: 4 });
        expect(moves).not.toHaveBeenCalled(); // select/pan only: no write path engaged
      },
    );
  });

  it("an in-flight move owns the line, and so does its failure", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher();
    await withPaintedViewer(
      () => ({
        viewer: mountViewer({
          frames: [bigSection()],
          camera: CAMERA_ORIGIN,
          store: new FrameStore(fetchNodes),
          selectedNodeId: "40:1",
          sectionEditing: EDITABLE,
          sectionMoveStatus: "saving",
        }),
      }),
      async (texts) => {
        await settlePaint(2);
        expect(texts()).toContain(STATUS_SAVING_MOVE);
      },
    );
    const viewer = mountViewer({
      frames: [bigSection()],
      camera: CAMERA_ORIGIN,
      store: new FrameStore(vi.fn(async (): Promise<NodeBatch> => ({ nodes: {}, components: {} }))),
      selectedNodeId: "40:1",
      sectionEditing: EDITABLE,
      sectionMoveStatus: "failed",
    });
    const rec = ctxTextRecorder();
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = (() => rec.make()) as never;
    try {
      await settlePaint(2);
      expect(rec.state.texts).toContain(STATUS_MOVE_FAILED);
    } finally {
      HTMLCanvasElement.prototype.getContext = original;
      viewer.unmount();
    }
  });

  it("committed offsets shift the Section chrome and translate its known descendants", async () => {
    platform.isWeb = true;
    const { fetchNodes } = viewerFetcher(); // child subtree loads; renderer.draw is the mock
    await withPaintedViewer(
      () => ({
        viewer: mountViewer({
          frames: [bigSection(), frameChild("41:1", 300, 300)],
          camera: CAMERA_ORIGIN,
          store: new FrameStore(fetchNodes),
          sectionEditing: EDITABLE,
          sectionOffsets: { "40:1": { dx: 50, dy: 0 } },
        }),
      }),
      async (texts, ops) => {
        await settleLoads();
        await settlePaint(2);
        // Section chrome draws at the OFFSET position (metadata bounds + dx):
        expect(ops().at).toContainEqual(["Flow Board", 58, 18]);
        // and its known descendant's tree draws under a matching translate — the parentId
        // closure preview, not a full-section fetch.
        expect(ops().translates).toContainEqual([50, 0]);
        expect(texts().length).toBeGreaterThanOrEqual(0);
      },
    );
  });
});
