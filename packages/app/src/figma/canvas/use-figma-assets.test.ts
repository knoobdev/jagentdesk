/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";

const { clientRef, callFigmaMock } = vi.hoisted(() => ({
  clientRef: { current: { id: "host" } as unknown },
  callFigmaMock: vi.fn(),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => clientRef.current,
}));
// The hook's whole wire side: one mock routing by RPC method name.
vi.mock("./api", () => ({
  callFigma: (client: unknown, method: string, params: unknown) =>
    callFigmaMock(client, method, params),
}));

import {
  useFigmaAssets,
  webRegisterFont,
  type FigmaAssets,
  type ImageDecoder,
} from "./use-figma-assets";

function imageBytes(): FigmaBytes {
  return { mimeType: "image/png", dataBase64: "AA==" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks drain (cache flushes run on queueMicrotask). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A decodeImage fake recording every element it hands out: bytes arriving is NOT decoded-ready,
 * so tests must emit("load") before asserting an image is served to the renderer.
 */
class FakeImage {
  readonly listeners: Record<"load" | "error", (() => void)[]> = { load: [], error: [] };
  src = "";
  addEventListener(type: "load" | "error", listener: () => void): void {
    this.listeners[type].push(listener);
  }
  emit(type: "load" | "error"): void {
    for (const listener of this.listeners[type]) listener();
  }
}

function captureDecode(): { images: FakeImage[]; decodeImage: ImageDecoder } {
  const images: FakeImage[] = [];
  const decodeImage: ImageDecoder = (dataUrl) => {
    const image = new FakeImage();
    image.src = dataUrl; // which bytes this decode came from — SVG vs PNG isolation asserts
    images.push(image);
    return image as unknown as ReturnType<ImageDecoder>;
  };
  return { images, decodeImage };
}

interface RecordedFace {
  family: string;
  src: string;
  descriptors: Record<string, string> | undefined;
}

let madeFaces: RecordedFace[] = [];
let madeInstances: unknown[] = [];
let fontsAdd: ReturnType<typeof vi.fn>;
let fontsDelete: ReturnType<typeof vi.fn>;

function stubFontFaceApi(load: () => Promise<unknown>) {
  madeFaces = [];
  madeInstances = [];
  fontsAdd = vi.fn();
  fontsDelete = vi.fn();
  class FakeFontFace {
    seq: number;
    constructor(family: string, src: string, descriptors?: Record<string, string>) {
      madeFaces.push({ family, src, descriptors });
      madeInstances.push(this);
      // Identity for assertions: jest's toHaveBeenCalledWith is a deep-equal, so two
      // structurally identical faces would otherwise be interchangeable.
      this.seq = madeFaces.length - 1;
      this.load = load;
    }
    load: () => Promise<unknown>;
  }
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: fontsAdd, delete: fontsDelete },
  });
}

describe("webRegisterFont exact-family registration", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("registers under the family the renderer asks for, with numeric weight and italic", async () => {
    stubFontFaceApi(async () => ({}));
    await expect(webRegisterFont("Inter", "Semi Bold Italic", "data:x")).resolves.toBe(true);
    // The face must live under "Inter" (ctx.font names the family itself and selects the
    // descriptor) — the old "Inter Semi Bold Italic" name matched nothing.
    expect(madeFaces[0]?.family).toBe("Inter");
    expect(madeFaces[0]?.descriptors).toEqual({ weight: "600", style: "italic" });
    expect(fontsAdd).toHaveBeenCalledTimes(1);
  });

  it("a plain style registers weight 400 / normal under the bare family", async () => {
    stubFontFaceApi(async () => ({}));
    await expect(webRegisterFont("Roboto", "Regular", "data:x")).resolves.toBe(true);
    expect(madeFaces[0]?.family).toBe("Roboto");
    expect(madeFaces[0]?.descriptors).toEqual({ weight: "400", style: "normal" });
  });

  it("a failing load returns false and adds nothing to document.fonts", async () => {
    stubFontFaceApi(async () => {
      throw new Error("bad bytes");
    });
    await expect(webRegisterFont("Inter", "Bold", "data:x")).resolves.toBe(false);
    expect(fontsAdd).not.toHaveBeenCalled();
  });

  it("an owner retired during face.load() never reaches document.fonts or onRegistered", async () => {
    const load = deferred<unknown>();
    stubFontFaceApi(() => load.promise);
    const track = vi.fn();
    let current = true;
    const registering = webRegisterFont("Inter", "Bold", "data:x", track, () => current);
    await settle(); // face.load() is in flight, nothing committed yet
    expect(fontsAdd).not.toHaveBeenCalled();
    current = false; // unmount / version switch while load was pending
    load.resolve({});
    await expect(registering).resolves.toBe(false);
    // The dispose already ran, so a stale add would leak an unowned face into FontFaceSet.
    expect(fontsAdd).not.toHaveBeenCalled();
    expect(track).not.toHaveBeenCalled();
  });

  it("hands the face to onRegistered so the owner can dispose it", async () => {
    stubFontFaceApi(async () => ({}));
    const track = vi.fn();
    await webRegisterFont("Lato", "Black", "data:x", track);
    expect(track).toHaveBeenCalledTimes(1);
    expect(fontsAdd).toHaveBeenCalledWith(track.mock.calls[0][0]);
  });
});

