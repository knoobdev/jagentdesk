/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaFrameSummary } from "@jagentdesk/protocol/figma/rpc-schemas";
import { makeFrameSummary } from "./__fixtures__/figma";
import { MAX_RASTER_TILES, NativeCanvasLayer, pruneRasterCache } from "./canvas-view";

// The app's tsconfig compiles JSX classic (expo `jsx: "react-native"`), so component modules
// under test reference a module-global React. Setup does not define it; the heavier import
// chains of sibling tests pull in a module that does.
const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
globalWithReact.React ??= React;

const { theme } = vi.hoisted(() => ({
  theme: {
    fontSize: { xs: 11 },
    colors: { foregroundMuted: "#888" },
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, testID, style }: Record<string, unknown>) =>
    React.createElement("div", { "data-testid": String(testID ?? ""), style }, children),
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
  useHostRuntimeClient: () => ({ id: "client" }),
  getHostRuntimeStore: () => ({ getSnapshot: () => null }),
}));
vi.mock("@/figma/renderer", () => ({
  createFigmaRenderer: () => ({ draw: vi.fn(), hitTest: vi.fn() }),
}));
vi.mock("./use-figma-assets", () => ({
  useFigmaAssets: () => ({
    subscribe: () => () => undefined,
    requestThumbnail: () => null,
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

/** The daemon answers every render batch with a tile tagged by the requested version. */
function serveRenderTiles() {
  callFigmaMock.mockImplementation((async (_client, _method, payload) => {
    const version = String((payload as { version?: string }).version ?? "live");
    const ids = (payload as { ids: string[] }).ids;
    const images: Record<string, { mimeType: string; dataBase64: string }> = {};
    for (const id of ids) images[id] = { mimeType: "image/png", dataBase64: `${version}:${id}` };
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

beforeEach(() => {
  callFigmaMock.mockReset();
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
    ).toEqual(["data:image/png;base64,live:1:0", "data:image/png;base64,live:1:1"]);

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
    expect(srcs).toEqual(["data:image/png;base64,7:1:0", "data:image/png;base64,7:1:1"]);
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
});
