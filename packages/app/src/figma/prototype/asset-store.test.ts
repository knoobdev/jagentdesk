/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";

import {
  assetScopeKey,
  createScopedFontGate,
  peekAssetScope,
  PrototypeAssetStore,
  retainAssetScope,
} from "./asset-store";

// Player asset lifetime (ADR-0037 memory rule): bytes, stylesheets, and FontFaces hang off one
// store per server/file/version snapshot, are shared by every frame on stage, and are released
// when the last owner lets go. Late callbacks after close must not revive them.

function bytes(data = "QUJD"): FigmaBytes {
  return { mimeType: "image/png", dataBase64: data };
}

let createdImages: HTMLImageElement[] = [];

beforeEach(() => {
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = "";
});

describe("PrototypeAssetStore", () => {
  it("claims each asset slot exactly once", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    expect(store.claim("fill|ref-a")).toBe(true);
    expect(store.claim("fill|ref-a")).toBe(false);
    expect(store.get("fill|ref-a")?.status).toBe("loading");
  });

  it("decodes bytes to ready and notifies subscribers on load", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const listener = vi.fn();
    store.subscribe(listener);
    store.claim("fill|ref-a");
    store.putDecoded("fill|ref-a", bytes());
    expect(store.get("fill|ref-a")?.status).toBe("loading");
    createdImages[0].dispatchEvent(new Event("load"));
    const entry = store.get("fill|ref-a");
    expect(entry?.status).toBe("ready");
    expect(entry?.image).toBe(createdImages[0]);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("marks missing bytes failed and notifies", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const listener = vi.fn();
    store.subscribe(listener);
    store.claim("raster|1:2");
    store.putDecoded("raster|1:2", null);
    expect(store.get("raster|1:2")?.status).toBe("failed");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("releases bytes, subscribers, and cleanups on dispose; late callbacks drop", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const listener = vi.fn();
    const cleanup = vi.fn();
    store.subscribe(listener);
    store.onDispose(cleanup);
    store.claim("fill|ref-a");
    store.putDecoded("fill|ref-a", bytes());
    store.dispose();

    expect(store.disposed).toBe(true);
    expect(store.get("fill|ref-a")).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);

    // The decode finishes after close: nothing revives the cleared entries or fires listeners.
    createdImages[0].dispatchEvent(new Event("load"));
    expect(store.get("fill|ref-a")).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(store.putDecoded("fill|ref-b", bytes())).toBeUndefined();
    expect(store.get("fill|ref-b")).toBeUndefined();
  });

  it("runs onDispose immediately once the scope is dead", () => {
    const store = new PrototypeAssetStore("k");
    store.dispose();
    const cleanup = vi.fn();
    store.onDispose(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("ignores a second dispose", () => {
    const store = new PrototypeAssetStore("k");
    const cleanup = vi.fn();
    store.onDispose(cleanup);
    store.dispose();
    store.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("asset scope registry", () => {
  beforeEach(() => {
    // Drain any scopes retained by earlier cases.
    for (const key of ["s1|fk1|v1", "s1|fk1|v2", "s2|fk1|v1"]) {
      const held = retainAssetScope(key);
      held.release();
    }
  });

  afterEach(() => {
    for (const key of ["s1|fk1|v1", "s1|fk1|v2", "s2|fk1|v1"]) {
      peekAssetScope(key)?.dispose();
    }
  });

  it("keys isolation by server, file, AND version — never shares bytes across them", () => {
    expect(assetScopeKey("s1", "fk1", "v1")).toBe("s1|fk1|v1");
    const v1 = retainAssetScope("s1|fk1|v1");
    const v2 = retainAssetScope("s1|fk1|v2");
    const otherServer = retainAssetScope("s2|fk1|v1");
    expect(v1.store).not.toBe(v2.store);
    expect(v1.store).not.toBe(otherServer.store);

    v1.store.claim("fill|ref-a");
    v1.store.putDecoded("fill|ref-a", bytes());
    createdImages[0].dispatchEvent(new Event("load"));
    expect(v1.store.get("fill|ref-a")?.status).toBe("ready");
    // The same asset key under another snapshot is unknown until that snapshot fetches it.
    expect(v2.store.get("fill|ref-a")).toBeUndefined();
    expect(otherServer.store.get("fill|ref-a")).toBeUndefined();

    v1.release();
    v2.release();
    otherServer.release();
  });

  it("refcounts so the last release disposes and a re-retain starts fresh", () => {
    const a = retainAssetScope("s1|fk1|v1");
    const b = retainAssetScope("s1|fk1|v1");
    expect(a.store).toBe(b.store);
    a.store.claim("raster|1:2");

    a.release();
    expect(peekAssetScope("s1|fk1|v1")).toBe(a.store);
    expect(a.store.disposed).toBe(false);

    b.release();
    expect(peekAssetScope("s1|fk1|v1")).toBeUndefined();
    expect(a.store.disposed).toBe(true);

    const c = retainAssetScope("s1|fk1|v1");
    expect(c.store).not.toBe(a.store);
    expect(c.store.get("raster|1:2")).toBeUndefined();
    expect(c.store.disposed).toBe(false);
    c.release();
  });

  it("release is idempotent per retention", () => {
    const a = retainAssetScope("s1|fk1|v2");
    const b = retainAssetScope("s1|fk1|v2");
    a.release();
    a.release();
    expect(peekAssetScope("s1|fk1|v2")).toBeDefined();
    b.release();
    expect(peekAssetScope("s1|fk1|v2")).toBeUndefined();
  });
});

describe("createScopedFontGate", () => {
  // jsdom has no FontFaceSet: give the gate a browser-shaped stub so "already loaded" is
  // observable and the daemon path only runs for families the stylesheet cannot serve.
  function stubFonts(served: (font: string) => boolean) {
    const stub = {
      check: (font: string) => served(font),
      ready: Promise.resolve(),
      add: vi.fn(),
      delete: vi.fn(),
    };
    Object.defineProperty(document, "fonts", { configurable: true, value: stub });
    return stub;
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
  });

  it("injects the Google stylesheet, keeps it off the daemon, and removes it on dispose", async () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    stubFonts((font) => font.includes("Roboto"));
    const loadFontBytes = vi.fn(async (): Promise<FigmaBytes | null> => null);
    const gate = createScopedFontGate(store, loadFontBytes);
    const settled = gate.load([{ family: "Roboto", style: "Regular" }]);
    const link = document.head.querySelector<HTMLLinkElement>("link[href*='fonts.googleapis.com']");
    expect(link).toBeTruthy();
    // jsdom never loads external CSS: the page-side harness owns the load/error signal.
    link!.dispatchEvent(new Event("load"));
    await settled;
    // A family Google Fonts serves must never be paid for twice (or at all) over the daemon.
    expect(loadFontBytes).not.toHaveBeenCalled();
    store.dispose();
    expect(document.head.querySelector("link[href*='fonts.googleapis.com']")).toBeNull();
  });

  it("stops serving fetches once disposed and never re-adds faces", async () => {
    const loadFontBytes = vi.fn(async (): Promise<FigmaBytes | null> => bytes("RE9CT1Q="));
    const store = new PrototypeAssetStore("s1|fk1|v2");
    const gate = createScopedFontGate(store, loadFontBytes);
    store.dispose();
    await gate.load([{ family: "Zorbal DevLiga", style: "Bold" }]);
    // Disposed scope: the fetcher is short-circuited, so no daemon bytes are requested and no
    // global FontFace entry is created for a dead snapshot.
    expect(loadFontBytes).not.toHaveBeenCalled();
    expect(gate.fontAvailable("Zorbal DevLiga", "Bold")).toBe(false);
  });

  it("asks the daemon for bytes only for non-Google families", async () => {
    const loadFontBytes = vi.fn(async (): Promise<FigmaBytes | null> => null);
    const store = new PrototypeAssetStore("s1|fk1|v3");
    stubFonts((font) => font.includes("Inter"));
    const gate = createScopedFontGate(store, loadFontBytes);
    const settled = gate.load([
      { family: "Inter", style: "Regular" },
      { family: "Zorbal Custom", style: "Bold" },
    ]);
    for (const link of document.head.querySelectorAll("link")) {
      link.dispatchEvent(new Event("load"));
    }
    await settled;
    expect(loadFontBytes).toHaveBeenCalledTimes(1);
    expect(loadFontBytes).toHaveBeenCalledWith("Zorbal Custom", "Bold");
    store.dispose();
  });
});