describe("useFigmaAssets owner dispose", () => {
  let root: Root;

  function mount(props: {
    serverId: string;
    fileKey: string;
    version: string | null;
    decodeImage?: ImageDecoder;
    fidelity?: boolean;
    getDeviceScale?: () => number;
  }) {
    const result: { current: FigmaAssets } = {
      current: null as unknown as FigmaAssets,
    };
    function Harness() {
      result.current = useFigmaAssets(props);
      return null;
    }
    act(() => root.render(React.createElement(Harness)));
    return result.current;
  }

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
    root = createRoot(document.createElement("div"));
    clientRef.current = { id: "host" };
    callFigmaMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("unmount removes registered faces from document.fonts and drops late settles", async () => {
    stubFontFaceApi(async () => ({}));
    const images = deferred<{ images: Record<string, FigmaBytes | null> }>();
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.fonts.get.request"
        ? Promise.resolve({ font: imageBytes() })
        : images.promise,
    );
    const assets = mount({ serverId: "s1", fileKey: "file", version: null });
    const onPaint = vi.fn();
    assets.subscribe(onPaint);

    // A font registers through the real web path so the face set is populated…
    await act(async () => {
      assets.onMissing({
        fallbackNodeIds: [],
        imageRefs: [],
        fonts: [{ family: "Inter", style: "Bold" }],
      });
      await settle();
    });
    expect(fontsAdd).toHaveBeenCalledTimes(1);
    expect(assets.fontAvailable("Inter", "Bold")).toBe(true);

    // …while an image fill is still in flight when the owner goes away.
    const pending = act(async () => {
      assets.imageForRef("r1");
      await settle();
    });
    await pending;
    onPaint.mockClear();
    act(() => root.unmount());
    images.resolve({ images: { r1: imageBytes() } });
    await settle();

    expect(fontsDelete).toHaveBeenCalledWith(expect.anything()); // real document.fonts removal
    expect(onPaint).not.toHaveBeenCalled(); // the late settle belongs to a dead generation
  });

  it("retires an owner-registered face that lands after a scope switch mid-load", async () => {
    const staleLoad = deferred<unknown>();
    const currentLoad = deferred<unknown>();
    const faceLoads = [staleLoad, currentLoad];
    let loadIndex = 0;
    stubFontFaceApi(() => faceLoads[loadIndex++]!.promise);
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.fonts.get.request"
        ? Promise.resolve({ font: imageBytes() })
        : Promise.resolve({ images: {} }),
    );
    const first = mount({ serverId: "s1", fileKey: "a", version: null });
    await act(async () => {
      first.onMissing({
        fallbackNodeIds: [],
        imageRefs: [],
        fonts: [{ family: "Inter", style: "Bold" }],
      });
      await settle();
    });
    // The stale face.load() is in flight when the scope switches (version bump retires every
    // hook cache through the dispose effect, even the ones whose memo identity is stable).
    expect(loadIndex).toBe(1);
    expect(fontsAdd).not.toHaveBeenCalled();

    const second = mount({ serverId: "s1", fileKey: "a", version: "v2" });
    await act(async () => {
      second.onMissing({
        fallbackNodeIds: [],
        imageRefs: [],
        fonts: [{ family: "Inter", style: "Bold" }],
      });
      await settle();
    });
    expect(loadIndex).toBe(2); // the current scope asked for its own face
    staleLoad.resolve({});
    currentLoad.resolve({});
    await settle();

    // Only the current generation's face may enter FontFaceSet; the stale attempt — whose
    // dispose already ran, faces map emptied — must be dropped whole.
    expect(fontsAdd).toHaveBeenCalledTimes(1);
    expect(madeFaces).toHaveLength(2); // both were constructed…
    // …but exactly one was added, and it is the second (current-scope) instance — never the stale one.
    expect(fontsAdd).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }));
    expect(fontsAdd).not.toHaveBeenCalledWith(expect.objectContaining({ seq: 0 }));
  });

  it("an empty offscreen paint reconciles the image and font caches; the next paint refetches", async () => {
    stubFontFaceApi(async () => ({}));
    const { images, decodeImage } = captureDecode();
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.fonts.get.request"
        ? Promise.resolve({ font: imageBytes() })
        : Promise.resolve({ images: { r1: imageBytes(), "1:1": imageBytes() } }),
    );
    const assets = mount({ serverId: "s1", fileKey: "file", version: null, decodeImage });
    const onPaint = vi.fn();
    assets.subscribe(onPaint);

    // A visible tile: image fill, fallback raster and a text font, all observed by one draw.
    await act(async () => {
      assets.beginDraw();
      assets.imageForRef("r1");
      assets.requestThumbnail("1:1", 2);
      assets.fontAvailable("Inter", "Bold");
      assets.endDraw();
      await settle();
    });
    expect(assets.imageForRef("r1")).toBeNull(); // bytes received is not decoded-ready
    const notifiesAfterFont = onPaint.mock.calls.length; // font settle notified (live scope)
    images[0]!.emit("load"); // the two ByteImageCache images decode, in creation order: fill, raster
    images[1]!.emit("load");
    expect(assets.imageForRef("r1")).not.toBeNull();
    expect(onPaint.mock.calls.length).toBeGreaterThan(notifiesAfterFont); // readiness repaint comes from load
    expect(assets.fontAvailable("Inter", "Bold")).toBe(true);

    // Panned offscreen: an empty paint reconciles EVERY cache (root correction: no exempt
    // rules) — pending/failed/decoded keys the draw never touched are all retired.
    await act(async () => {
      assets.beginDraw();
      assets.endDraw();
      await settle();
    });
    expect(assets.imageForRef("r2")).toBeNull(); // unseen ref…
    // Scrolling back re-asks: each cache refetches because the previous view's keys died.
    await act(async () => {
      assets.beginDraw();
      assets.imageForRef("r1");
      assets.requestThumbnail("2:2", 2);
      assets.fontAvailable("Roboto", "Regular");
      assets.endDraw();
      await settle();
    });
    const names = callFigmaMock.mock.calls.map((call) => call[1]);
    expect(names.filter((n) => n === "figma.fonts.get.request")).toHaveLength(2); // retired + refetched
    expect(
      callFigmaMock.mock.calls.filter((c) => c[1] === "figma.file.render.request").length,
    ).toBe(2);
    expect(
      callFigmaMock.mock.calls.filter((c) => c[1] === "figma.file.imageFills.request").length,
    ).toBe(2);
  });

  it("an unused FontFace is removed from document.fonts when its key reconciles away", async () => {
    stubFontFaceApi(async () => ({}));
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.fonts.get.request"
        ? Promise.resolve({ font: imageBytes() })
        : Promise.resolve({ images: {} }),
    );
    const assets = mount({ serverId: "s1", fileKey: "file", version: null });
    await act(async () => {
      assets.beginDraw();
      assets.onMissing({
        fallbackNodeIds: [],
        imageRefs: [],
        fonts: [{ family: "Inter", style: "Bold" }],
      });
      assets.endDraw();
      await settle();
    });
    expect(fontsAdd).toHaveBeenCalledTimes(1);
    expect(assets.fontAvailable("Inter", "Bold")).toBe(true);

    // A paint without that text retires the face — real document.fonts cleanup, per W7 design.
    await act(async () => {
      assets.beginDraw();
      assets.endDraw();
      await settle();
    });
    expect(fontsDelete).toHaveBeenCalledWith(expect.objectContaining({ seq: 0 }));
    // And scrolling back to text loads a fresh face rather than trusting the stale state.
    await act(async () => {
      assets.beginDraw();
      expect(assets.fontAvailable("Inter", "Bold")).toBe(false);
      assets.endDraw();
      await settle();
    });
    const fontFetches = callFigmaMock.mock.calls.filter(
      (c) => c[1] === "figma.fonts.get.request",
    ).length;
    expect(fontFetches).toBe(2);
    expect(fontsAdd).toHaveBeenCalledTimes(2);
  });

  it("a per-scale cache created mid-draw joins the open observation and is retired when unused", async () => {
    const { images, decodeImage } = captureDecode();
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.fonts.get.request"
        ? Promise.resolve({ font: null })
        : Promise.resolve({ images: { "1:1": imageBytes() } }),
    );
    const assets = mount({ serverId: "s1", fileKey: "file", version: null, decodeImage });
    const onPaint = vi.fn();
    assets.subscribe(onPaint);

    // scale 4 does not exist yet when the draw opens; get() creates it mid-draw.
    await act(async () => {
      assets.beginDraw();
      assets.requestThumbnail("1:1", 4);
      assets.endDraw();
      await settle();
    });
    expect(assets.requestThumbnail("1:1", 4)).toBeNull(); // bytes received ≠ decoded-ready
    images[0]!.emit("load");
    expect(assets.requestThumbnail("1:1", 4)).not.toBeNull(); // survived the draw that used it
    expect(onPaint).toHaveBeenCalled(); // live attempt settles into the current generation
    onPaint.mockClear();

    // Unused next paint: the mid-draw cache reconciles like every other cache — all clears.
    await act(async () => {
      assets.beginDraw();
      assets.endDraw();
      await settle();
    });
    expect(assets.requestThumbnail("1:1", 4)).toBeNull(); // retired, must refetch
    await act(async () => {
      assets.beginDraw();
      assets.requestThumbnail("1:1", 4);
      assets.endDraw();
      await settle();
    });
    expect(
      callFigmaMock.mock.calls.filter((c) => c[1] === "figma.file.render.request").length,
    ).toBe(2);
  });

  it("a scope change clears the previous file's caches — no stale repopulate or notify", async () => {
    const images = deferred<{ images: Record<string, FigmaBytes | null> }>();
    callFigmaMock.mockReturnValue(images.promise);
    const old = mount({ serverId: "s1", fileKey: "a", version: null });
    const onPaint = vi.fn();
    old.subscribe(onPaint);
    await act(async () => {
      old.imageForRef("r1");
      await settle();
    });
    expect(callFigmaMock).toHaveBeenCalledWith(
      expect.anything(),
      "figma.file.imageFills.request",
      expect.objectContaining({ fileKey: "a" }),
    );

    // Swap scope: the hook rebuilds its caches and the effect cleanup retires the old ones
    // before the late bytes land.
    mount({ serverId: "s1", fileKey: "b", version: null });
    onPaint.mockClear();
    images.resolve({ images: { r1: imageBytes() } });
    await settle();
    expect(onPaint).not.toHaveBeenCalled(); // the dead generation dropped the settle entirely
    expect(old.imageForRef("r1")).toBeNull(); // nothing repopulated the cleared cache
  });

  it("a failed font is not refetched on repaints, and a client swap (reconnect) retries", async () => {
    const registerFont = vi.fn(async () => false);
    callFigmaMock.mockResolvedValue({ font: imageBytes() });
    const result: { current: FigmaAssets } = { current: null as unknown as FigmaAssets };
    function Harness() {
      result.current = useFigmaAssets({
        serverId: "s1",
        fileKey: "file",
        version: null,
        registerFont,
      });
      return null;
    }
    act(() => root.render(React.createElement(Harness)));
    for (let paint = 0; paint < 25; paint += 1) {
      expect(result.current.fontAvailable("Inter", "Bold")).toBe(false);
    }
    await settle();
    expect(callFigmaMock).toHaveBeenCalledTimes(1);

    // Reconnect: the runtime client identity changes, the hook rebuilds its caches, and the
    // font may now succeed — the failure cache is per scope, not forever.
    clientRef.current = { id: "other" };
    act(() => root.render(React.createElement(Harness)));
    expect(result.current.fontAvailable("Inter", "Bold")).toBe(false);
    await settle();
    expect(callFigmaMock).toHaveBeenCalledTimes(2);
  });
});

