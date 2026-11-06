/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { FigmaBytes, FigmaNode } from "@jagentdesk/protocol/figma/rpc-schemas";

const { theme, clientRef, callFigma, draws, missingByRoot } = vi.hoisted(() => ({
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
      imageRefs: string[];
      fonts: { family: string; style: string }[];
      cachedImageRefs: string[];
    }
  >(),
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
    imageRefs: report.imageRefs ?? [],
    fonts: report.fonts ?? [],
    cachedImageRefs: report.cachedImageRefs ?? [],
  });
}

function renderPlayer(version = "v1", withText = false, root?: FigmaNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const rootNode = createRoot(container);
  const draw = (node: FigmaNode, atVersion = version) =>
    rootNode.render(
      <PrototypeAssetScopeProvider file={file} version={atVersion}>
        <FrameContent file={file} root={node} scale={1} />
      </PrototypeAssetScopeProvider>,
    );
  act(() => draw(root ?? frameRoot(withText)));
  const view = {
    container,
    rerender: (node: FigmaNode, atVersion?: string) => act(() => draw(node, atVersion)),
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
});
