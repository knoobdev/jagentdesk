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

import { useFigmaAssets, webRegisterFont, type FigmaAssets } from "./use-figma-assets";

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

  function mount(props: { serverId: string; fileKey: string; version: string | null }) {
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
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.fonts.get.request"
        ? Promise.resolve({ font: imageBytes() })
        : Promise.resolve({ images: { r1: imageBytes(), "1:1": imageBytes() } }),
    );
    const assets = mount({ serverId: "s1", fileKey: "file", version: null });
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
    expect(assets.imageForRef("r1")).not.toBeNull();
    expect(assets.fontAvailable("Inter", "Bold")).toBe(true);
    const fetchesAfterView = callFigmaMock.mock.calls.length;

    // Panned offscreen: an empty paint reconciles EVERY cache (root correction: no exempt
    // rules) — pending/failed/decoded keys the draw never touched are all retired.
    await act(async () => {
      assets.beginDraw();
      assets.endDraw();
      await settle();
    });
    expect(assets.imageForRef("r2")).toBeNull(); // unseen ref…
    await act(async () => {
      assets.beginDraw();
      assets.endDraw();
      await settle();
    });
    // Scrolling back re-asks: each cache refetches because the previous view's keys died.
    await act(async () => {
      assets.beginDraw();
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
    void fetchesAfterView;
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
    callFigmaMock.mockImplementation((_client, method) =>
      method === "figma.fonts.get.request"
        ? Promise.resolve({ font: null })
        : Promise.resolve({ images: { "1:1": imageBytes() } }),
    );
    const assets = mount({ serverId: "s1", fileKey: "file", version: null });
    const onPaint = vi.fn();
    assets.subscribe(onPaint);

    // scale 4 does not exist yet when the draw opens; get() creates it mid-draw.
    await act(async () => {
      assets.beginDraw();
      assets.requestThumbnail("1:1", 4);
      assets.endDraw();
      await settle();
    });
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