// ── ADR-0042 quality-path serve helpers ─────────────────────────────────────────
// Declared at module scope so the mock-serving callbacks never stack on the
// describe/it callback depth (lint budget) and build plain records with loops.
interface RenderCall {
  fileKey: string;
  ids: string[];
  scale: number;
  version?: string;
  format?: string;
  useAbsoluteBounds?: boolean;
}

function renderCalls(): RenderCall[] {
  const out: RenderCall[] = [];
  for (const c of callFigmaMock.mock.calls)
    if (c[1] === "figma.file.render.request") out.push(c[2] as RenderCall);
  return out;
}

function recordsFor(
  ids: readonly string[],
  bytes: FigmaBytes | null,
): Record<string, FigmaBytes | null> {
  const images: Record<string, FigmaBytes | null> = {};
  for (const id of ids) images[id] = bytes;
  return images;
}

/** Every raster ask answers with bytes whose MIME matches the requested format. */
function serveRastersByFormat(): void {
  callFigmaMock.mockImplementation((_client, method, params) => {
    const p = params as { ids?: string[]; format?: string };
    if (method !== "figma.file.render.request") return Promise.resolve({});
    const mimeType = p.format === "svg" ? "image/svg+xml" : "image/png";
    return Promise.resolve({ images: recordsFor(p.ids ?? [], { mimeType, dataBase64: "AA==" }) });
  });
}

