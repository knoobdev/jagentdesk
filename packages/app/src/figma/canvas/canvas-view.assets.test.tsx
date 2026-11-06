/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FigmaBytes,
  FigmaFrameSummary,
  FigmaNode,
  FigmaRequestParams,
  FigmaResponseData,
} from "@jagentdesk/protocol/figma/rpc-schemas";
import { CANVAS_ID, CanvasView } from "./canvas-view";
import { FrameStore } from "./frame-store";
import { makeFrameSummary, makeNode } from "./__fixtures__/figma";
import { bytesToDataUrl } from "./assets";
import type { Camera } from "./viewport";
import { framesInViewport } from "./viewport";

// Real-hook retention boundary (spec 32.5.1, W7 design + W10's 82368e9fa): this mounts the web
// CanvasView against the REAL useFigmaAssets/ByteImageCache/FontCache — only the RPC transport,
// the DOM decoders it drives, and the renderer's draw reporting are faked. Nothing mocks the
// retention itself: the assertions are what the caches actually hold, re-ask, and drop across
// paints. Decoded hits are asserted only AFTER dispatching the fake <img> `load` event, so the
// suite passes both with 82368e9fa's ready-before-load state and W10's pending gate-ready-on-
// load fix. The wrapper's pairing/throw coverage lives in canvas-view.test.tsx.

// The app's tsconfig compiles JSX classic (expo `jsx: "react-native"`), so component modules
// under test reference a module-global React. Setup does not define it.
const globalWithReact = globalThis as typeof globalThis & { React?: typeof React };
globalWithReact.React ??= React;

interface PaintOp {
  method: string;
  args: unknown[];
}

/** What one mock-draw pass asked the real caches for, and what it got back. */
interface DrawEntry {
  nodeId: string;
  imageRefsAsked: string[];
  fallbackAsked: string[];
  fontAsks: string[];
  hits: Array<{ ref: string; image: CanvasImageSource }>;
}

interface MissingReport {
  fallbackNodeIds: string[];
  imageRefs: string[];
  fonts: Array<{ family: string; style: string }>;
}

interface DrawOptions {
  imageForRef: (ref: string) => CanvasImageSource | null;
  fallbackForNode: (nodeId: string) => CanvasImageSource | null;
  fontAvailable: (family: string, style: string) => boolean;
  onMissing?: (missing: MissingReport) => void;
}

// A node shape for the draw mock's walk: image fills, TEXT font names, and a marker asking the
// renderer's fallback path. The real renderer reads the same fields through the protocol node.
interface DrawableNode {
  id: string;
  children?: DrawableNode[];
  fills?: Array<{ type?: string; imageRef?: string }>;
  fontName?: { family?: string; style?: string };
  fallbackRaster?: boolean;
}

