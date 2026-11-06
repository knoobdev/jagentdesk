/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { FigmaBytes, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";

const { theme, clientRef, callFigma, draws, missingByRoot, fidelityRef } = vi.hoisted(() => ({
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
  missingByRoot: new Map<
    string,
    {
      fallbackNodeIds: string[];
      textFallbackNodeIds?: string[];
      imageRefs: string[];
      fonts: { family: string; style: string }[];
      cachedImageRefs: string[];
    }
  >(),
  fidelityRef: { current: false },
}));

interface DrawOptions {
  imageForRef: (ref: string) => HTMLImageElement | null;
  fallbackForNode: (
    id: string,
    nodeType?: string,
    hint?: { backgroundBlur?: boolean },
  ) => HTMLImageElement | null;
  fallbackTextUsesAbsoluteBounds?: boolean;
  fontAvailable: (family: string, style: string) => boolean;
  onMissing: (missing: {
    fallbackNodeIds: string[];
    textFallbackNodeIds?: string[];
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
// ADR-0042 quality toggle: the real module answers false in jsdom, so every existing case
// stays on the legacy wire; the fidelity describe flips this flag to exercise the quality path.
vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    fidelityRef.current && feature === "figmaRenderFidelity",
}));
vi.mock("./figma-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./figma-api")>()),
  callFigma,
}));
// The renderer contract is W9's; here it only records the options FrameContent hands it so the
// asset fetch/decode/repaint loop can be driven from the test.
vi.mock("@/figma/renderer", () => ({
  createFigmaRenderer: () => ({
    draw: (_ctx: unknown, root: unknown, options: DrawOptions) => {
      draws.push(options);
      // Mirror the real renderer: paint cached assets through the getters and report only the
      // misses, both from inside the draw pass, so claims for a new root land before the
      // component's previous-owner release effect runs.
      const report = missingByRoot.get((root as { id?: string } | null)?.id ?? "");
      if (report) {
        for (const ref of report.cachedImageRefs) options.imageForRef(ref);
        options.onMissing(report);
      }
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

interface MissingReport {
  fallbackNodeIds: string[];
  /** Font-missing TEXT ids from the renderer (ADR-0042): these route to the outlined-SVG cache. */
  textFallbackNodeIds?: string[];
  imageRefs: string[];
  fonts: { family: string; style: string }[];
  /** Assets this frame PAINTS from cache — the real renderer reads them mid-draw via the
   * getters and only reports what comes back empty. That read is the sole owner-attach that
   * keeps a cached asset alive after the owner that originally fetched it releases. */
  cachedImageRefs: string[];
}

// The REAL renderer reports missing assets from inside `draw`; tests that exercise the
// claim-before-release ordering register what each root asks for, and the mock replays it.
function serveMissing(rootId: string, report: Partial<MissingReport>): void {
  missingByRoot.set(rootId, {
    fallbackNodeIds: report.fallbackNodeIds ?? [],
    textFallbackNodeIds: report.textFallbackNodeIds,
    imageRefs: report.imageRefs ?? [],
    fonts: report.fonts ?? [],
    cachedImageRefs: report.cachedImageRefs ?? [],
  });
}

function renderPlayer(version = "v1", withText = false, root?: FigmaNode, drawScale = 1) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const rootNode = createRoot(container);
  const draw = (node: FigmaNode, atVersion = version, scale = drawScale) =>
    rootNode.render(
      <PrototypeAssetScopeProvider file={file} version={atVersion}>
        <FrameContent file={file} root={node} scale={scale} />
      </PrototypeAssetScopeProvider>,
    );
  act(() => draw(root ?? frameRoot(withText)));
  const view = {
    container,
    rerender: (node: FigmaNode, atVersion?: string, scale?: number) =>
      act(() => draw(node, atVersion, scale ?? drawScale)),
    unmount: () => {
      act(() => rootNode.unmount());
      container.remove();
      const index = activeViews.indexOf(view);
      if (index >= 0) activeViews.splice(index, 1);
    },
  };
  activeViews.push(view);
  return view;
}

// A test that fails mid-case leaves its provider mounted; without this sweep the retained
// s1|fk1|v1 store leaks into the next case and its claims come back "already held".
const activeViews: { unmount: () => void }[] = [];

/** Paint: wait for the live scope + settled fonts, then the next recorded draw. */
async function nextDraw(baseline: number) {
  await waitFor(() => expect(draws.length).toBeGreaterThan(baseline));
  return draws[draws.length - 1];
}

async function firstDraw() {
  return nextDraw(0);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clientRef.current = { id: "client" };
  callFigma.mockReset();
  draws.length = 0;
  missingByRoot.clear();
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
  // jsdom has no canvas 2D backend and no FontFaceSet: give the draw path a context, and a
  // browser-faithful fonts stub — `check` returns TRUE even for nonexistent families (MDN
  // documents `i-dont-exist` => true), so only real registration can prove availability.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    setTransform: vi.fn(),
    clearRect: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  const faces: { family: string; weight: string; style: string; status: string }[] = [];
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      [Symbol.iterator]: () => faces[Symbol.iterator](),
      check: () => true,
      ready: Promise.resolve(),
      add: vi.fn((face: { family: string; weight: string; style: string; status: string }) => {
        faces.push(face);
      }),
      delete: vi.fn((face: { family: string; weight: string; style: string; status: string }) => {
        const index = faces.indexOf(face);
        if (index >= 0) faces.splice(index, 1);
      }),
      faces,
    },
  });
  // jsdom lacks FontFace: the stub carries a real status lifecycle so the gate's evidence
  // check (`status === "loaded"`) is exercised, not just family/weight/style matching.
  vi.stubGlobal(
    "FontFace",
    class StubFontFace {
      status = "unloaded";
      weight = "400";
      style = "normal";
      constructor(
        public family: string,
        public source: string,
        public descriptors?: { weight?: string; style?: string },
      ) {
        this.weight = descriptors?.weight ?? "400";
        this.style = descriptors?.style ?? "normal";
      }
      async load(): Promise<StubFontFace> {
        this.status = "loaded";
        return this;
      }
    },
  );
});

afterEach(() => {
  for (const stray of activeViews.splice(0)) {
    try {
      stray.unmount();
    } catch {
      // A failed case may already have torn the root down; nothing else may leak the scope.
    }
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, "fonts");
  document.head.innerHTML = "";
  document.body.innerHTML = "";
});

describe("FrameContent asset scope lifecycle", () => {
  it("paints the moment the scope is live — font loads run in parallel, never hold the first paint", async () => {
    const view = renderPlayer("v1", true);
    // W8 5d0b57396: the renderer answers TEXT with a real Figma raster while faces are in
    // flight, so there is no fontsSettled paint gate — a blocked Google stylesheet or hung
    // fonts.get can no longer leave the player blank.
    const draw = await firstDraw();
    expect(view.container.querySelector("canvas")).not.toBeNull();
    // Availability still requires real registration evidence: check()-true alone never marks
    // the family available while its load has not settled as a loaded face.
    expect(draw.fontAvailable("Roboto", "Regular")).toBe(false);
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
    expect(store?.get("raster|v1|2|png|crop|1:2")).toBeUndefined();
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

    const before = draws.length;
    const second = renderPlayer("v1");
    const draw2 = await nextDraw(before);
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
    const before = draws.length;
    const v2 = renderPlayer("v2");
    const v2Draw = await nextDraw(before);
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

// ADR-0037 memory rule, round-2 blocker: the store may not be a per-player global cache. Every
// claim belongs to a stage owner (one FrameContent instance drawing one root), and navigating
// WITHIN an open player must free the previous root's assets while simultaneously active
// owners keep whatever they share. Late settles of removed owners drop.
function navRoot(id: string): FigmaNode {
  return {
    id,
    name: `Frame ${id}`,
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 600 },
    children: [],
  };
}

describe("FrameContent per-owner asset lifetime", () => {
  it("navigating many image frames with ONE player mounted releases the previous assets and keeps shared ones", async () => {
    serveAssets();
    serveMissing("A:1", { imageRefs: ["ref-a", "ref-shared"] });
    // B paints ref-shared from the cache the A owners fetched: the real renderer only reports
    // what the getters MISS, so B never claims it through onMissing — the cache-HIT attach in
    // the getter is the only thing that can keep it alive past A's release.
    serveMissing("B:1", { imageRefs: ["ref-b"], cachedImageRefs: ["ref-shared"] });
    const view = renderPlayer("v1", false, navRoot("A:1"));
    await waitFor(() =>
      expect(callFigma).toHaveBeenCalledWith(
        expect.anything(),
        "figma.file.imageFills.request",
        expect.objectContaining({ imageRefs: expect.arrayContaining(["ref-a", "ref-shared"]) }),
      ),
    );
    await waitFor(() => expect(createdImages.length).toBe(2));
    act(() => {
      for (const image of createdImages) image.dispatchEvent(new Event("load"));
    });
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    expect(store.isHeld("fill|ref-a")).toBe(true);
    expect(store.isHeld("fill|ref-shared")).toBe(true);

    // Reused FrameContent instance, new root: claims land during the draw pass, and the
    // previous root's owner is released in the same commit — after the new claims, so the
    // shared asset never drops.
    view.rerender(navRoot("B:1"));
    await waitFor(() =>
      expect(callFigma).toHaveBeenCalledWith(
        expect.anything(),
        "figma.file.imageFills.request",
        expect.objectContaining({ imageRefs: ["ref-b"] }),
      ),
    );
    // B paints the shared asset straight from the cache (its report to onMissing never names
    // it); that hit is the attach that keeps it alive past A's release.
    const bDraw = draws[draws.length - 1];
    expect(bDraw.imageForRef("ref-shared")).not.toBeNull();
    expect(store.isHeld("fill|ref-a")).toBe(false); // previous frame's private asset released
    expect(store.isHeld("fill|ref-shared")).toBe(true); // still owned by the active frame
    await waitFor(() => expect(createdImages.length).toBe(3));
    // ref-shared was fetched ONCE for both owners — sharing never re-paid the daemon.
    const fillRequests = callFigma.mock.calls
      .filter(([, type]) => type === "figma.file.imageFills.request")
      .flatMap(([, , params]) => (params as { imageRefs: string[] }).imageRefs);
    expect(fillRequests.filter((ref) => ref === "ref-shared")).toHaveLength(1);

    // Closing releases what the current root still held.
    view.unmount();
    expect(store.isHeld("fill|ref-shared")).toBe(false);
    expect(store.isHeld("fill|ref-b")).toBe(false);
  });

  it("drops the late completion of an owner removed by navigation", async () => {
    let resolveLate: ((value: { images: Record<string, FigmaBytes> }) => void) | null = null;
    callFigma.mockImplementation((_client: unknown, type: string) => {
      if (type === "figma.file.imageFills.request")
        return new Promise((resolve) => {
          resolveLate = resolve as (value: { images: Record<string, FigmaBytes> }) => void;
        });
      return Promise.resolve({ images: {} });
    });
    serveMissing("A:1", { imageRefs: ["ref-late"] });
    serveMissing("B:1", { fallbackNodeIds: ["B:2"] });
    const view = renderPlayer("v1", false, navRoot("A:1"));
    await waitFor(() =>
      expect(callFigma).toHaveBeenCalledWith(
        expect.anything(),
        "figma.file.imageFills.request",
        expect.objectContaining({ imageRefs: ["ref-late"] }),
      ),
    );
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;

    // Navigate away, THEN the held response lands: it must drop, not resurrect the entry.
    view.rerender(navRoot("B:1"));
    expect(store.isHeld("fill|ref-late")).toBe(false);
    await act(async () => {
      resolveLate?.({ images: { "ref-late": { mimeType: "image/png", dataBase64: "QQ==" } } });
      await Promise.resolve();
    });
    expect(store.isHeld("fill|ref-late")).toBe(false);
    view.unmount();
  });

  it("pins the snapshot version on raster render requests (blocker 3)", async () => {
    serveAssets();
    const view = renderPlayer("v7");
    const draw = await firstDraw();
    act(() => {
      draw.onMissing({ imageRefs: [], fallbackNodeIds: ["1:2"], fonts: [] });
    });
    await waitFor(() =>
      expect(callFigma).toHaveBeenCalledWith(expect.anything(), "figma.file.render.request", {
        fileKey: "fk1",
        ids: ["1:2"],
        scale: 2,
        version: "v7",
      }),
    );
    // imageFills stays content-addressed (imageRefs ARE the content key): no version there.
    act(() => {
      draw.onMissing({ imageRefs: ["ref-a"], fallbackNodeIds: [], fonts: [] });
    });
    await waitFor(() =>
      expect(callFigma).toHaveBeenCalledWith(
        expect.anything(),
        "figma.file.imageFills.request",
        expect.objectContaining({ imageRefs: ["ref-a"] }),
      ),
    );
    const fillParams = callFigma.mock.calls.find(
      ([, type]) => type === "figma.file.imageFills.request",
    )?.[2] as Record<string, unknown>;
    expect(fillParams).not.toHaveProperty("version");
    view.unmount();
  });

  it("a version switch under an open player cannot paint or fetch through the retired snapshot", async () => {
    serveAssets();
    serveMissing("A:1", { imageRefs: ["ref-a"] });
    const view = renderPlayer("v1", false, navRoot("A:1"));
    await waitFor(() => expect(createdImages.length).toBe(1));
    act(() => {
      createdImages[0].dispatchEvent(new Event("load"));
    });
    const v1Store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    expect(v1Store.isHeld("fill|ref-a")).toBe(true);

    // Re-key the live provider to another snapshot. The handle only swaps inside the effect,
    // so WITHOUT the provider's identity gate the tree would get one render on the retired
    // v1 scope; gated by `handle.key === currentKey` + client identity, the old scope is
    // treated as absent and nothing draws or claims through the previous file's bytes.
    view.rerender(navRoot("A:1"), "v2");
    const askCount = () =>
      callFigma.mock.calls.filter(
        ([, type, params]) =>
          type === "figma.file.imageFills.request" &&
          (params as { imageRefs?: string[] }).imageRefs?.includes("ref-a"),
      ).length;

    await waitFor(() => expect(peekAssetScope(assetScopeKey("s1", "fk1", "v2"))).toBeDefined());
    expect(v1Store.disposed).toBe(true); // provider cleanup released the retired snapshot
    // The v2 frame fetches its OWN copy: v1 bytes were never handed to a v2 draw.
    await waitFor(() => expect(askCount()).toBe(2));
    expect(v1Store.get("fill|ref-a")).toBeUndefined();
    expect(draws[draws.length - 1]).toBeDefined();
    view.unmount();
  });
});

// W8 integration blocker: unavailable TEXT now rasterizes through figma.file.render, and BOTH
// asset RPCs cap the wire at 20 ids (rpc-schemas.ts:512-525). A normal frame with >20 TEXT
// nodes produced an invalid request and a blank canvas. Chunking must never drop a claimed id,
// every raster chunk must pin the scope version, and omitted/rejected responses must settle
// failed — never left in "loading", never endlessly repainted or retried.
describe("FrameContent wire batch boundaries (20 per request)", () => {
  it("chunks 45 fills + 45 rasters into 20/20/5 per path, pins the version on every raster batch, and settles every id", async () => {
    serveAssets();
    const fills = Array.from({ length: 45 }, (_, i) => `ref-fill-${i}`);
    const rasters = Array.from({ length: 45 }, (_, i) => `W:${i}`);
    serveMissing("W:1", { imageRefs: fills, fallbackNodeIds: rasters });
    const view = renderPlayer("v1", false, navRoot("W:1"));
    // 90 decodes started: no chunk dropped an id, and the sizes are exactly 20/20/5 per path.
    await waitFor(() => expect(createdImages.length).toBe(90));
    const paramsBy = (type: string) =>
      callFigma.mock.calls
        .filter(([, t]) => t === type)
        .map(([, , p]) => p as { imageRefs?: string[]; ids?: string[]; version?: string });
    const fillCalls = paramsBy("figma.file.imageFills.request");
    const rasterCalls = paramsBy("figma.file.render.request");
    expect(fillCalls.map((c) => c.imageRefs?.length)).toEqual([20, 20, 5]);
    expect(rasterCalls.map((c) => c.ids?.length)).toEqual([20, 20, 5]);
    // Each claimed id requested EXACTLY once, in claim order — chunking never loses one.
    expect(fillCalls.flatMap((c) => c.imageRefs ?? [])).toEqual(fills);
    expect(rasterCalls.flatMap((c) => c.ids ?? [])).toEqual(rasters);
    // Every render batch carries the SAME pinned scope version (and imageFills stays versionless).
    expect(rasterCalls.every((c) => c.version === "v1")).toBe(true);
    expect(fillCalls.every((c) => !("version" in c))).toBe(true);

    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    act(() => {
      for (const image of createdImages) image.dispatchEvent(new Event("load"));
    });
    await waitFor(() => expect(draws.length).toBeGreaterThan(1));
    for (const ref of fills) expect(store.get(`fill|${ref}`)?.status).toBe("ready");
    for (const id of rasters) expect(store.get(`raster|v1|2|png|crop|${id}`)?.status).toBe("ready");
    view.unmount();
  });

  it("settles omitted ids and rejected batches as failed — no stuck loading, no retry, no repaint storm", async () => {
    let fillCalls = 0;
    let rasterCalls = 0;
    callFigma.mockImplementation((_client: unknown, type: string, params: unknown) => {
      const { imageRefs } = (params ?? {}) as { imageRefs?: string[] };
      if (type === "figma.file.imageFills.request") {
        fillCalls += 1;
        // First chunk: bytes for all but the LAST ref (the daemon omits it). Second chunk: RPC fails.
        if (fillCalls === 1) {
          const returned = (imageRefs ?? []).slice(0, -1);
          return Promise.resolve({
            images: Object.fromEntries(returned.map(png)),
          });
        }
        return Promise.reject(new Error("fills boom"));
      }
      rasterCalls += 1;
      return Promise.reject(new Error("render boom")); // every raster batch fails
    });
    const fills = Array.from({ length: 25 }, (_, i) => `ref-fill-${i}`); // 20 + 5
    const rasters = Array.from({ length: 25 }, (_, i) => `X:${i}`);
    serveMissing("X:1", { imageRefs: fills, fallbackNodeIds: rasters });
    const view = renderPlayer("v9", false, navRoot("X:1"));
    // Every claim settles one way or the other — rejected/omitted claims fail immediately
    // (the old code left unreturned claims in "loading" forever); returned bytes legitimately
    // stay loading until the decode finishes, which the harness drives by hand.
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v9"))!;
    await waitFor(() => {
      for (const id of rasters)
        expect(store.get(`raster|v9|2|png|crop|${id}`)?.status).toBe("failed");
      expect(store.get("fill|ref-fill-19")?.status).toBe("failed"); // omitted from chunk 1's response
      expect(store.get("fill|ref-fill-24")?.status).toBe("failed"); // chunk 2's RPC rejected
    });
    for (const ref of fills.slice(0, 19)) expect(store.get(`fill|${ref}`)?.status).toBe("loading");
    // Continued past the failure: the rejected chunk did not abort the other path's chunks.
    expect(fillCalls).toBe(2);
    expect(rasterCalls).toBe(2);
    expect(createdImages).toHaveLength(19); // only returned bytes start a decode
    act(() => {
      for (const image of createdImages) image.dispatchEvent(new Event("load"));
    });
    await waitFor(() => expect(store.get("fill|ref-fill-0")?.status).toBe("ready"));
    for (const ref of fills.slice(0, 19)) expect(store.get(`fill|${ref}`)?.status).toBe("ready");
    // Settled claims do not re-arm: after the settle-triggered repaints drain, further draws
    // re-report the same misses, claim() sees the existing records, and nothing re-requests.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const drawsSettled = draws.length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(draws.length).toBe(drawsSettled);
    expect(fillCalls).toBe(2);
    expect(rasterCalls).toBe(2);
    view.unmount();
  });
});

// Round-2 blocker 2: an unavailable/blocked font must not create a rerender/network/CSS loop.
// The bounded gate singleflights loads, appends each href once, remembers failures for its
// lifetime, and availability requires REAL registration — `fonts.check` true proves nothing.
function textRoot(id: string, family: string, fontStyle = "Regular"): FigmaNode {
  return {
    id,
    name: `Text ${id}`,
    type: "FRAME",
    absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 600 },
    children: [
      {
        id: `${id}-t1`,
        name: "Headline",
        type: "TEXT",
        absoluteBoundingBox: { x: 10, y: 10, width: 200, height: 24 },
        characters: "Hello",
        style: { fontFamily: family, fontStyle, fontSize: 16 },
      } as FigmaNode,
    ],
  };
}

function fontsGetCalls(): unknown[][] {
  return callFigma.mock.calls.filter(([, type]) => type === "figma.fonts.get.request");
}

describe("FrameContent bounded font behavior", () => {
  it("a nonexistent font with check()-true settles into the raster fallback with bounded renders, requests, and CSS", async () => {
    callFigma.mockImplementation(async (_client: unknown, type: string) => {
      if (type === "figma.fonts.get.request") return { font: null }; // daemon has nothing
      return { images: {} };
    });
    serveMissing("T:1", { fonts: [{ family: "Zorbal Missing", style: "Regular" }] });
    const view = renderPlayer("v1", false, textRoot("T:1", "Zorbal Missing"));
    const draw = await firstDraw();

    // The real evidence rule: check() answers true for ANY family (browser fact), yet the
    // renderer is told the face is NOT available — so W8's raster fallback path takes over.
    expect(draw.fontAvailable("Zorbal Missing", "Regular")).toBe(false);

    // Repeated draws/reports while the player stays open must not multiply work: exactly one
    // daemon attempt, no stylesheet (not a Google family), and a stable render/draw count.
    const drawsAfterFirst = draws.length;
    for (let i = 0; i < 5; i += 1)
      draw.onMissing({
        imageRefs: [],
        fallbackNodeIds: [],
        fonts: [{ family: "Zorbal Missing", style: "Regular" }],
      });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(fontsGetCalls()).toHaveLength(1);
    expect(document.head.querySelectorAll("link")).toHaveLength(0);
    expect(draws.length).toBe(drawsAfterFirst); // no repaint loop from the failed font
    view.unmount();
  });

  it("a font load that never resolves still runs the renderer and raster path — the player does not wait on fonts", async () => {
    callFigma.mockImplementation((_client: unknown, type: string, params: unknown) => {
      if (type === "figma.fonts.get.request") return new Promise(() => {}); // never settles
      const { imageRefs, ids } = (params ?? {}) as { imageRefs?: string[]; ids?: string[] };
      return Promise.resolve({
        images: Object.fromEntries([...(imageRefs ?? []), ...(ids ?? [])].map(png)),
      });
    });
    serveMissing("S:1", {
      fallbackNodeIds: ["S:2"],
      fonts: [{ family: "Zorbal Held", style: "Regular" }],
    });
    const view = renderPlayer("v1", false, textRoot("S:1", "Zorbal Held"));
    // First pass paints immediately even though the face is still loading: the missing
    // fallback raster is requested and, once decoded, repaints through the normal asset path.
    await firstDraw();
    await waitFor(() =>
      expect(callFigma).toHaveBeenCalledWith(expect.anything(), "figma.file.render.request", {
        fileKey: "fk1",
        ids: ["S:2"],
        scale: 2,
        version: "v1",
      }),
    );
    await waitFor(() => expect(createdImages.length).toBe(1));
    act(() => {
      createdImages[0].dispatchEvent(new Event("load"));
    });
    await waitFor(() => expect(draws.length).toBeGreaterThan(1));
    expect(draws[draws.length - 1].fallbackForNode("S:2")).not.toBeNull();
    // Font STILL unresolved: one attempt only, no re-arm, and availability stays unproven.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(fontsGetCalls()).toHaveLength(1);
    const drawsWithHeldFont = draws.length;
    expect(draws[draws.length - 1].fontAvailable("Zorbal Held", "Regular")).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(draws.length).toBe(drawsWithHeldFont);
    view.unmount();
  });

  it("a slow font singleflights every claim to ONE request and repaints once when the face lands", async () => {
    let resolveFont: ((value: { font: FigmaBytes | null }) => void) | null = null;
    callFigma.mockImplementation((_client: unknown, type: string) => {
      if (type === "figma.fonts.get.request")
        return new Promise((resolve) => {
          resolveFont = resolve as (value: { font: FigmaBytes | null }) => void;
        });
      return Promise.resolve({ images: {} });
    });
    serveMissing("S:1", { fonts: [{ family: "Zorbal Slow", style: "Bold" }] });
    const view = renderPlayer("v1", false, textRoot("S:1", "Zorbal Slow", "Bold"));
    const draw = await firstDraw(); // paints now — the held face does not gate the pass
    // The root's preload claim and every draw-pass report ride the SAME in-flight promise.
    draw.onMissing({
      imageRefs: [],
      fallbackNodeIds: [],
      fonts: [{ family: "Zorbal Slow", style: "Bold" }],
    });
    draw.onMissing({
      imageRefs: [],
      fallbackNodeIds: [],
      fonts: [{ family: "Zorbal Slow", style: "Bold" }],
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fontsGetCalls()).toHaveLength(1);
    // The face arrives: registration (status "loaded") is the evidence that flips availability,
    // and ONLY the claims pending at claim time repaint — exactly once, then the loop settles.
    await act(async () => {
      resolveFont?.({ font: { mimeType: "font/woff2", dataBase64: "Rk9P" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const drawsAfterFont = draws.length;
    expect(drawsAfterFont).toBe(2);
    const latest = draws[draws.length - 1];
    expect(latest.fontAvailable("Zorbal Slow", "Bold")).toBe(true);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(draws.length).toBe(drawsAfterFont); // settled record never re-arms
    expect(fontsGetCalls()).toHaveLength(1);
    // Closing unregisters the face the last active owner held.
    const fontsSet = document.fonts as unknown as {
      delete: ReturnType<typeof vi.fn>;
      faces: unknown[];
    };
    view.unmount();
    expect(fontsSet.delete).toHaveBeenCalledTimes(1);
    expect(fontsSet.faces).toHaveLength(0);
  });

  // spec 32.5.1 contract: production player fonts come from the daemon's CACHED bytes, not the
  // browser's Google Fonts stylesheet network. A well-known Google family must behave exactly
  // like a custom one — `figma.fonts.get` answers, and no <link> is ever appended.
  it("serves the known Google family Inter from daemon bytes with no browser <link>, repaints once, and unregisters on release", async () => {
    let resolveFont: ((value: { font: FigmaBytes | null }) => void) | null = null;
    callFigma.mockImplementation((_client: unknown, type: string) => {
      if (type === "figma.fonts.get.request")
        return new Promise((resolve) => {
          resolveFont = resolve as (value: { font: FigmaBytes | null }) => void;
        });
      return Promise.resolve({ images: {} });
    });
    serveMissing("I:1", { fonts: [{ family: "Inter", style: "Regular" }] });
    const view = renderPlayer("v1", false, textRoot("I:1", "Inter"));
    const draw = await firstDraw(); // text paints through the raster fallback while loading
    expect(draw.fontAvailable("Inter", "Regular")).toBe(false);
    // Inter is the canonical Google family: it goes to the daemon, NOT a fonts.googleapis.com
    // <link>, so the player needs zero third-party CSS network access to get its bytes.
    expect(fontsGetCalls()).toHaveLength(1);
    expect(fontsGetCalls()[0][2]).toEqual({ family: "Inter", style: "Regular" });
    expect(document.head.querySelectorAll("link")).toHaveLength(0);
    // The daemon bytes land: real registration flips availability and repaints exactly once.
    await act(async () => {
      resolveFont?.({ font: { mimeType: "font/woff2", dataBase64: "Rk9P" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const drawsAfterFont = draws.length;
    expect(drawsAfterFont).toBe(2);
    expect(draws[drawsAfterFont - 1].fontAvailable("Inter", "Regular")).toBe(true);
    const fontsSet = document.fonts as unknown as {
      delete: ReturnType<typeof vi.fn>;
      faces: unknown[];
    };
    view.unmount();
    expect(fontsSet.delete).toHaveBeenCalledTimes(1);
    expect(fontsSet.faces).toHaveLength(0);
  });

  it("an offline daemon (rejected fonts.get) settles bounded and still paints through the raster fallback", async () => {
    callFigma.mockImplementation(async (_client: unknown, type: string) => {
      if (type === "figma.fonts.get.request") throw new Error("offline");
      return { images: {} };
    });
    serveMissing("O:1", { fonts: [{ family: "Inter", style: "Regular" }] });
    const view = renderPlayer("v1", false, textRoot("O:1", "Inter"));
    const draw = await firstDraw();
    // A rejected fetch settles like missing bytes — bounded to ONE attempt (negative cache) and
    // never faked available — and the frame still painted: W8's raster fallback carries the text.
    expect(draw.fontAvailable("Inter", "Regular")).toBe(false);
    for (let i = 0; i < 5; i += 1)
      draw.onMissing({
        imageRefs: [],
        fallbackNodeIds: [],
        fonts: [{ family: "Inter", style: "Regular" }],
      });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(fontsGetCalls()).toHaveLength(1);
    expect(document.head.querySelectorAll("link")).toHaveLength(0);
    view.unmount();
  });
});

// ── ADR-0042 quality path (root review: same three bug classes as the canvas hook) ─────────
// The store-side twin of the fidelity regressions: ONE route helper drives reads and fetches,
// the SVG→PNG downgrade persists independently of the SVG entry (no ping-pong), each rung is
// claimed exactly once (finite lattice), and a ready exact fallback makes the failed font
// irrelevant to what paints. Faking the capability through the host-features mock is the only
// switch; the legacy describes above already pin the pre-capability wire.
describe("FrameContent ADR-0042 quality path", () => {
  const SVG_KEY = "raster|v1|1|svg|absolute|1:3";
  const PNG_ABS_3 = "raster|v1|3|png|absolute|1:3";
  const PNG_ABS_4 = "raster|v1|4|png|absolute|1:3";

  function pngCalls(): Array<Record<string, unknown>> {
    return callFigma.mock.calls
      .filter((c) => c[1] === "figma.file.render.request")
      .map((c) => c[2] as Record<string, unknown>);
  }

  /** Raster calls for one format (and optional rung) — loop-based, so waitFor callbacks
   *  never stack a second filter arrow onto the lint depth budget. */
  function pngCallsWhere(format: string, scale?: number): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const c of pngCalls())
      if (c.format === format && (scale === undefined || c.scale === scale)) out.push(c);
    return out;
  }

  /** SVG asks fail terminal; PNG asks answer with decodable bytes. */
  function serveSvgFailingPngOk(): void {
    callFigma.mockImplementation(async (_client: unknown, type: string, params: unknown) => {
      const p = (params ?? {}) as { ids?: string[]; imageRefs?: string[]; format?: string };
      if (type !== "figma.file.render.request") return { images: {} };
      const ids = p.ids ?? [];
      if (p.format === "svg") return { images: Object.fromEntries(ids.map((id) => [id, null])) };
      return {
        images: Object.fromEntries(
          ids.map((id) => [id, { mimeType: "image/png", dataBase64: "QUJD" }]),
        ),
      };
    });
  }

  /** Every raster class answers with bytes whose MIME matches the ask — stable "loading"
   *  (decodes) for wire-shape assertions, since jsdom never fires image load. */
  function serveRasterBytes(): void {
    callFigma.mockImplementation(async (_client: unknown, type: string, params: unknown) => {
      const p = (params ?? {}) as { ids?: string[]; imageRefs?: string[]; format?: string };
      if (type !== "figma.file.render.request") return { images: {} };
      const mimeType = p.format === "svg" ? "image/svg+xml" : "image/png";
      return {
        images: Object.fromEntries(
          (p.ids ?? []).map((id) => [id, { mimeType, dataBase64: "QUJD" }]),
        ),
      };
    });
  }

  function setDpr(value: number): void {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
  }

  /** Let queued microtasks and timer callbacks drain (store flushes + claim settles). */
  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  beforeEach(() => {
    fidelityRef.current = true;
    setDpr(2);
  });
  afterEach(() => {
    fidelityRef.current = false;
    setDpr(1);
  });

  it("an empty or whitespace-only pin never opens the quality route: exact legacy scale-2 crop wire (ADR-0042 contract)", async () => {
    serveRasterBytes();
    serveMissing("1:1", {
      fallbackNodeIds: ["1:3"],
      textFallbackNodeIds: ["1:3"],
      imageRefs: [],
      fonts: [],
      cachedImageRefs: [],
    });
    const view = renderPlayer("  ", true, undefined, 1.35);
    await firstDraw();
    await waitFor(() => expect(pngCalls()).toHaveLength(1));
    // The blank pin the daemon would refuse (handlers/content.ts checks trim()) behaves like
    // the pre-capability wire exactly: rung 2 crop PNG, no format/bounds fields on it.
    expect(pngCalls()).toEqual([{ fileKey: "fk1", ids: ["1:3"], scale: 2, version: "  " }]);
    view.unmount();
  });

  it("routes renderer-classified TEXT to svg@1@absolute and non-TEXT to the ceil(zoom·dpr) crop rung", async () => {
    serveRasterBytes();
    serveMissing("1:1", {
      fallbackNodeIds: ["1:2", "1:3"],
      textFallbackNodeIds: ["1:3"],
      imageRefs: [],
      fonts: [],
      cachedImageRefs: [],
    });
    // zoom 1.35 × dpr 2 = 2.7 → rung 3 for the non-TEXT crop class.
    const view = renderPlayer("v1", true, undefined, 1.35);
    const draw = await firstDraw();
    expect(draw.fallbackTextUsesAbsoluteBounds).toBe(true); // the renderer pairs TEXT with the layout box
    await waitFor(() => expect(pngCalls()).toHaveLength(2));
    expect(pngCalls()).toContainEqual({
      fileKey: "fk1",
      ids: ["1:3"],
      scale: 1,
      version: "v1",
      format: "svg",
      useAbsoluteBounds: true,
    });
    expect(pngCalls()).toContainEqual({
      fileKey: "fk1",
      ids: ["1:2"],
      scale: 3,
      version: "v1",
      format: "png",
    });
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    expect(store.get(SVG_KEY)?.status).toBe("loading");
    expect(store.get("raster|v1|3|png|crop|1:2")?.status).toBe("loading");
    view.unmount();
  });

  it("a terminal SVG failure downgrades once per rung: stable PNG across repeated reads, no SVG restart", async () => {
    serveSvgFailingPngOk();
    serveMissing("1:1", {
      fallbackNodeIds: ["1:3"],
      textFallbackNodeIds: ["1:3"],
      imageRefs: [],
      fonts: [],
      cachedImageRefs: [],
    });
    const view = renderPlayer("v1", true, undefined, 1.35);
    const draw = await firstDraw();
    await waitFor(() => {
      const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
      expect(store?.get(SVG_KEY)?.status).toBe("failed");
    });
    // The failed SVG entry is never pinned by a successful path — the CHANNEL is persistent,
    // so this read (and every later re-ask) routes to the absolute PNG of the current rung.
    for (let pass = 0; pass < 20; pass += 1) expect(draw.fallbackForNode("1:3", "TEXT")).toBeNull();
    await waitFor(() => expect(pngCallsWhere("png", 3)).toHaveLength(1));
    // The later onMissing reports (renderer keeps re-asking while nothing paints) must NOT
    // restart the SVG or double-fetch the PNG rung: same route helper, same claims, deduped.
    act(() => {
      draw.onMissing({
        fallbackNodeIds: ["1:3"],
        textFallbackNodeIds: ["1:3"],
        imageRefs: [],
        fonts: [],
      });
    });
    await settle();
    expect(pngCalls().filter((c) => c.format === "svg")).toHaveLength(1);
    expect(pngCalls().filter((c) => c.format === "png" && c.scale === 3)).toHaveLength(1);

    // The downgrade decodes and paints from here; attachOwner keeps it alive while used.
    const pngImage = createdImages.find((i) => (i.src ?? "").includes("image/png"));
    expect(pngImage).toBeDefined();
    act(() => {
      pngImage!.dispatchEvent(new Event("load"));
    });
    await waitFor(() => {
      const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
      expect(store?.get(PNG_ABS_3)?.status).toBe("ready");
    });
    const after = draws[draws.length - 1];
    expect(after.fallbackForNode("1:3", "TEXT")).toBeTruthy(); // paints the replacement
    view.unmount();
  });

  it("zooming after a downgrade asks the new rung exactly once and keeps the old rung's bytes", async () => {
    serveSvgFailingPngOk();
    serveMissing("1:1", {
      fallbackNodeIds: ["1:3"],
      textFallbackNodeIds: ["1:3"],
      imageRefs: [],
      fonts: [],
      cachedImageRefs: [],
    });
    const view = renderPlayer("v1", true, undefined, 1.35); // rung 3
    const draw = await firstDraw();
    await waitFor(() => {
      const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
      expect(store?.get(SVG_KEY)?.status).toBe("failed"); // the SVG attempt settled terminal
    });
    // Engage the persistent channel; rung 3 is claimed exactly once and stays loading.
    for (let pass = 0; pass < 20; pass += 1) expect(draw.fallbackForNode("1:3", "TEXT")).toBeNull();
    await waitFor(() => {
      const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
      expect(store?.get(PNG_ABS_3)?.status).toBe("loading");
    });
    const pngImg = createdImages.find((i) => (i.src ?? "").includes("image/png"));
    act(() => {
      pngImg?.dispatchEvent(new Event("load"));
    });
    await waitFor(() => {
      const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
      expect(store?.get(PNG_ABS_3)?.status).toBe("ready");
    });

    // Zoom to 2 × dpr 2 = 4 → rung 4. A FRESH rung on the persistent channel: asked once,
    // while rung 3 keeps its bytes (the ≤4-rung lattice is the finite cache, never a leak).
    view.rerender(frameRoot(true), "v1", 2);
    const draw4 = await nextDraw(draws.length - 1);
    for (let pass = 0; pass < 10; pass += 1) draw4.fallbackForNode("1:3", "TEXT");
    await waitFor(() => expect(pngCallsWhere("png", 4)).toHaveLength(1));
    expect(pngCalls().filter((c) => c.format === "svg")).toHaveLength(1); // still no SVG ping-pong
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    expect(store.get(PNG_ABS_3)?.status).toBe("ready"); // old rung retained, not overwritten
    expect(store.get(PNG_ABS_4)?.status).toBe("loading"); // new rung single-flighted
    view.unmount();
  });

  it("a ready exact fallback makes the failed font irrelevant; without it the font still settles bounded", async () => {
    // Bug-1 twin on the prototype side: the draw reports the font EVERY paint once the SVG is
    // ready (fallback ids no longer missing). That must not re-enter the fetch loop or hold a
    // loading/error state — the gate singleflights per family and remembers the failure.
    serveRasterBytes();
    serveMissing("1:1", {
      fallbackNodeIds: ["1:3"],
      textFallbackNodeIds: ["1:3"],
      imageRefs: [],
      fonts: [],
      cachedImageRefs: [],
    });
    const view = renderPlayer("v1", true); // dpr 2 × scale 1 → svg class regardless of rung here
    const draw = await firstDraw();
    await waitFor(() => {
      const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
      expect(store?.get(SVG_KEY)).toBeDefined();
    });
    const svgImage = createdImages.find((i) => (i.src ?? "").includes("image/svg+xml"));
    expect(svgImage).toBeDefined();
    act(() => {
      svgImage!.dispatchEvent(new Event("load"));
    });
    await waitFor(() => {
      const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
      expect(store?.get(SVG_KEY)?.status).toBe("ready");
    });
    // Exact replacement painting; the renderer reports the (nonexistent) font on every pass.
    expect(draw.fallbackForNode("1:3", "TEXT")).toBeTruthy();
    for (let pass = 0; pass < 3; pass += 1) {
      act(() => {
        draw.onMissing({
          fallbackNodeIds: [],
          imageRefs: [],
          fonts: [{ family: "Roboto", style: "Regular" }],
        });
      });
      await settle();
    }
    const fontsGet = callFigma.mock.calls.filter((c) => c[1] === "figma.fonts.get.request");
    expect(fontsGet.length).toBeLessThanOrEqual(1); // bounded by the gate — no repaint feedback loop
    view.unmount();
  });
});

// ── ADR-0042 backdrop BACKGROUND_BLUR exception (prototype store-side) ──────────────────────
// The player must never paint a hinted backdrop from Figma's flat per-node export above the
// proven scale: the getter's hint is the classifier, ONE route decision feeds reads and fetches,
// the store key of the capped ask is the only entry the node ever holds at that class, and the
// adaptive/TEXT classes keep their rungs. Sibling of the canvas-hook describe.
describe("FrameContent ADR-0042 backdrop BACKGROUND_BLUR cap", () => {
  function pngCalls(): Array<Record<string, unknown>> {
    return callFigma.mock.calls
      .filter((c) => c[1] === "figma.file.render.request")
      .map((c) => c[2] as Record<string, unknown>);
  }

  function pngCallsWhere(format: string, scale?: number): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const c of pngCalls())
      if (c.format === format && (scale === undefined || c.scale === scale)) out.push(c);
    return out;
  }

  /** Bytes whose base64 embeds the node id — decoded images stay attributable to their ask. */
  function serveRasterBytesById(): void {
    callFigma.mockImplementation(async (_client: unknown, type: string, params: unknown) => {
      const p = (params ?? {}) as { ids?: string[]; imageRefs?: string[]; format?: string };
      if (type !== "figma.file.render.request") return { images: {} };
      const mimeType = p.format === "svg" ? "image/svg+xml" : "image/png";
      return {
        images: Object.fromEntries(
          (p.ids ?? []).map((id) => [id, { mimeType, dataBase64: `QUJD-${id}` }]),
        ),
      };
    });
  }

  function setDpr(value: number): void {
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value });
  }

  function settleTime(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  function loadDecodeOf(id: string): HTMLImageElement | undefined {
    return createdImages.find((i) => (i.src ?? "").includes(`QUJD-${id}`));
  }

  beforeEach(() => {
    fidelityRef.current = true;
    setDpr(2);
  });
  afterEach(() => {
    fidelityRef.current = false;
    setDpr(1);
  });

  it("first paint never queues 3/4 for the hinted backdrop, siblings ride rung 4 and TEXT stays SVG", async () => {
    serveRasterBytesById();
    const view = renderPlayer("v1", true, undefined, 2.1); // dpr 2 × 2.1 = 4.2 → rung 4
    const draw = await firstDraw();
    // The real renderer's order: every fallback node passes the getter (hint included) before
    // anything is reported; the fetch side then reads the SAME classification.
    act(() => {
      draw.fallbackForNode("1:2", "RECTANGLE", { backgroundBlur: true });
      draw.fallbackForNode("1:9", "RECTANGLE");
      draw.fallbackForNode("1:3", "TEXT");
      draw.onMissing({
        fallbackNodeIds: ["1:2", "1:9", "1:3"],
        textFallbackNodeIds: ["1:3"],
        imageRefs: [],
        fonts: [],
      });
    });
    await waitFor(() => expect(pngCalls()).toHaveLength(3));
    expect(pngCallsWhere("png", 2)).toEqual([
      { fileKey: "fk1", ids: ["1:2"], scale: 2, version: "v1", format: "png" },
    ]);
    expect(pngCallsWhere("png", 4)).toEqual([
      { fileKey: "fk1", ids: ["1:9"], scale: 4, version: "v1", format: "png" },
    ]);
    expect(pngCallsWhere("svg", 1)).toEqual([
      {
        fileKey: "fk1",
        ids: ["1:3"],
        scale: 1,
        version: "v1",
        format: "svg",
        useAbsoluteBounds: true,
      },
    ]);
    // Cache identity: the backdrop holds ONLY the capped class — no phantom rung-4 claim was
    // ever made for it, and the ordinary sibling never shares the capped entry.
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    expect(store.get("raster|v1|2|png|crop|1:2")?.status).toBe("loading");
    expect(store.get("raster|v1|4|png|crop|1:2")).toBeUndefined();
    expect(store.get("raster|v1|4|png|crop|1:9")?.status).toBe("loading");
    view.unmount();
  });

  it("read and fetch share the capped cache across zoom — rising rung re-reads scale 2, never asks flat bytes", async () => {
    serveRasterBytesById();
    const view = renderPlayer("v1", true, undefined, 2.1); // rung 4 → capped fetch at 2
    const draw = await firstDraw();
    act(() => {
      draw.fallbackForNode("1:2", "RECTANGLE", { backgroundBlur: true });
      draw.onMissing({ fallbackNodeIds: ["1:2"], imageRefs: [], fonts: [] });
    });
    await waitFor(() => expect(pngCallsWhere("png", 2)).toHaveLength(1));
    const bgImage = loadDecodeOf("1:2");
    expect(bgImage).toBeDefined();
    act(() => {
      bgImage!.dispatchEvent(new Event("load"));
    });
    await waitFor(() => {
      const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"));
      expect(store?.get("raster|v1|2|png|crop|1:2")?.status).toBe("ready");
    });

    // Zoom to 3 × dpr 2 = 6 → rung 4 territory for everything else: the hinted read STILL
    // serves the capped scale-2 image and no new ask opens for the node.
    view.rerender(frameRoot(true), "v1", 3);
    const draw6 = await nextDraw(draws.length - 1);
    for (let pass = 0; pass < 5; pass += 1)
      expect(draw6.fallbackForNode("1:2", "RECTANGLE", { backgroundBlur: true })).toBeTruthy();
    act(() => {
      draw6.onMissing({ fallbackNodeIds: ["1:2"], imageRefs: [], fonts: [] });
    });
    await settleTime();
    expect(pngCalls()).toHaveLength(1); // ever — same cache for read and fetch, across zooms
    expect(pngCallsWhere("png", 4)).toHaveLength(0); // no phantom rung-4 class for the backdrop
    view.unmount();
  });

  it("an ask without the hint lifts the cap — hidden effect re-routes to the honest rung", async () => {
    serveRasterBytesById();
    const view = renderPlayer("v1", true, undefined, 2.1); // rung 4
    const draw = await firstDraw();
    act(() => {
      draw.fallbackForNode("1:2", "RECTANGLE", { backgroundBlur: true });
      draw.onMissing({ fallbackNodeIds: ["1:2"], imageRefs: [], fonts: [] });
    });
    await waitFor(() => expect(pngCallsWhere("png", 2)).toHaveLength(1));
    // Effect hidden: the node still fallbacks (another unsupported feature), WITHOUT the hint.
    act(() => {
      expect(draw.fallbackForNode("1:2", "RECTANGLE", { backgroundBlur: false })).toBeNull();
      draw.onMissing({ fallbackNodeIds: ["1:2"], imageRefs: [], fonts: [] });
    });
    await waitFor(() => expect(pngCallsWhere("png", 4)).toHaveLength(1));
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    expect(store.get("raster|v1|4|png|crop|1:2")?.status).toBe("loading");
    expect(pngCalls()).toHaveLength(2); // the cap did not linger, and the old capped entry stands
    view.unmount();
  });

  it("TEXT with a visible backdrop claims the capped absolute PNG, never an SVG — and returns to SVG once hidden", async () => {
    serveRasterBytesById();
    const view = renderPlayer("v1", true, undefined, 2.1);
    const draw = await firstDraw();
    act(() => {
      expect(draw.fallbackForNode("1:3", "TEXT", { backgroundBlur: true })).toBeNull();
      draw.onMissing({
        fallbackNodeIds: ["1:3"],
        textFallbackNodeIds: ["1:3"],
        imageRefs: [],
        fonts: [],
      });
    });
    await waitFor(() => expect(pngCallsWhere("png", 2)).toHaveLength(1));
    expect(pngCallsWhere("png", 2)[0]).toEqual({
      fileKey: "fk1",
      ids: ["1:3"],
      scale: 2,
      version: "v1",
      format: "png",
      useAbsoluteBounds: true,
    });
    expect(pngCallsWhere("svg")).toHaveLength(0); // no flat-outline ask for a backdrop node
    // Hidden: ordinary TEXT reclaims its crisp SVG route — no stale cap, no downgrade mark.
    act(() => {
      expect(draw.fallbackForNode("1:3", "TEXT")).toBeNull();
      draw.onMissing({
        fallbackNodeIds: ["1:3"],
        textFallbackNodeIds: ["1:3"],
        imageRefs: [],
        fonts: [],
      });
    });
    await waitFor(() => expect(pngCallsWhere("svg", 1)).toHaveLength(1));
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    expect(store.get("raster|v1|1|svg|absolute|1:3")?.status).toBe("loading");
    expect(store.get("raster|v1|2|png|absolute|1:3")?.status).toBe("loading"); // capped bytes retained while observed
    view.unmount();
  });

  /** Every raster class answers with null bytes — terminal failures drive the negative cache. */
  function serveNullRasters(): void {
    callFigma.mockImplementation(async (_client: unknown, type: string, params: unknown) => {
      const p = (params ?? {}) as { ids?: string[] };
      if (type !== "figma.file.render.request") return { images: {} };
      return { images: Object.fromEntries((p.ids ?? []).map((id) => [id, null])) };
    });
  }

  it("the capped class stays a finite negative cache — ten re-asks, one wire call, retry via fresh paint", async () => {
    serveNullRasters();
    const view = renderPlayer("v1", false, undefined, 2.1); // rung 4 → capped 2, terminal-failed
    const draw = await firstDraw();
    for (let pass = 0; pass < 10; pass += 1) {
      act(() => {
        expect(draw.fallbackForNode("1:2", "RECTANGLE", { backgroundBlur: true })).toBeNull();
        draw.onMissing({ fallbackNodeIds: ["1:2"], imageRefs: [], fonts: [] });
      });
      await settleTime();
    }
    // The failed entry IS the negative cache: every read attaches it, every claim dedups — no
    // refetch loop, and it never wandered into rung 3/4 while failing.
    expect(pngCalls()).toHaveLength(1);
    expect(pngCalls()[0].scale).toBe(2);
    const store = peekAssetScope(assetScopeKey("s1", "fk1", "v1"))!;
    expect(store.get("raster|v1|2|png|crop|1:2")?.status).toBe("failed");
    view.unmount();
  });
});
