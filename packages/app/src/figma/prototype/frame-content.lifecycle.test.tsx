/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { FigmaBytes, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";

const { theme, clientRef, callFigma, draws } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16, 6: 24 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", semibold: "600" },
    borderRadius: { sm: 4, md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    colors: {
      surface0: "#111",
      surface1: "#161616",
      surfaceWorkspace: "#0a0a0a",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#333",
      accent: "#2563eb",
    },
  },
  clientRef: { current: { id: "client" } as unknown },
  callFigma: vi.fn(),
  draws: [] as DrawOptions[],
}));

interface DrawOptions {
  imageForRef: (ref: string) => HTMLImageElement | null;
  fallbackForNode: (id: string) => HTMLImageElement | null;
  fontAvailable: (family: string, style: string) => boolean;
  onMissing: (missing: {
    fallbackNodeIds: string[];
    imageRefs: string[];
    fonts: { family: string; style: string }[];
  }) => void;
}

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (component: unknown) => component,
  useUnistyles: () => ({ theme }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => clientRef.current,
}));
vi.mock("./figma-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./figma-api")>()),
  callFigma,
}));
// The renderer contract is W9's; here it only records the options FrameContent hands it so the
// asset fetch/decode/repaint loop can be driven from the test.
vi.mock("@/figma/renderer", () => ({
  createFigmaRenderer: () => ({
    draw: (_ctx: unknown, _root: unknown, options: DrawOptions) => {
      draws.push(options);
    },
  }),
}));

import { FrameContent } from "./frame-content";
import { PrototypeAssetScopeProvider } from "./asset-scope";
import { assetScopeKey, peekAssetScope } from "./asset-store";

// Parent review: assets must be owned by the ACTIVE player snapshot — never a module global
// keyed by fileKey alone. This exercises the real provider → FrameContent → store chain.

const file = { serverId: "s1", fileKey: "fk1" };

function png(ref: string): [string, FigmaBytes] {
  return [ref, { mimeType: "image/png", dataBase64: `QUJD-${ref}` }];
}

/** Serves every imageFills/render ask with deterministic bytes so decode paths are exercisable. */
function serveAssets(): void {
  callFigma.mockImplementation(async (_client: unknown, _type: string, params: unknown) => {
    const { imageRefs, ids } = (params ?? {}) as { imageRefs?: string[]; ids?: string[] };
    const keys = [...(imageRefs ?? []), ...(ids ?? [])];
    return { images: Object.fromEntries(keys.map(png)) };
  });
}

function frameRoot(withText: boolean): FigmaNode {
  const children: FigmaNode[] = [
    {
      id: "1:2",
      name: "Photo",
      type: "RECTANGLE",
      absoluteBoundingBox: { x: 10, y: 10, width: 100, height: 100 },
    },
  ];
  if (withText) {
    children.push({
      id: "1:3",
      name: "Headline",
      type: "TEXT",
      absoluteBoundingBox: { x: 10, y: 120, width: 200, height: 24 },
      characters: "Hello",
      style: { fontFamily: "Roboto", fontSize: 16 },
    } as FigmaNode);
  }
  return {
    id: "1:1",
    name: "Home",
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 600 },
    children,
  };
}

let createdImages: HTMLImageElement[] = [];

function renderPlayer(version = "v1", withText = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <PrototypeAssetScopeProvider file={file} version={version}>
        <FrameContent file={file} root={frameRoot(withText)} scale={1} />
      </PrototypeAssetScopeProvider>,
    );
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** Paint: wait for the live scope + settled fonts, then the next recorded draw. */
async function nextDraw(baseline: number) {
  settleGoogleStylesheet();
  await waitFor(() => expect(draws.length).toBeGreaterThan(baseline));
  return draws[draws.length - 1];
}

async function firstDraw() {
  return nextDraw(0);
}