/** SVG asks fail terminal; PNG asks answer with decodable bytes. */
function serveSvgFailingPngOk(): void {
  callFigmaMock.mockImplementation((_client, method, params) => {
    const p = params as { ids?: string[]; format?: string };
    if (method !== "figma.file.render.request") return Promise.resolve({});
    const bytes = p.format === "svg" ? null : imageBytes();
    return Promise.resolve({ images: recordsFor(p.ids ?? [], bytes) });
  });
}

/** Every raster class fails terminal — bytes never arrive for SVG or PNG. */
function serveRastersAllNull(): void {
  callFigmaMock.mockImplementation((_client, method, params) => {
    const p = params as { ids?: string[] };
    if (method !== "figma.file.render.request") return Promise.resolve({});
    return Promise.resolve({ images: recordsFor(p.ids ?? [], null) });
  });
}

/** SVG asks answer with decodable svg bytes (PNG stays unanswered). */
function serveSvgBytes(): void {
  callFigmaMock.mockImplementation((_client, method, params) => {
    const p = params as { ids?: string[]; format?: string };
    if (method !== "figma.file.render.request") return Promise.resolve({});
    const mimeType = p.format === "svg" ? "image/svg+xml" : "image/png";
    return Promise.resolve({ images: recordsFor(p.ids ?? [], { mimeType, dataBase64: "AA==" }) });
  });
}

/**
 * Every raster class answers with bytes whose base64 embeds the node id, so a decoded
 * FakeImage is ATTRIBUTABLE to its ask (which scale served which node) — the backdrop
 * regressions read and re-read the same node across zooms and must tell the classes apart.
 */
function serveRastersById(): void {
  callFigmaMock.mockImplementation((_client, method, params) => {
    const p = params as { ids?: string[]; format?: string };
    if (method !== "figma.file.render.request") return Promise.resolve({});
    const mimeType = p.format === "svg" ? "image/svg+xml" : "image/png";
    const images: Record<string, FigmaBytes | null> = {};
    for (const id of p.ids ?? []) images[id] = { mimeType, dataBase64: btoa(id) };
    return Promise.resolve({ images });
  });
}

function imageForId(images: FakeImage[], id: string, mime: "image/png" | "image/svg+xml") {
  const needle = `;base64,${btoa(id)}`;
  return images.find((i) => i.src.includes(mime) && i.src.includes(needle));
}