const { theme, hosts, viewLayout, platform, drawLog, paintLog, createdImages } = vi.hoisted(() => ({
  theme: {
    fontSize: { xs: 11 },
    colors: { foregroundMuted: "#888" },
  },
  hosts: { current: {} as Record<string, { id: string } | null> },
  viewLayout: { current: { width: 800, height: 600 } },
  platform: { isWeb: false },
  drawLog: [] as DrawEntry[],
  paintLog: [] as PaintOp[][],
  createdImages: [] as HTMLImageElement[],
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
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Image: ({ source }: { source?: { uri?: string } }) =>
    React.createElement("img", { src: source?.uri ?? "" }),
  PanResponder: { create: () => ({ panHandlers: {} }) },
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
vi.mock("./api", () => ({
  callFigma: vi.fn(),
}));

// The draw mock must report through the REAL asset surface, or reconciliation proves nothing:
// imageForRef/fontAvailable/fallbackForNode run on every paint (observing live keys) and the
// aggregated miss set goes to onMissing — exactly the renderer's contract (renderer/index.ts).
vi.mock("@/figma/renderer", () => ({
  createFigmaRenderer: () => ({
    hitTest: () => null,
    draw: (ctx: CanvasRenderingContext2D, node: FigmaNode, options: DrawOptions) => {
      const entry: DrawEntry = {
        nodeId: node.id,
        imageRefsAsked: [],
        fallbackAsked: [],
        fontAsks: [],
        hits: [],
      };
      const missing: MissingReport = { fallbackNodeIds: [], imageRefs: [], fonts: [] };
      const pushUnique = (list: string[], value: string): void => {
        if (!list.includes(value)) list.push(value);
      };
      const visit = (n: DrawableNode): void => {
        for (const fill of n.fills ?? []) {
          if (fill.type !== "image" || typeof fill.imageRef !== "string" || !fill.imageRef)
            continue;
          pushUnique(entry.imageRefsAsked, fill.imageRef);
          const image = options.imageForRef(fill.imageRef);
          if (image) {
            entry.hits.push({ ref: fill.imageRef, image });
            ctx.drawImage(image, 0, 0, 1, 1);
          } else {
            pushUnique(missing.imageRefs, fill.imageRef);
          }
        }
        const font = n.fontName;
        if (font?.family && font?.style) {
          pushUnique(entry.fontAsks, `${font.family}\u0000${font.style}`);
          if (!options.fontAvailable(font.family, font.style)) {
            const key = `${font.family}\u0000${font.style}`;
            if (!missing.fonts.some((f) => `${f.family}\u0000${f.style}` === key))
              missing.fonts.push({ family: font.family, style: font.style });
          }
        }
        if (n.fallbackRaster === true) {
          pushUnique(entry.fallbackAsked, n.id);
          const raster = options.fallbackForNode(n.id);
          if (raster) ctx.drawImage(raster, 0, 0, 1, 1);
          else pushUnique(missing.fallbackNodeIds, n.id);
        }
        for (const child of n.children ?? []) visit(child);
      };
      visit(node as unknown as DrawableNode);
      if (missing.imageRefs.length || missing.fallbackNodeIds.length || missing.fonts.length)
        options.onMissing?.(missing);
      drawLog.push(entry);
    },
  }),
}));

import { callFigma } from "./api";

const callFigmaMock = vi.mocked(callFigma);

type ImageFillsParams = FigmaRequestParams<"figma.file.imageFills.request">;
type ImageFillsData = FigmaResponseData<"figma.file.imageFills.request">;
type RenderParams = FigmaRequestParams<"figma.file.render.request">;
type RenderData = FigmaResponseData<"figma.file.render.request">;
type FontsParams = FigmaRequestParams<"figma.fonts.get.request">;
type FontsData = FigmaResponseData<"figma.fonts.get.request">;

interface Deferred {
  resolve: (data: ImageFillsData | RenderData | FontsData) => void;
  reject: (error: Error) => void;
}

interface FigmaHandlers {
  imageFills?: (params: ImageFillsParams) => ImageFillsData | Promise<ImageFillsData>;
  render?: (params: RenderParams) => RenderData | Promise<RenderData>;
  fonts?: (params: FontsParams) => FontsData | Promise<FontsData>;
}

/**
 * Typed `callFigma` mock router, one seam per request type (the generic signature cannot narrow
 * FigmaRequestParams<T> inside a mockImplementation; the single double-assert bridges concrete →
 * generic exactly as the sibling harness does).
 */
function routeFigma(handlers: FigmaHandlers, deferred?: Deferred[]): void {
  const defer = <T,>(value: T): T => {
    if (!deferred) return value;
    return new Promise<T>((resolve, reject) => {
      deferred.push({
        resolve: resolve as unknown as Deferred["resolve"],
        reject,
      });
    });
  };
  callFigmaMock.mockImplementation(((client, type, params: unknown) => {
    if (!client) throw new Error("test client missing");
    if (type === "figma.file.imageFills.request") {
      const p = params as unknown as ImageFillsParams;
      const served = handlers.imageFills
        ? handlers.imageFills(p)
        : { images: Object.fromEntries(p.imageRefs.map((ref) => [ref, fillBytes(ref)])) };
      return Promise.resolve(served).then((data) => defer(data));
    }
    if (type === "figma.file.render.request") {
      const p = params as unknown as RenderParams;
      const served = handlers.render
        ? handlers.render(p)
        : {
            images: Object.fromEntries(
              p.ids.map((id) => [
                id,
                { mimeType: "image/png", dataBase64: `raster:${p.scale}:${id}` },
              ]),
            ),
            source: "rest" as const,
          };
      return Promise.resolve(served).then((data) => defer(data));
    }
    if (type === "figma.fonts.get.request") {
      const p = params as unknown as FontsParams;
      const served = handlers.fonts
        ? handlers.fonts(p)
        : { font: { mimeType: "font/woff2", dataBase64: `font:${p.family}:${p.style}` } };
      return Promise.resolve(served).then((data) => defer(data));
    }
    throw new Error(`unexpected figma rpc ${String(type)}`);
  }) as unknown as typeof callFigma);
}

function fillBytes(ref: string): FigmaBytes {
  return { mimeType: "image/png", dataBase64: `fill:${ref}` };
}
function fillDataUrl(ref: string): string {
  return bytesToDataUrl(fillBytes(ref));
}
function thumbDataUrl(id: string, scale = 1): string {
  return bytesToDataUrl({ mimeType: "image/png", dataBase64: `raster:${scale}:${id}` });
}

// ── observation recorders ───────────────────────────────────────────────────────────────

function imageElementsFor(dataUrl: string): HTMLImageElement[] {
  return createdImages.filter((el) => el.getAttribute("src") === dataUrl);
}

/** jsdom <img> never fires load for data: URIs — the fake decode must be driven explicitly. */
function dispatchLoad(dataUrl: string): number {
  const targets = imageElementsFor(dataUrl);
  act(() => {
    for (const el of targets) el.dispatchEvent(new Event("load"));
  });
  return targets.length;
}

function askedImageRefs(): string[][] {
  return callFigmaMock.mock.calls
    .filter(([, type]) => type === "figma.file.imageFills.request")
    .map(([, , params]) => (params as unknown as ImageFillsParams).imageRefs);
}
function askedRenderBatches(): Array<{ ids: string[]; scale: number }> {
  return callFigmaMock.mock.calls
    .filter(([, type]) => type === "figma.file.render.request")
    .map(([, , params]) => {
      const p = params as unknown as RenderParams;
      return { ids: [...p.ids], scale: p.scale };
    });
}
function askedFonts(): string[] {
  return callFigmaMock.mock.calls
    .filter(([, type]) => type === "figma.fonts.get.request")
    .map(([, , params]) => {
      const p = params as unknown as FontsParams;
      return `${p.family} ${p.style}`;
    });
}
function askCountFor(ref: string): number {
  return askedImageRefs().filter((batch) => batch.includes(ref)).length;
}
function entriesFor(nodeId: string): DrawEntry[] {
  return drawLog.filter((entry) => entry.nodeId === nodeId);
}
function hitsFor(entry: DrawEntry, ref: string): DrawEntry["hits"] {
  return entry.hits.filter((h) => h.ref === ref);
}
function drawImageOps(): PaintOp[] {
  return paintLog.flat().filter((op) => op.method === "drawImage");
}

// ── harness ─────────────────────────────────────────────────────────────────────────────

function rowFrames(count: number, step: number, width: number, height: number) {
  return Array.from({ length: count }, (_, i) =>
    makeFrameSummary(`1:${i}`, i * step, 0, width, height),
  ) satisfies FigmaFrameSummary[];
}

function imgChild(parentId: string, refs: string[]): FigmaNode {
  return makeNode({
    id: `${parentId}-img`,
    type: "RECTANGLE",
    fills: refs.map((imageRef) => ({ type: "image", imageRef })) as unknown as FigmaNode["fills"],
  });
}
function textChild(parentId: string, family: string, style: string): FigmaNode {
  return makeNode({
    id: `${parentId}-txt`,
    type: "TEXT",
    fontName: { family, style } as unknown as FigmaNode["fontName"],
  });
}
function fallbackChild(parentId: string): FigmaNode {
  return makeNode({ id: `${parentId}-fb`, type: "RECTANGLE", fallbackRaster: true });
}

function viewerFetcher(respond: (id: string) => FigmaNode) {
  const calls: Array<{ ids: string[]; depth?: number }> = [];
  const fetchNodes = vi.fn(async (ids: readonly string[], options?: { depth?: number }) => {
    calls.push({ ids: [...ids], ...(options?.depth ? { depth: options.depth } : {}) });
    const nodes: Record<string, FigmaNode | null> = {};
    for (const id of ids) nodes[id] = respond(id);
    return { nodes, components: {} };
  });
  return { calls, fetchNodes };
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
    onCamera: () => undefined,
    selectedNodeId: null,
    onSelectNode: () => undefined,
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

/** Drain the store queue, the cache microtasks, RPC settles, notify bumps, and rAF paints. */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      // Await the frame itself: paints are scheduled through requestAnimationFrame, and a
      // pure setTimeout drain can return before the rAF callback ever ran.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => setTimeout(() => resolve(), 0)),
      );
    });
  }
}