function settleGoogleStylesheet(): void {
  for (const link of document.head.querySelectorAll("link")) {
    act(() => {
      link.dispatchEvent(new Event("load"));
    });
  }
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clientRef.current = { id: "client" };
  callFigma.mockReset();
  draws.length = 0;
  createdImages = [];
  const RealImage = globalThis.Image;
  vi.stubGlobal(
    "Image",
    class TrackedImage extends RealImage {
      constructor() {
        super();
        createdImages.push(this as HTMLImageElement);
      }
    },
  );
  // jsdom has no canvas 2D backend and no FontFaceSet: give the draw path a context and make
  // Google-served families "already loaded" so the gate short-circuits them.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      check: (font: string) => font.includes("Roboto"),
      ready: Promise.resolve(),
      add: vi.fn(),
      delete: vi.fn(),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "fonts");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("FrameContent asset scope lifecycle", () => {
  it("waits for the player scope before it paints anything", async () => {
    const view = renderPlayer("v1", true);
    // The provider retains the store in an effect; the canvas paints once it is live and the
    // file's fonts are settled (no earlier, to keep TEXT off the generic stack). Settling the
    // stylesheet is async, so no draw has happened yet.
    expect(draws.length).toBe(0);
    await firstDraw();
    expect(view.container.querySelector("canvas")).not.toBeNull();
    view.unmount();
  });

  it("fetches missing fills through the retained scope, decodes, and repaints", async () => {
    serveAssets();
    const view = renderPlayer("v1");
    const draw = await firstDraw();

    act(() => {
      draw.onMissing({ imageRefs: ["ref-a"], fallbackNodeIds: [], fonts: [] });
    });
    await waitFor(() =>
      expect(callFigma).toHaveBeenCalledWith(expect.anything(), "figma.file.imageFills.request", {
        fileKey: "fk1",
        imageRefs: ["ref-a"],
      }),
    );
    // jsdom never fires load on an Image: settle it by hand, then the store notifies and the
    // canvas repaints WITH the decoded bytes.
    await waitFor(() => expect(createdImages.length).toBe(1));
    act(() => {
      createdImages[0].dispatchEvent(new Event("load"));
    });
    await waitFor(() => expect(draws.length).toBeGreaterThan(1));
    expect(draws[1].imageForRef("ref-a")).toBe(createdImages[0]);

    // The claim dedupes: a second ask for the same asset re-issues no fetch.
    const fetchCount = callFigma.mock.calls.length;
    act(() => {
      draws[1].onMissing({ imageRefs: ["ref-a"], fallbackNodeIds: [], fonts: [] });
    });
    expect(callFigma.mock.calls.length).toBe(fetchCount);
    view.unmount();
  });

  it("closing the player releases every byte, stylesheet, and font of the snapshot", async () => {
    serveAssets();
    const view = renderPlayer("v1", true);
    const draw = await firstDraw();
    act(() => {
      draw.onMissing({ imageRefs: ["ref-a"], fallbackNodeIds: ["1:2"], fonts: [] });
    });
    await waitFor(() => expect(createdImages.length).toBe(2));
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
    expect(store).toBeDefined();
    view.unmount();

    // RAM rule: the closed player keeps nothing — no bytes, no listeners, no injected CSS, and
    // the late decode/RPC callbacks drop instead of reviving the cleared store.
    expect(store?.disposed).toBe(true);
    expect(store?.get("fill|ref-a")).toBeUndefined();
    expect(store?.get("raster|1:2")).toBeUndefined();
    expect(peekAssetScope(assetScopeKey("s1", "fk1", "v1"))).toBeUndefined();
    expect(document.head.querySelector("link[href*='fonts.googleapis.com']")).toBeNull();
    act(() => {
      createdImages[0].dispatchEvent(new Event("load"));
    });
    expect(store?.get("fill|ref-a")).toBeUndefined();
  });

  it("a reopened player refetches instead of reading stale bytes", async () => {
    serveAssets();
    const first = renderPlayer("v1");
    const draw = await firstDraw();
    act(() => {
      draw.onMissing({ imageRefs: ["ref-a"], fallbackNodeIds: [], fonts: [] });
    });
    await waitFor(() => expect(createdImages.length).toBe(1));
    first.unmount();
    expect(
      callFigma.mock.calls.filter(([, type]) => type === "figma.file.imageFills.request"),
    ).toHaveLength(1);

    const second = renderPlayer("v1");
    const draw2 = await nextDraw(draws.length);
    expect(draw2.imageForRef("ref-a")).toBeNull(); // nothing survived the close
    act(() => {
      draw2.onMissing({ imageRefs: ["ref-a"], fallbackNodeIds: [], fonts: [] });
    });
    await waitFor(() => expect(createdImages.length).toBe(2));
    second.unmount();
  });

  it("keys the scope by file and version: another snapshot cannot paint these bytes", async () => {
    serveAssets();
    const v1 = renderPlayer("v1");
    const draw = await firstDraw();
    act(() => {
      draw.onMissing({ imageRefs: ["ref-a"], fallbackNodeIds: [], fonts: [] });
    });
    await waitFor(() => expect(createdImages.length).toBe(1));
    act(() => {
      createdImages[0].dispatchEvent(new Event("load"));
    });

    // Same file, pinned to another version: the v1 fill is invisible to the v2 scope, which
    // must fetch its own before it can paint the asset.
    const v2 = renderPlayer("v2");
    const v2Draw = await nextDraw(draws.length);
    expect(v2Draw.imageForRef("ref-a")).toBeNull();
    act(() => {
      v2Draw.onMissing({ imageRefs: ["ref-a"], fallbackNodeIds: [], fonts: [] });
    });
    await waitFor(() => expect(createdImages.length).toBe(2));
    v1.unmount();
    v2.unmount();
  });

  it("never draws through a disposed scope after the host goes away mid-fetch", async () => {
    let resolveFills: ((value: { images: Record<string, FigmaBytes> }) => void) | null = null;
    callFigma.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFills = resolve as (value: { images: Record<string, FigmaBytes> }) => void;
        }),
    );
    const view = renderPlayer("v1");
    const draw = await firstDraw();
    act(() => {
      draw.onMissing({ imageRefs: ["ref-late"], fallbackNodeIds: [], fonts: [] });
    });
    view.unmount();
    await act(async () => {
      resolveFills?.({ images: { "ref-late": { mimeType: "image/png", dataBase64: "QQ==" } } });
      await Promise.resolve();
    });
    expect(peekAssetScope(assetScopeKey("s1", "fk1", "v1"))).toBeUndefined();
    expect(draws.every((d) => d.imageForRef("ref-late") === null)).toBe(true);
  });
});