// ── ADR-0042 backdrop BACKGROUND_BLUR exception ────────────────────────────────
// Figma's PER-NODE export bakes no backdrop structure for a visible BACKGROUND_BLUR above
// scale 2 (pinned probes: scale 2 matches the composited frame, 3/4 are flat). The asset layer
// caps that class to min(rung, 2), classified from the renderer's getter hint BEFORE any cache
// choice or miss-queue — one decision shared by reads and fetches, so zooming never asks the
// node's flat rung and an ordinary raster/TEXT class is untouched.
describe("useFigmaAssets ADR-0042 backdrop BACKGROUND_BLUR cap", () => {
  let root: Root;

  function mount(props: {
    serverId: string;
    fileKey: string;
    version: string | null;
    decodeImage?: ImageDecoder;
    fidelity?: boolean;
    getDeviceScale?: () => number;
  }) {
    const result: { current: FigmaAssets } = {
      current: null as unknown as FigmaAssets,
    };
    function Harness() {
      result.current = useFigmaAssets(props);
      return null;
    }
    act(() => root.render(React.createElement(Harness)));
    return result.current;
  }

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
    root = createRoot(document.createElement("div"));
    clientRef.current = { id: "host" };
    callFigmaMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("never queues 3/4 for a hinted backdrop node while siblings ride rung 4 and TEXT stays SVG", async () => {
    serveRastersById();
    const { decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 4.2, // rasterRung → 4
      decodeImage,
    });
    // The real renderer's order: the getter runs FIRST (a miss queues from the getter itself),
    // the report arrives after — the cap must already be decided at the getter.
    assets.beginDraw();
    expect(assets.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: true })).toBeNull();
    expect(assets.fallbackForNode("n1", "RECTANGLE")).toBeNull();
    expect(assets.fallbackForNode("t1", "TEXT")).toBeNull();
    assets.onMissing({
      fallbackNodeIds: ["bg1", "n1", "t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle();
    // Three separate class batches — and the backdrop never touches the rung-4 batch with n1:
    // capped to the proven scale 2, no format-less legacy field leakage, deduped against the
    // getter's own queue (exactly one ask per class).
    expect(renderCalls()).toContainEqual({
      fileKey: "f",
      ids: ["bg1"],
      scale: 2,
      version: "v1",
      format: "png",
    });
    expect(renderCalls()).toContainEqual({
      fileKey: "f",
      ids: ["n1"],
      scale: 4,
      version: "v1",
      format: "png",
    });
    expect(renderCalls()).toContainEqual({
      fileKey: "f",
      ids: ["t1"],
      scale: 1,
      version: "v1",
      format: "svg",
      useAbsoluteBounds: true,
    });
    expect(renderCalls()).toHaveLength(3);
  });

  it("read and fetch share the capped cache across zoom — rising rung re-reads it, never asks flat 3/4 bytes", async () => {
    serveRastersById();
    const { images, decodeImage } = captureDecode();
    let zoom = 4.2; // → rung 4
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => zoom,
      decodeImage,
    });
    assets.beginDraw();
    expect(assets.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: true })).toBeNull();
    assets.onMissing({
      fallbackNodeIds: ["bg1"],
      textFallbackNodeIds: [],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle();
    const bgImage = imageForId(images, "bg1", "image/png");
    expect(bgImage).toBeDefined();
    bgImage!.emit("load");

    // Zoom to 6 × dpr 2 territory: the ADAPTIVE class would ride rung 4, but the hinted
    // backdrop reads the SAME capped scale-2 cache its fetch filled — no second ask at all.
    for (let paint = 0; paint < 5; paint += 1) {
      assets.beginDraw();
      expect(assets.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: true })).toBe(bgImage);
      assets.onMissing({
        fallbackNodeIds: ["bg1"],
        textFallbackNodeIds: [],
        imageRefs: [],
        fonts: [],
      });
      assets.endDraw();
      await settle();
    }
    zoom = 6;
    assets.beginDraw();
    expect(assets.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: true })).toBe(bgImage);
    assets.endDraw();
    expect(renderCalls()).toHaveLength(1); // ever: the one capped ask
    expect(renderCalls()[0].scale).toBe(2);
  });

  it("an ask without the hint lifts the cap — a hidden effect never inherits the previous paint's rung-2", async () => {
    serveRastersById();
    const { decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 4.2, // rung 4
      decodeImage,
    });
    assets.beginDraw();
    expect(assets.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: true })).toBeNull();
    assets.endDraw();
    await settle();
    expect(renderCalls()).toHaveLength(1);
    expect(renderCalls()[0].scale).toBe(2);

    // Effect hidden (W7 stops hinting): the node still fallbacks via another feature, and the
    // fresh ask WITHOUT the hint routes back to the honest adaptive rung — the cap is per-ask
    // truth, not sticky state.
    assets.beginDraw();
    expect(assets.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: false })).toBeNull();
    assets.onMissing({
      fallbackNodeIds: ["bg1"],
      textFallbackNodeIds: [],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle();
    expect(renderCalls()).toHaveLength(2);
    expect(renderCalls()[1]).toEqual({
      fileKey: "f",
      ids: ["bg1"],
      scale: 4,
      version: "v1",
      format: "png",
    });
  });

  it("TEXT with a visible backdrop comes as capped absolute PNG, never an SVG outline — and back to SVG once hidden", async () => {
    serveRastersById();
    const { decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 4.2,
      decodeImage,
    });
    assets.beginDraw();
    expect(assets.fallbackForNode("tb1", "TEXT", { backgroundBlur: true })).toBeNull();
    assets.onMissing({
      fallbackNodeIds: ["tb1"],
      textFallbackNodeIds: ["tb1"],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle();
    // The backdrop class keeps the absolute-bounds meaning (the renderer places known TEXT on
    // the layout box) at the proven scale — and never burns the SVG outline the backdrop voids.
    expect(renderCalls()).toEqual([
      {
        fileKey: "f",
        ids: ["tb1"],
        scale: 2,
        version: "v1",
        format: "png",
        useAbsoluteBounds: true,
      },
    ]);

    // Hidden again: ordinary TEXT returns to the SVG route (no stale cap, no downgrade mark).
    assets.beginDraw();
    expect(assets.fallbackForNode("tb1", "TEXT")).toBeNull();
    assets.onMissing({
      fallbackNodeIds: ["tb1"],
      textFallbackNodeIds: ["tb1"],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle();
    expect(renderCalls()).toHaveLength(2);
    expect(renderCalls()[1]).toEqual({
      fileKey: "f",
      ids: ["tb1"],
      scale: 1,
      version: "v1",
      format: "svg",
      useAbsoluteBounds: true,
    });
  });

  it("the capped class keeps the finite negative cache and retry semantics — one ask per rung, ever", async () => {
    serveRastersAllNull();
    const { decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 4.2, // rung 4 — without the cap this node would ask 4 every fresh scope
      decodeImage,
    });
    for (let paint = 0; paint < 10; paint += 1) {
      assets.beginDraw();
      expect(assets.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: true })).toBeNull();
      assets.onMissing({
        fallbackNodeIds: ["bg1"],
        textFallbackNodeIds: [],
        imageRefs: [],
        fonts: [],
      });
      assets.endDraw();
      await settle();
    }
    // Ten re-asks, ONE wire call — and it is the capped scale, never the flat rung-4 bytes.
    const blurAsks = renderCalls().filter((c) => c.ids.includes("bg1"));
    expect(blurAsks).toHaveLength(1);
    expect(blurAsks[0].scale).toBe(2);
    // The ledger is honest: the failed backdrop counts as failed, nothing phantom pending.
    const st = assets.status();
    expect(st.failed).toBe(1);
    expect(st.pending).toBe(0);
    // retryFailed reopens exactly one ask on the capped scale again — bounded, not per-frame.
    assets.retryFailed();
    assets.beginDraw();
    expect(assets.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: true })).toBeNull();
    assets.endDraw();
    await settle();
    expect(renderCalls().filter((c) => c.ids.includes("bg1"))).toHaveLength(2);
  });

  it("without the capability the hint changes nothing — the legacy wire stays byte-identical", async () => {
    serveRastersById();
    const { decodeImage } = captureDecode();
    const legacy = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: false,
      getDeviceScale: () => 4.2,
      decodeImage,
    });
    legacy.beginDraw();
    expect(legacy.fallbackForNode("bg1", "RECTANGLE", { backgroundBlur: true })).toBeNull();
    legacy.onMissing({
      fallbackNodeIds: ["bg1"],
      textFallbackNodeIds: [],
      imageRefs: [],
      fonts: [],
    });
    legacy.endDraw();
    await settle();
    // Pre-capability hosts never see format/useAbsoluteBounds — and the cap is a no-op at 2
    // because the legacy path already asks exactly the scale-2 crop PNG.
    expect(renderCalls()).toEqual([{ fileKey: "f", ids: ["bg1"], scale: 2, version: "v1" }]);
  });
});