/** jsdom has no 2D context. Every drawing call records into the current paint's op list. */
function makeFakeCtx(): CanvasRenderingContext2D {
  const props: Record<string, unknown> = {
    getTransform: () => ({ a: 1 }),
  };
  return new Proxy(props, {
    get: (t, p) => {
      if (!(p in t)) {
        t[p as string] = (...args: unknown[]) => {
          // The paper fill (0,0,viewW,viewH) is the one op every paint performs exactly once,
          // before any per-frame drawing: it starts the paint's record.
          if (p === "fillRect" && isPaperFill(args)) paintLog.push([]);
          paintLog[paintLog.length - 1]?.push({ method: String(p), args });
        };
      }
      return t[p as string];
    },
    set: (t, p, v) => {
      (t as Record<string | symbol, unknown>)[p] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function isPaperFill(args: unknown[]): boolean {
  return (
    args.length === 4 &&
    args[0] === 0 &&
    args[1] === 0 &&
    args[2] === viewLayout.current.width &&
    args[3] === viewLayout.current.height
  );
}

const LEFT: Camera = { zoom: 1, offsetX: 0, offsetY: 0 };
const RIGHT: Camera = { zoom: 1, offsetX: -6600, offsetY: 0 };
const EMPTY: Camera = { zoom: 1, offsetX: -90000, offsetY: 0 };
// 600×450 frames at zoom 0.1 project 60 px: thumbnail LOD (plan ≥ 48 px, zoom < 0.15).
// figma x at screen edge = (screen − offsetX)/0.1; −5600 → the right end of the 70k-wide row.
const LEFT_THUMB: Camera = { zoom: 0.1, offsetX: 0, offsetY: 0 };
const RIGHT_THUMB: Camera = { zoom: 0.1, offsetX: -5600, offsetY: 0 };

let restoreCreateElement: (() => void) | null = null;

beforeEach(() => {
  callFigmaMock.mockReset();
  hosts.current = { srv: { id: "srv" } };
  platform.isWeb = false;
  drawLog.length = 0;
  paintLog.length = 0;
  createdImages.length = 0;
  HTMLCanvasElement.prototype.getContext = (() => makeFakeCtx()) as never;
  const original = document.createElement.bind(document);
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const el = original(tag, options);
    // The real webDecode creates detached jsdom <img>s that never fire load on their own.
    if (tag.toLowerCase() === "img") createdImages.push(el as HTMLImageElement);
    return el;
  }) as typeof document.createElement;
  restoreCreateElement = () => {
    document.createElement = original;
  };
});

afterEach(() => {
  restoreCreateElement?.();
  restoreCreateElement = null;
  platform.isWeb = false;
  document.getElementById(CANVAS_ID)?.remove();
  document.body.innerHTML = "";
});

describe("CanvasView real-asset retention boundary (spec 32.5.1)", () => {
  it("pans 100 roots and keeps one shared image fill decoded exactly once while unique refs are released and re-asked", async () => {
    platform.isWeb = true;
    routeFigma({});
    const frames = rowFrames(100, 220, 200, 150);
    const rightIds = framesInViewport(frames, RIGHT, 800, 600, 120).map((f) => f.id);
    const { fetchNodes, calls } = viewerFetcher((id) => {
      if (id === "1:0")
        return makeNode({
          id,
          children: [imgChild(id, ["shared-ref", "left-only"]), textChild(id, "Inter", "400")],
        });
      if (id === "1:2") return makeNode({ id, children: [imgChild(id, ["shared-ref"])] });
      if (id === "1:3") return makeNode({ id, children: [fallbackChild(id)] });
      if (id === "1:31")
        return makeNode({ id, children: [imgChild(id, ["shared-ref", "right-only"])] });
      return makeNode({ id });
    });
    const store = new FrameStore(fetchNodes);
    void store.load(rightIds); // pre-seed so the FIRST right-view paint observes shared-ref
    const viewer = mountViewer({ frames, camera: LEFT, store });
    await settle();

    // One coalesced batch: the shared ref appears once even though two roots asked this paint,
    // and it is the only ask — the caches keep the ledger deduped, not per-paint.
    const first = askedImageRefs()[0];
    expect(first).toBeDefined();
    expect(first!.filter((ref) => ref === "shared-ref")).toHaveLength(1);
    expect(first).toContain("left-only");

    // Fake-decode, then the draw must hit the SAME decoded element for every root using it.
    expect(dispatchLoad(fillDataUrl("shared-ref"))).toBe(1);
    expect(dispatchLoad(fillDataUrl("left-only"))).toBe(1);
    await settle();
    const sharedImages = imageElementsFor(fillDataUrl("shared-ref"));
    expect(sharedImages).toHaveLength(1);
    for (const nodeId of ["1:0", "1:2"]) {
      const hits = entriesFor(nodeId).flatMap((e) => hitsFor(e, "shared-ref"));
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((h) => h.image === sharedImages[0])).toBe(true);
    }
    // Repeat paints on the same view must not re-ask: the observed record survives reconciliation.
    const fetchesAfterLoad = calls.length;
    viewer.rerender({ camera: { ...LEFT, offsetX: -2 } });
    await settle();
    expect(askCountFor("shared-ref")).toBe(1);
    expect(askCountFor("left-only")).toBe(1);

    // Pan away: the left cluster's UNIQUE refs are unobserved at endDraw → released. The shared
    // ref survives because the right cluster (1:31) observes it on every right-view paint.
    viewer.rerender({ camera: RIGHT });
    await settle();
    expect(askCountFor("right-only")).toBe(1);
    expect(askCountFor("shared-ref")).toBe(1); // never re-asked across the hop

    // Pan back: unique refs are gone from the cache (re-asked), shared is a decoded hit again.
    viewer.rerender({ camera: LEFT });
    await settle();
    expect(askCountFor("left-only")).toBe(2); // released offscreen, demanded again on return
    expect(askCountFor("shared-ref")).toBe(1); // continuously observed → kept, reused
    expect(imageElementsFor(fillDataUrl("shared-ref"))).toHaveLength(1); // decoded EXACTLY once
    const reused = entriesFor("1:0")
      .flatMap((e) => e.hits)
      .filter((h) => h.ref === "shared-ref");
    expect(reused.at(-1)?.image).toBe(sharedImages[0]);

    // Offscreen rasters release too: the fallback scale-2 tile for 1:3's node was asked once per
    // visit (no per-paint refetch loop) and the unobserved paint dropped it.
    const fallbackBatches = askedRenderBatches().filter((b) => b.scale === 2);
    expect(fallbackBatches.map((b) => b.ids)).toEqual([["1:3-fb"], ["1:3-fb"]]);

    // The subtree loads were the seed plus the on-view effect — the return visit is pure cache.
    expect(calls.length).toBe(fetchesAfterLoad);
    viewer.unmount();
  });

  it("never duplicates a pending fetch, and a late old response neither notifies nor repopulates", async () => {
    platform.isWeb = true;
    const batches: Deferred[] = [];
    routeFigma({}, batches);
    const frames = rowFrames(100, 220, 200, 150);
    const rightIds = framesInViewport(frames, RIGHT, 800, 600, 120).map((f) => f.id);
    const { fetchNodes } = viewerFetcher((id) => {
      if (id === "1:0") return makeNode({ id, children: [imgChild(id, ["left-a"])] });
      if (id === "1:2") return makeNode({ id, children: [imgChild(id, ["left-b"])] });
      if (id === "1:31") return makeNode({ id, children: [imgChild(id, ["right-c"])] });
      return makeNode({ id });
    });
    const store = new FrameStore(fetchNodes);
    void store.load(rightIds);
    const viewer = mountViewer({ frames, camera: LEFT, store });
    await settle();

    // One pending batch for BOTH left refs; repeat paints on the same view keep asking (get is
    // the observation) but must never enqueue a second fetch for an in-flight key.
    expect(batches).toHaveLength(1);
    expect([...askedImageRefs()[0]!.sort()]).toEqual(["left-a", "left-b"]);
    viewer.rerender({ camera: { ...LEFT, offsetX: -2 } });
    await settle();
    viewer.rerender({ camera: { ...LEFT, offsetX: -4 } });
    await settle();
    expect(askedImageRefs()).toHaveLength(1); // pending get does not duplicate fetch

    // Pan away while the batch is still in flight: the left records are unobserved → retired.
    viewer.rerender({ camera: RIGHT });
    await settle(4);
    const paintsBeforeLate = paintLog.length;
    expect(askedImageRefs()).toHaveLength(2); // the right view asked its own fresh batch
    const rightBatch = askedImageRefs()[1];
    expect(rightBatch).toContain("right-c");
    expect(rightBatch).not.toContain("left-a"); // a retired key is not revived by the stale ask

    // The OLD response lands now: every record in it was reconciled away, so the settle must
    // neither notify a paint nor start a decode nor repopulate anything.
    batches[0]!.resolve({
      images: { "left-a": fillBytes("left-a"), "left-b": fillBytes("left-b") },
    });
    await settle();
    expect(paintLog.length).toBe(paintsBeforeLate); // no notify from a fully retired batch
    expect(imageElementsFor(fillDataUrl("left-a"))).toHaveLength(0); // not even a fake decode

    // Pan back: the cache holds nothing, so the SAME refs are re-asked (the proof of no
    // repopulate), then decode on demand.
    viewer.rerender({ camera: LEFT });
    await settle();
    expect(askedImageRefs()).toHaveLength(3);
    expect(askedImageRefs()[2]).toEqual(expect.arrayContaining(["left-a", "left-b"]));
    batches[2]!.resolve({
      images: { "left-a": fillBytes("left-a"), "left-b": fillBytes("left-b") },
    });
    await settle();
    expect(dispatchLoad(fillDataUrl("left-a"))).toBe(1);
    expect(dispatchLoad(fillDataUrl("left-b"))).toBe(1);
    await settle();
    expect(entriesFor("1:0").some((e) => hitsFor(e, "left-a").length > 0)).toBe(true);

    // Late DECODE: pan away, then the images of the current scope fire load after their records
    // were retired — the record-identity guard must drop the notify.
    viewer.rerender({ camera: RIGHT });
    await settle(4);
    const paintsBeforeDecide = paintLog.length;
    expect(dispatchLoad(fillDataUrl("left-a"))).toBe(1);
    expect(dispatchLoad(fillDataUrl("left-b"))).toBe(1);
    await settle();
    expect(paintLog.length).toBe(paintsBeforeDecide); // retired settle cannot notify a repaint
    viewer.unmount();
  });

  it("an empty-viewport paint clears every cache so fills and fonts are re-asked on revisit", async () => {
    platform.isWeb = true;
    routeFigma({});
    const frames = rowFrames(100, 220, 200, 150);
    const { fetchNodes } = viewerFetcher((id) => {
      if (id === "1:0")
        return makeNode({
          id,
          children: [imgChild(id, ["shared-ref"]), textChild(id, "Inter", "400")],
        });
      return makeNode({ id });
    });
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera: LEFT, store });
    await settle();
    expect(askCountFor("shared-ref")).toBe(1);
    expect(dispatchLoad(fillDataUrl("shared-ref"))).toBe(1);
    await settle();
    expect(askedFonts()).toEqual(["Inter 400"]); // attempted once while observed, cached after

    // The empty paint opens and closes a retention frame with nothing observed: EVERY cache
    // reconciles to empty — decoded images, failed/pending records, and the font attempt.
    const drawsBefore = drawLog.length;
    const paintsBefore = paintLog.length;
    viewer.rerender({ camera: EMPTY });
    await settle();
    expect(drawLog.length).toBe(drawsBefore); // the empty viewport drew no roots at all…
    expect(paintLog.length).toBeGreaterThan(paintsBefore); // …but still ran the reconcile frame

    viewer.rerender({ camera: LEFT });
    await settle();
    expect(askCountFor("shared-ref")).toBe(2); // the decoded image did not survive the empty draw
    expect(askedFonts()).toEqual(["Inter 400", "Inter 400"]); // the font result did not either
    expect(imageElementsFor(fillDataUrl("shared-ref"))).toHaveLength(2); // re-decoded, not reused
    viewer.unmount();
  });

  it("releases offscreen thumbnail rasters on pan and re-decodes them on return", async () => {
    platform.isWeb = true;
    routeFigma({});
    // 600×450 frames at zoom 0.1 project 60 px: thumbnail LOD (plan ≥ 48 px, zoom < 0.15).
    const frames = rowFrames(100, 700, 600, 450);
    const leftThumb = framesInViewport(frames, LEFT_THUMB, 800, 600, 120).map((f) => f.id);
    const rightThumb = framesInViewport(frames, RIGHT_THUMB, 800, 600, 120).map((f) => f.id);
    expect(leftThumb.length).toBeGreaterThan(0);
    expect(rightThumb.length).toBeGreaterThan(0);
    expect(leftThumb.filter((id) => rightThumb.includes(id))).toHaveLength(0);
    const { fetchNodes } = viewerFetcher((id) => makeNode({ id }));
    const store = new FrameStore(fetchNodes);
    const viewer = mountViewer({ frames, camera: LEFT_THUMB, store });
    await settle();

    const thumbs = askedRenderBatches().filter((b) => b.scale === 1);
    expect(thumbs).toHaveLength(1);
    expect([...thumbs[0]!.ids].sort()).toEqual([...leftThumb].sort());
    for (const id of leftThumb) expect(dispatchLoad(thumbDataUrl(id))).toBe(1);
    await settle();
    for (const id of leftThumb)
      expect(
        drawImageOps().some((op) => op.args[0] === imageElementsFor(thumbDataUrl(id))[0]),
      ).toBe(true);
    expect(askedRenderBatches().filter((b) => b.scale === 1)).toHaveLength(1); // hits, no refetch

    // Pan away → the whole thumbnail working set is unobserved → retired; back → re-asked and
    // re-decoded (the daemon's disk cache makes the refetch zero-REST, not the canvas's job).
    // Scoped to the left ids: the right view runs its own separate thumbnail batch.
    viewer.rerender({ camera: RIGHT_THUMB });
    await settle();
    viewer.rerender({ camera: LEFT_THUMB });
    await settle();
    const leftAsked = (b: { ids: string[] }) => b.ids.some((id) => leftThumb.includes(id));
    const thumbsAgain = askedRenderBatches().filter((b) => b.scale === 1 && leftAsked(b));
    expect(thumbsAgain).toHaveLength(2);
    expect([...thumbsAgain[1]!.ids].sort()).toEqual([...leftThumb].sort());
    const first = imageElementsFor(thumbDataUrl(leftThumb[0]!))[0];
    expect(dispatchLoad(thumbDataUrl(leftThumb[0]!))).toBe(2); // a second decode for the same tile
    expect(imageElementsFor(thumbDataUrl(leftThumb[0]!))[1]).not.toBe(first);
    viewer.unmount();
  });
});
