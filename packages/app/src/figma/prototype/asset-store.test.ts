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

// Player asset lifetime (ADR-0037 memory rule): bytes and FontFaces hang off one
// store per server/file/version snapshot, are claimed per STAGE OWNER, and are released while
// the player stays open the moment no active owner holds them. Late callbacks after a release
// (or after close) must not revive cleared entries or stomp a newer generation.

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
  it("starts one fetch per asset; a second active owner shares without a new claim", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const claim = store.claim("1:1:1:1", "fill|ref-a");
    expect(claim).not.toBeNull();
    // Another simultaneously active owner holding the same asset gets null: same fetch, shared.
    expect(store.claim("2:1:1:2", "fill|ref-a")).toBeNull();
    expect(store.get("fill|ref-a")?.status).toBe("loading");
  });

  it("decodes bytes to ready and notifies subscribers on load", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const listener = vi.fn();
    store.subscribe(listener);
    const claim = store.claim("1:1:1:1", "fill|ref-a")!;
    store.putDecoded("fill|ref-a", bytes(), claim);
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
    const claim = store.claim("1:1:1:1", "raster|1:2")!;
    store.putDecoded("raster|1:2", null, claim);
    expect(store.get("raster|1:2")?.status).toBe("failed");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("releaseOwner frees unreferenced assets while the player is open and preserves shared ones", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const a = store.claim("1:base", "fill|ref-a")!;
    store.claim("1:base", "fill|shared")!;
    expect(store.claim("2:overlay", "fill|shared")).toBeNull(); // shared, already held
    store.putDecoded("fill|ref-a", bytes(), a);
    createdImages[0].dispatchEvent(new Event("load"));

    store.releaseOwner("1:base");
    // The navigating frame's private asset is gone; the overlay still shares its own asset.
    expect(store.get("fill|ref-a")).toBeUndefined();
    expect(store.isHeld("fill|shared")).toBe(true);

    store.releaseOwner("2:overlay");
    expect(store.isHeld("fill|shared")).toBe(false);
  });

  it("drops the late completion of a removed owner instead of resurrecting the entry", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const listener = vi.fn();
    store.subscribe(listener);
    const claim = store.claim("1:base", "fill|ref-a")!;
    store.putDecoded("fill|ref-a", bytes(), claim);
    store.releaseOwner("1:base");
    expect(store.get("fill|ref-a")).toBeUndefined();
    // The decode finishes after the frame navigated away: no revival, no notify.
    createdImages[0].dispatchEvent(new Event("load"));
    expect(store.get("fill|ref-a")).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
  });

  it("a superseded generation cannot stomp the newer claim", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const first = store.claim("1:base", "fill|ref-a")!;
    store.releaseOwner("1:base");
    const second = store.claim("2:base", "fill|ref-a")!;
    expect(second.generation).toBeGreaterThan(first.generation);

    // The released owner's fetch lands late: dropped, the in-flight generation keeps its slot.
    store.putDecoded("fill|ref-a", bytes("bG9zdA=="), first);
    expect(store.get("fill|ref-a")?.status).toBe("loading");
    expect(createdImages).toHaveLength(0); // the stale settle never even started a decode

    const live = store.claim("2:base", "fill|ref-a");
    expect(live).toBeNull(); // same owner re-ask: already held, no duplicate fetch
    store.putDecoded("fill|ref-a", bytes(), second);
    createdImages[0].dispatchEvent(new Event("load"));
    expect(store.get("fill|ref-a")?.status).toBe("ready");
  });

  it("releases bytes, subscribers, and cleanups on dispose; late callbacks drop", () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const listener = vi.fn();
    const cleanup = vi.fn();
    store.subscribe(listener);
    store.onDispose(cleanup);
    const claim = store.claim("1:base", "fill|ref-a")!;
    store.putDecoded("fill|ref-a", bytes(), claim);
    store.dispose();

    expect(store.disposed).toBe(true);
    expect(store.get("fill|ref-a")).toBeUndefined();
    expect(cleanup).toHaveBeenCalledTimes(1);

    // The decode finishes after close: nothing revives the cleared entries or fires listeners.
    createdImages[0].dispatchEvent(new Event("load"));
    expect(store.get("fill|ref-a")).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(store.putDecoded("fill|ref-b", bytes(), claim)).toBeUndefined();
    expect(store.get("fill|ref-b")).toBeUndefined();
  });

  it("claims nothing on a disposed store", () => {
    const store = new PrototypeAssetStore("k");
    store.dispose();
    expect(store.claim("1:base", "fill|ref-a")).toBeNull();
    expect(store.get("fill|ref-a")).toBeUndefined();
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

    const claim = v1.store.claim("1:base", "fill|ref-a")!;
    v1.store.putDecoded("fill|ref-a", bytes(), claim);
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
    a.store.claim("1:base", "raster|1:2");

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
  // A browser-shaped FontFaceSet stub: `check` returns TRUE for nonexistent families (exactly
  // what MDN documents for `i-dont-exist`), so availability must be judged by whether an
  // actual matching face is REGISTERED AND LOADED — a stylesheet-declared @font-face sits in
  // the set as "unloaded" until the browser fetches it and proves nothing.
  interface StubFace {
    family: string;
    weight: string;
    style: string;
    status: string;
  }
  function stubFonts() {
    const faces: StubFace[] = [];
    const set = {
      [Symbol.iterator]: () => faces[Symbol.iterator](),
      check: () => true,
      ready: Promise.resolve(),
      add: vi.fn((face: StubFace) => {
        faces.push(face);
      }),
      delete: vi.fn((face: StubFace) => {
        const index = faces.indexOf(face);
        if (index >= 0) faces.splice(index, 1);
      }),
    };
    Object.defineProperty(document, "fonts", { configurable: true, value: set });
    // jsdom lacks FontFace entirely: give the gate a registrable face carrying the exact
    // family/weight/style it asked for, with a REAL status lifecycle (unloaded -> loaded on
    // load()), so success is registration-and-load evidence, not a fixture courtesy.
    vi.stubGlobal(
      "FontFace",
      class StubFontFace implements StubFace {
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
    return { faces, add: set.add, delete: set.delete };
  }

  afterEach(() => {
    Reflect.deleteProperty(document, "fonts");
  });

  it("loads a known Google family (Inter) from the daemon, never appending a browser <link>", async () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    stubFonts();
    const loadFontBytes = vi.fn(
      async (): Promise<FigmaBytes | null> => ({
        mimeType: "font/woff2",
        dataBase64: "Rk9P",
      }),
    );
    const gate = createScopedFontGate(store, loadFontBytes);
    await gate.load([{ family: "Inter", style: "Regular" }]);
    // spec 32.5.1: production fonts come from cached daemon bytes, not the browser's Google
    // stylesheet network. Inter is a classic Google family and still hits the daemon exactly
    // once, and NO <link> is ever appended (the whole client-CSS path is gone).
    expect(loadFontBytes).toHaveBeenCalledTimes(1);
    expect(loadFontBytes).toHaveBeenCalledWith("Inter", "Regular");
    expect(document.head.querySelectorAll("link")).toHaveLength(0);
    expect(gate.fontAvailable("Inter", "Regular")).toBe(true);
    store.dispose();
    expect(gate.fontAvailable("Inter", "Regular")).toBe(false);
  });

  it("a nonexistent family that fonts.check answers TRUE for is not available and never re-tries", async () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    stubFonts(); // check() => true for everything, like the real browser
    const loadFontBytes = vi.fn(async (): Promise<FigmaBytes | null> => null);
    const gate = createScopedFontGate(store, loadFontBytes);
    const available = await gate.loadForOwner("1:base", [
      { family: "Zorbal Missing", style: "Regular" },
    ]);
    // check-true must not mark the face available: no registration, so the renderer takes the
    // real-Figma raster fallback instead of silently painting the generic stack.
    expect(available).toBe(false);
    expect(gate.fontAvailable("Zorbal Missing", "Regular")).toBe(false);
    // The failed attempt is remembered for the gate's lifetime: repeated claims while the
    // player stays open re-issue no daemon fetch (the bounded re-render regression).
    await gate.loadForOwner("1:base", [{ family: "Zorbal Missing", style: "Regular" }]);
    await gate.loadForOwner("2:base", [{ family: "Zorbal Missing", style: "Regular" }]);
    expect(loadFontBytes).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("a registered-but-UNLOADED face proves nothing and does not count as available", async () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const fonts = stubFonts();
    // An @font-face declared by some other stylesheet sits in the set with status "unloaded"
    // (the browser has not fetched it). check() would say true; family matching would say true.
    // Only a genuinely loaded face is evidence.
    fonts.add({ family: "Zorbal Unloaded", weight: "400", style: "normal", status: "unloaded" });
    const loadFontBytes = vi.fn(async (): Promise<FigmaBytes | null> => null);
    const gate = createScopedFontGate(store, loadFontBytes);
    const available = await gate.loadForOwner("1:base", [
      { family: "Zorbal Unloaded", style: "Regular" },
    ]);
    expect(available).toBe(false);
    expect(gate.fontAvailable("Zorbal Unloaded", "Regular")).toBe(false);
    // The gate did not accept the unloaded entry and fell through to the real bytes path.
    expect(loadFontBytes).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("an already-LOADED matching face is honoured as evidence with zero network", async () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const fonts = stubFonts();
    fonts.add({ family: "Zorbal System", weight: "400", style: "normal", status: "loaded" });
    const loadFontBytes = vi.fn(async (): Promise<FigmaBytes | null> => null);
    const gate = createScopedFontGate(store, loadFontBytes);
    const available = await gate.loadForOwner("1:base", [
      { family: "Zorbal System", style: "Regular" },
    ]);
    // No repaint credit: the very first draw already answers fontAvailable true for this face,
    // so there was never a raster-text state to replace. `available` reports only claims whose
    // outcome changed while pending.
    expect(available).toBe(false);
    expect(gate.fontAvailable("Zorbal System", "Regular")).toBe(true);
    expect(loadFontBytes).not.toHaveBeenCalled();
    expect(document.head.querySelectorAll("link")).toHaveLength(0);
    store.dispose();
  });

  it("singleflights concurrent claims to the SAME in-flight promise and unifies on the result", async () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    stubFonts();
    let release: ((value: FigmaBytes | null) => void) | null = null;
    const loadFontBytes = vi.fn(
      () =>
        new Promise<FigmaBytes | null>((resolve) => {
          release = resolve;
        }),
    );
    const gate = createScopedFontGate(store, loadFontBytes);
    const first = gate.loadForOwner("1:base", [{ family: "Zorbal Custom", style: "Bold" }]);
    const second = gate.loadForOwner("2:overlay", [{ family: "Zorbal Custom", style: "Bold" }]);
    release!({ mimeType: "font/woff2", dataBase64: "Rk9P" });
    const [a, b] = await Promise.all([first, second]);
    expect(loadFontBytes).toHaveBeenCalledTimes(1);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(gate.fontAvailable("Zorbal Custom", "Bold")).toBe(true);
    store.dispose();
  });

  it("releases the last active owner's FontFace while the player stays open and re-claims on revisit", async () => {
    const store = new PrototypeAssetStore("s1|fk1|v1");
    const fonts = stubFonts();
    let loads = 0;
    const loadFontBytes = vi.fn(async (): Promise<FigmaBytes | null> => {
      loads += 1;
      return { mimeType: "font/woff2", dataBase64: `Rk9PJHtsb2Fkc30=` };
    });
    const gate = createScopedFontGate(store, loadFontBytes);
    await gate.loadForOwner("1:base", [{ family: "Zorbal Custom", style: "Regular" }]);
    expect(fonts.add).toHaveBeenCalledTimes(1);
    expect(gate.fontAvailable("Zorbal Custom", "Regular")).toBe(true);

    // Second active owner shares the registration; releasing the first keeps it alive.
    await gate.loadForOwner("2:overlay", [{ family: "Zorbal Custom", style: "Regular" }]);
    gate.releaseOwner("1:base");
    expect(fonts.delete).not.toHaveBeenCalled();
    expect(gate.fontAvailable("Zorbal Custom", "Regular")).toBe(true);

    // Last active owner gone: the face is unregistered while the player stays open.
    gate.releaseOwner("2:overlay");
    expect(fonts.delete).toHaveBeenCalledTimes(1);
    expect(gate.fontAvailable("Zorbal Custom", "Regular")).toBe(false);

    // A revisit re-establishes the face (bounded per claim: one fetch per started load).
    await gate.loadForOwner("3:base", [{ family: "Zorbal Custom", style: "Regular" }]);
    expect(loads).toBe(2);
    expect(fonts.add).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it("stops serving fetches once disposed and never re-adds faces", async () => {
    const loadFontBytes = vi.fn(async (): Promise<FigmaBytes | null> => bytes("RE9CT1Q="));
    const store = new PrototypeAssetStore("s1|fk1|v2");
    stubFonts();
    const gate = createScopedFontGate(store, loadFontBytes);
    store.dispose();
    await gate.load([{ family: "Zorbal DevLiga", style: "Bold" }]);
    // Disposed scope: the fetcher is short-circuited, so no daemon bytes are requested and no
    // global FontFace entry is created for a dead snapshot.
    expect(loadFontBytes).not.toHaveBeenCalled();
    expect(gate.fontAvailable("Zorbal DevLiga", "Bold")).toBe(false);
  });

  it("serves every family from the daemon — no Google/non-Google distinction, no <link>", async () => {
    const loadFontBytes = vi.fn(
      async (family: string): Promise<FigmaBytes | null> =>
        family === "Zorbal Custom" ? { mimeType: "font/woff2", dataBase64: "Rk9P" } : null,
    );
    const store = new PrototypeAssetStore("s1|fk1|v3");
    stubFonts();
    const gate = createScopedFontGate(store, loadFontBytes);
    await gate.load([
      { family: "Inter", style: "Regular" },
      { family: "Zorbal Custom", style: "Bold" },
    ]);
    // A well-known Google family is no longer special-cased to browser CSS: BOTH families go to
    // the daemon's cached bytes (spec 32.5.1), and not a single <link> is appended.
    expect(loadFontBytes).toHaveBeenCalledTimes(2);
    expect(loadFontBytes).toHaveBeenCalledWith("Inter", "Regular");
    expect(loadFontBytes).toHaveBeenCalledWith("Zorbal Custom", "Bold");
    expect(document.head.querySelectorAll("link")).toHaveLength(0);
    // Missing daemon bytes settle failed (negative-cached) rather than faking availability; a
    // real registration is what proves out.
    expect(gate.fontAvailable("Inter", "Regular")).toBe(false);
    expect(gate.fontAvailable("Zorbal Custom", "Bold")).toBe(true);
    store.dispose();
  });
});