describe("useFigmaAssets ADR-0042 fidelity quality path", () => {
  // The routing rules the asset layer owns: TEXT+capability → outlined SVG at the absolute
  // box, non-TEXT → default-crop PNG on the quantized rung, everything else → the exact legacy
  // scale-2 wire. These drive the REAL caches (captureDecode elements, real flush/negative
  // cache), asserting on actual wire params and actual decoded-image identities.
  let root: Root;

  function mount(props: {
    serverId: string;
    fileKey: string;
    version: string | null;
    decodeImage?: ImageDecoder;
    fidelity?: boolean;
    getDeviceScale?: () => number;
  }) {
    const result: { current: FigmaAssets } = {
      current: null as unknown as FigmaAssets,
    };
    function Harness() {
      result.current = useFigmaAssets(props);
      return null;
    }
    act(() => root.render(React.createElement(Harness)));
    return result.current;
  }

  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    vi.stubGlobal("React", React);
    root = createRoot(document.createElement("div"));
    clientRef.current = { id: "host" };
    callFigmaMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("keeps section previews in absolute layout bounds so sparse text is not stretched", async () => {
    serveRastersByFormat();
    const { decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      decodeImage,
    });
    await act(async () => {
      assets.beginDraw();
      assets.requestThumbnail("1:1", 1);
      assets.endDraw();
      await settle();
    });
    const calls = callFigmaMock.mock.calls.filter(
      (call) => call[1] === "figma.file.render.request",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]![2]).toMatchObject({
      ids: ["1:1"],
      version: "v1",
      scale: 1,
      format: "png",
      useAbsoluteBounds: true,
    });
  });

  it("routes known TEXT to svg@1@absolute and non-TEXT to the ceil(zoom·dpr) PNG rung, in separate batches", async () => {
    serveRastersByFormat();
    const { images, decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 2.7, // rasterRung → 3
      decodeImage,
    });

    assets.onMissing({
      fallbackNodeIds: ["t1", "n1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    await settle();

    // One wire ask per raster class — never a mixed batch: the classes live in different
    // caches with different fields, and a daemon cache keyed by format/bounds needs them apart.
    expect(renderCalls()).toEqual([
      {
        fileKey: "f",
        ids: ["t1"],
        scale: 1,
        version: "v1",
        format: "svg",
        useAbsoluteBounds: true,
      },
      { fileKey: "f", ids: ["n1"], scale: 3, version: "v1", format: "png" },
    ]);
    expect(images).toHaveLength(2);
    const svgImage = images.find((i) => i.src.includes("image/svg+xml"));
    const pngImage = images.find((i) => i.src.includes("image/png"));
    expect(svgImage).toBeDefined();
    expect(pngImage).toBeDefined();

    // Cache isolation proven through the real getters: an SVG decode can never answer the
    // crop-PNG class and vice versa, until each class's own bytes decode.
    svgImage!.emit("load");
    expect(assets.fallbackForNode("t1", "TEXT")).toBe(svgImage);
    expect(assets.fallbackForNode("n1")).toBeNull(); // PNG class not decoded yet — no cross-serve
    pngImage!.emit("load");
    expect(assets.fallbackForNode("n1")).toBe(pngImage);
    // And the TEXT node still reads its own SVG, never the PNG bytes.
    expect(assets.fallbackForNode("t1", "TEXT")).toBe(svgImage);
  });

  it("without the capability or without a pinned version, the wire is exactly the legacy scale-2 crop request", async () => {
    serveRastersByFormat();
    const { decodeImage } = captureDecode();

    // Host lacks the feature: TEXT ids stay PNG@2@crop, no new fields on the wire at all.
    const legacy = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: false,
      getDeviceScale: () => 2.7,
      decodeImage,
    });
    legacy.onMissing({
      fallbackNodeIds: ["t1", "n1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    await settle();
    expect(renderCalls()).toEqual([{ fileKey: "f", ids: ["t1", "n1"], scale: 2, version: "v1" }]);

    // Capability present but the scope is live (unpinned): the daemon REFUSES svg/absolute
    // without a version, so the client must not even ask — same exact legacy wire.
    callFigmaMock.mockClear();
    const live = mount({
      serverId: "s1",
      fileKey: "f",
      version: null,
      fidelity: true,
      getDeviceScale: () => 2.7,
      decodeImage,
    });
    live.onMissing({ fallbackNodeIds: ["t1"], imageRefs: [], fonts: [] });
    await settle();
    expect(renderCalls()).toEqual([{ fileKey: "f", ids: ["t1"], scale: 2 }]);
  });

  it("an empty or whitespace-only pin is the no-pin case: legacy wire, no new fields (ADR-0042 contract)", async () => {
    // The daemon REFUSES format=svg/useAbsoluteBounds without a non-empty version
    // (packages/server/src/server/figma/handlers/content.ts), so the client must treat a
    // blank pin exactly like a live scope: scale-2 crop PNG, byte-identical to the
    // pre-capability wire — the quality route never opens, so it can never fail either.
    serveRastersByFormat();
    const { decodeImage } = captureDecode();
    for (const blank of ["", "   "]) {
      callFigmaMock.mockClear();
      const assets = mount({
        serverId: "s1",
        fileKey: "f",
        version: blank,
        fidelity: true,
        getDeviceScale: () => 2.7,
        decodeImage,
      });
      assets.onMissing({
        fallbackNodeIds: ["t1"],
        textFallbackNodeIds: ["t1"],
        imageRefs: [],
        fonts: [],
      });
      await settle();
      expect(renderCalls()).toEqual([
        { fileKey: "f", ids: ["t1"], scale: 2, ...(blank ? { version: blank } : {}) },
      ]);
      // The SVG class was never entered: a TEXT read answers from the crop PNG cache,
      // which holds no decoded bytes yet (jsdom never fires load) — and never SVG.
      expect(assets.fallbackForNode("t1", "TEXT")).toBeNull();
      expect(renderCalls().some((c) => c.format === "svg")).toBe(false);
    }
  });

  it("bytes received is not ready: a mid-decode fallback keeps counting pending, clears only on real load", async () => {
    const load = deferred<{ images: Record<string, FigmaBytes | null> }>();
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.file.render.request" ? load.promise : Promise.resolve({}),
    );
    const { images, decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 1,
      decodeImage,
    });
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    expect(assets.status()).toEqual({ pending: 1, failed: 0 }); // queued
    await settle();
    load.resolve({ images: { t1: { mimeType: "image/svg+xml", dataBase64: "AA==" } } });
    await settle(); // bytes in hand, <img> not yet fired
    expect(images).toHaveLength(1);
    expect(assets.status()).toEqual({ pending: 1, failed: 0 }); // pending DECODE is still pending
    expect(assets.fallbackForNode("t1", "TEXT")).toBeNull();
    images[0]!.emit("load");
    expect(assets.status()).toEqual({ pending: 0, failed: 0 }); // only a real decode clears it
  });

  it("an SVG failure downgrades once; the PNG stays stable across 3 full paint reconciliations with no extra SVG ask", async () => {
    // Root review bug 2/3 regression: the failed SVG entry is not pinned forever — a naive
    // route re-reads it every paint and restarts the cycle. The downgrade must persist
    // independent of the SVG cache's own retention, endDraw must not destabilize the live
    // PNG, and readiness must stay clean once the PNG paints.
    serveSvgFailingPngOk();
    const { images, decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 2.7,
      decodeImage,
    });

    // PAINT 1: the draw reports TEXT missing → outlined SVG asked, settles terminal-failed.
    assets.beginDraw();
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle();
    expect(renderCalls().filter((c) => c.format === "svg")).toHaveLength(1);

    // PAINT 2: the read finds the SVG failed → engages the persistent channel and demands
    // the rung-3 absolute PNG; onMissing re-asks the SAME routed cache (deduped, one fetch).
    assets.beginDraw();
    for (let paint = 0; paint < 20; paint += 1)
      expect(assets.fallbackForNode("t1", "TEXT")).toBeNull();
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle();
    const png = renderCalls().filter((c) => c.format === "png");
    expect(png).toHaveLength(1); // one finite downgrade
    expect(png[0]).toEqual({
      fileKey: "f",
      ids: ["t1"],
      scale: 3,
      version: "v1",
      format: "png",
      useAbsoluteBounds: true,
    });
    expect(renderCalls().filter((c) => c.format === "svg")).toHaveLength(1); // no restart
    expect(images).toHaveLength(1); // the failed SVG never produced a decode element
    const pngImage = images[0]!;
    pngImage.emit("load"); // the downgrade paints

    // PAINT 3: reconciliation runs against the LIVE png — stable, no new asks, clean status.
    assets.beginDraw();
    expect(assets.fallbackForNode("t1", "TEXT")).toBe(pngImage);
    assets.onMissing({ fallbackNodeIds: [], imageRefs: [], fonts: [] }); // nothing missing
    assets.endDraw();
    await settle();
    expect(renderCalls()).toHaveLength(2); // svg once, png once — nothing restarted
    expect(assets.status()).toEqual({ pending: 0, failed: 0 }); // failed SVG holds no slot
  });

  it("retryFailed reopens both the SVG attempt and the one-shot PNG gate", async () => {
    serveRastersAllNull();
    const { decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 1,
      decodeImage,
    });
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    await settle();
    assets.fallbackForNode("t1", "TEXT"); // svg failed → png downgrade once
    await settle();
    expect(renderCalls().filter((c) => c.format === "svg")).toHaveLength(1);
    expect(renderCalls().filter((c) => c.format === "png")).toHaveLength(1);
    assets.fallbackForNode("t1", "TEXT"); // still locked: no second png ask
    expect(renderCalls().filter((c) => c.format === "png")).toHaveLength(1);

    // Explicit retry: terminal failures drop everywhere AND the downgrade gate resets, so a
    // retried SVG that fails again gets its own single PNG shot (not locked out forever).
    assets.retryFailed();
    assets.fallbackForNode("t1", "TEXT"); // svg record gone → get re-queues svg
    await settle();
    expect(renderCalls().filter((c) => c.format === "svg")).toHaveLength(2);
    assets.fallbackForNode("t1", "TEXT"); // svg failed terminal again → gate is open: one png
    await settle();
    expect(renderCalls().filter((c) => c.format === "png")).toHaveLength(2);
    assets.fallbackForNode("t1", "TEXT");
    expect(renderCalls().filter((c) => c.format === "png")).toHaveLength(2);
  });

  it("a scope switch mid-flight retires the old generation: late settle never notifies, the new scope re-asks namespaced", async () => {
    const v1Load = deferred<{ images: Record<string, FigmaBytes | null> }>();
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.file.render.request" ? v1Load.promise : Promise.resolve({}),
    );
    const { images, decodeImage } = captureDecode();
    const onPaint = vi.fn();
    const v1 = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 1,
      decodeImage,
    });
    v1.subscribe(onPaint);
    v1.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    await settle();
    expect(renderCalls()).toHaveLength(1);

    // Navigate the same instance to a newer snapshot while v1 bytes are still in flight.
    serveSvgBytes();
    onPaint.mockClear();
    callFigmaMock.mockClear(); // judge only what the new scope asks; v1's ask is history
    const v2 = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v2",
      fidelity: true,
      getDeviceScale: () => 1,
      decodeImage,
    });
    v2.subscribe(onPaint);
    v2.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    await settle();

    v1Load.resolve({ images: { t1: imageBytes() } }); // the dead generation's late arrival
    await settle();
    expect(onPaint).not.toHaveBeenCalled(); // the dead v1 settle is dropped: no notify at all
    // Only the LIVE scope's own decode completing paints — the notification loop is alive.
    const v2Image = images[images.length - 1];
    v2Image!.emit("load");
    expect(onPaint).toHaveBeenCalledTimes(1);
    expect(renderCalls()).toEqual([
      {
        fileKey: "f",
        ids: ["t1"],
        scale: 1,
        version: "v2",
        format: "svg",
        useAbsoluteBounds: true,
      },
    ]); // v2 re-asks under its own namespaced cache; v1 bytes are simply dropped
  });

  it("a ready SVG fallback with a failed optional font paints clean across two complete paints (root bug 1)", async () => {
    // The false-failure loop: once the exact outlined SVG is READY, the renderer still
    // reports the failed font every paint but no longer reports the fallback missing. The
    // ledger must judge the font by what the draw ACTUALLY paints — the selected replacement
    // cache — not by the missing report, or the status line lies forever.
    serveRastersByFormat();
    stubFontFaceApi(async () => {
      throw new Error("download failed");
    });
    const { images, decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 1,
      decodeImage,
    });

    // PAINT 1: font + fallback both reported missing; the face settles failed while the
    // SVG bytes arrive mid-decode — pending/failed fallback still counts honestly.
    assets.beginDraw();
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [{ family: "Inter", style: "Bold" }],
    });
    assets.endDraw();
    await settle();
    expect(assets.status()).toEqual({ pending: 1, failed: 1 }); // svg decoding + font failed

    const svgImage = images.find((i) => i.src.includes("image/svg+xml"));
    svgImage!.emit("load"); // the exact replacement decodes

    // PAINTS 2+3: the TEXT draws from the ready SVG; the draw reports the font again but
    // NO missing fallback ids — an optional font must never hold the line at failed.
    for (let paint = 0; paint < 2; paint += 1) {
      assets.beginDraw();
      expect(assets.fallbackForNode("t1", "TEXT")).toBe(svgImage);
      assets.onMissing({
        fallbackNodeIds: [],
        imageRefs: [],
        fonts: [{ family: "Inter", style: "Bold" }],
      });
      assets.endDraw();
      await settle();
      expect(assets.status()).toEqual({ pending: 0, failed: 0 });
    }
    expect(callFigmaMock.mock.calls.filter((c) => c[1] === "figma.fonts.get.request")).toHaveLength(
      1,
    );
  });

  it("both SVG and PNG failing terminal is a TRUE failure — never suppressed (root bug 3)", async () => {
    serveRastersAllNull();
    const { decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 1,
      decodeImage,
    });
    // paint 1: svg asked → failed. paint 2: downgrade channel engages, PNG asked → failed.
    assets.beginDraw();
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle();
    assets.beginDraw();
    expect(assets.fallbackForNode("t1", "TEXT")).toBeNull(); // engages the PNG channel
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle(); // png terminal-failed too
    // paint 1: svg asked → failed. paint 2: downgrade asked → failed. paint 3: reads empty,
    // and the draw STILL reports the font (missing glyphs) → a true failure counts, both the
    // terminal PNG and the font the replacement never covered.
    assets.beginDraw();
    expect(assets.fallbackForNode("t1", "TEXT")).toBeNull();
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [{ family: "Inter", style: "Bold" }],
    });
    assets.endDraw();
    await settle();
    const st = assets.status();
    expect(st.failed).toBeGreaterThanOrEqual(2); // PNG terminal + the font it never replaced
    expect(st.pending).toBe(0); // nothing in flight — no phantom loading either
    expect(renderCalls().filter((c) => c.format === "png")).toHaveLength(1); // deduped asks
  });

  it("zooming after a downgrade asks the new rung exactly once (finite 1..4, root bug 2)", async () => {
    serveSvgFailingPngOk();
    const { decodeImage } = captureDecode();
    let zoom = 2.7; // → rung 3
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => zoom,
      decodeImage,
    });
    assets.beginDraw();
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [],
    });
    assets.endDraw();
    await settle(); // svg failed → downgrade channel engages on the next read
    assets.beginDraw();
    expect(assets.fallbackForNode("t1", "TEXT")).toBeNull(); // rung-3 png fetch started
    assets.endDraw();
    await settle();

    // Zoom in: the SAME node now needs rung 4 — asked exactly once, and never the SVG again.
    zoom = 6;
    for (let paint = 0; paint < 10; paint += 1) {
      assets.beginDraw();
      expect(assets.fallbackForNode("t1", "TEXT")).toBeNull();
      assets.onMissing({
        fallbackNodeIds: ["t1"],
        textFallbackNodeIds: ["t1"],
        imageRefs: [],
        fonts: [],
      });
      assets.endDraw();
      await settle();
    }
    const pngs = renderCalls().filter((c) => c.format === "png");
    // One ask per rung, ever: rung 3 from the downgrade, rung 4 exactly once from the
    // zoom — get() singleflights the fresh cache and onMissing dedups against the record.
    expect(pngs.map((c) => c.scale).sort((a, b) => a - b)).toEqual([3, 4]);
    expect(renderCalls().filter((c) => c.format === "svg")).toHaveLength(1);
  });

  it("a TEXT whose fallback failed terminal is still counted — actual missing glyphs are never ready", async () => {
    serveRastersAllNull();
    const { decodeImage } = captureDecode();
    const assets = mount({
      serverId: "s1",
      fileKey: "f",
      version: "v1",
      fidelity: true,
      getDeviceScale: () => 1,
      decodeImage,
    });
    assets.beginDraw();
    assets.onMissing({
      fallbackNodeIds: ["t1"],
      textFallbackNodeIds: ["t1"],
      imageRefs: [],
      fonts: [{ family: "Inter", style: "Bold" }],
    });
    assets.endDraw();
    await settle(); // svg failed → font failure stays counted (replacement never arrived)
    const st = assets.status();
    expect(st.failed).toBeGreaterThanOrEqual(2); // svg terminal + font terminal
    expect(st.pending).toBe(0);
  });
});
