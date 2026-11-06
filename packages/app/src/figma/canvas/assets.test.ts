import { describe, expect, it, vi } from "vitest";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import {
  ByteImageCache,
  FontCache,
  MAX_REFS_PER_REQUEST,
  MAX_IMAGE_BATCHES_IN_FLIGHT,
  MAX_PREVIEW_EXPORT_BATCHES_IN_FLIGHT,
  previewRasterRung,
  rasterNamespace,
  rasterRung,
  type MakeImage,
  type ImageBytesBatch,
} from "./assets";

// The draw calls get()/request()/fontAvailable() every paint, and every settle notifies (which
// repaints). These regressions pin the feedback loop: a failure is attempted once per scope, and
// a clear() (reconnect, unmount, scope swap) is the ONLY thing that retries or retires a settle.

function imageBytes(): FigmaBytes {
  return { mimeType: "image/png", dataBase64: "AA==" };
}

/** Per-id record built with a plain loop: serve stubs stay inside the callback-depth budget. */
function recordsFor(
  ids: readonly string[],
  bytes: FigmaBytes | null,
): Record<string, FigmaBytes | null> {
  const images: Record<string, FigmaBytes | null> = {};
  for (const id of ids) images[id] = bytes;
  return images;
}

/** Let queued microtasks and promise chains drain (flushes run on queueMicrotask). */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

class FakeImage {
  readonly listeners: Record<"load" | "error", (() => void)[]> = { load: [], error: [] };
  addEventListener(type: "load" | "error", listener: () => void): void {
    this.listeners[type].push(listener);
  }
  emit(type: "load" | "error"): void {
    for (const listener of this.listeners[type]) listener();
  }
}

const okImage: MakeImage = () => new FakeImage() as unknown as ReturnType<MakeImage>;

const decodesTo =
  (image: FakeImage): MakeImage =>
  () =>
    image as unknown as ReturnType<MakeImage>;

const nullFor = (ref: string): [string, FigmaBytes | null] => [ref, null];
const bytesFor = (ref: string): [string, FigmaBytes | null] => [ref, imageBytes()];
const deadOrBytes = (ref: string): [string, FigmaBytes | null] =>
  ref === "f" ? nullFor(ref) : bytesFor(ref);

/** MakeImage that records every image it hands out, so tests control decode timing. */
function captureImages(): { makeImage: MakeImage; images: FakeImage[] } {
  const images: FakeImage[] = [];
  const makeImage: MakeImage = () => {
    const image = new FakeImage();
    images.push(image);
    return image as unknown as ReturnType<MakeImage>;
  };
  return { makeImage, images };
}

describe("overview sampling and image backpressure", () => {
  it("samples a 1440px frame at sufficient display resolution without retaining a full-sized preview", () => {
    const scale = previewRasterRung(0.07 * 2);
    expect(scale * 1440).toBeGreaterThanOrEqual(0.07 * 2 * 1440);
    expect(scale).toBe(0.25);
    expect(scale * scale).toBeLessThan(0.1);
    expect(previewRasterRung(0.2 * 2)).toBe(0.5);
    expect(previewRasterRung(0.2 * 3)).toBe(1);
  });

  it("starts two batches immediately and bounds concurrency while draining a broad viewport", async () => {
    const gate = deferred<void>();
    let active = 0;
    let peak = 0;
    const seen: string[] = [];
    const cache = new ByteImageCache(async (ids) => {
      active++;
      peak = Math.max(peak, active);
      seen.push(...ids);
      await gate.promise;
      active--;
      return recordsFor(ids, null);
    }, okImage);
    cache.request(...Array.from({ length: 65 }, (_, i) => `image_${i}`));
    await settle();
    expect(active).toBe(MAX_IMAGE_BATCHES_IN_FLIGHT);
    expect(seen).toHaveLength(MAX_REFS_PER_REQUEST * MAX_IMAGE_BATCHES_IN_FLIGHT);
    for (let paint = 0; paint < 50; paint++) cache.request("image_64");
    await settle();
    expect(peak).toBe(MAX_IMAGE_BATCHES_IN_FLIGHT);
    gate.resolve();
    await settle();
    expect(seen).toHaveLength(65);
    expect(new Set(seen).size).toBe(65);
    expect(cache.status()).toEqual({ pending: 0, failed: 65 });
  });
});

describe("cached images before missing exports", () => {
  it("shows a cache hit while another export is pending and keeps it when the export fails", async () => {
    const missing = deferred<ImageBytesBatch>();
    const { makeImage, images } = captureImages();
    const requested: string[][] = [];
    const cache = new ByteImageCache(
      async (ids) => {
        requested.push([...ids]);
        return missing.promise;
      },
      makeImage,
      () => undefined,
      async () => ({ image_a: imageBytes(), image_b: null }),
    );
    cache.request("image_a", "image_b");
    await settle();
    expect(requested).toEqual([["image_b"]]);
    expect(images).toHaveLength(1);
    images[0]!.emit("load");
    expect(cache.get("image_a")).not.toBeNull();
    expect(cache.status()).toEqual({ pending: 1, failed: 0 });
    missing.reject(new Error("Export failed"));
    await settle();
    expect(cache.get("image_a")).not.toBeNull();
    expect(cache.status()).toEqual({ pending: 0, failed: 1 });
  });

  it("keeps cache reads moving while all export slots are occupied", async () => {
    const exporting = deferred<ImageBytesBatch>();
    const { makeImage, images } = captureImages();
    const cache = new ByteImageCache(
      () => exporting.promise,
      makeImage,
      () => undefined,
      async (ids) => recordsFor(ids, ids.includes("cached_image") ? imageBytes() : null),
      MAX_PREVIEW_EXPORT_BATCHES_IN_FLIGHT,
    );
    cache.request(
      ...Array.from(
        { length: MAX_REFS_PER_REQUEST * MAX_PREVIEW_EXPORT_BATCHES_IN_FLIGHT },
        (_, i) => `missing_${i}`,
      ),
    );
    await settle();
    await settle();
    cache.request("cached_image");
    await settle();
    expect(images).toHaveLength(1);
    images[0]!.emit("load");
    expect(cache.get("cached_image")).not.toBeNull();
    exporting.resolve({});
    await settle();
  });

  it("does not export misses retired while the cache lookup was pending", async () => {
    const lookup = deferred<ImageBytesBatch>();
    const loads: string[][] = [];
    const cache = new ByteImageCache(
      async (wanted) => {
        loads.push([...wanted]);
        return {};
      },
      okImage,
      () => undefined,
      () => lookup.promise,
    );
    cache.request("image_a");
    await settle();
    cache.beginDraw();
    cache.endDraw();
    lookup.resolve({ image_a: null });
    await settle();
    expect(loads).toEqual([]);
    expect(cache.status()).toEqual({ pending: 0, failed: 0 });
  });
});

describe("ByteImageCache failed attempts", () => {
  it("never re-queues a failed ref from request() — the per-paint onMissing loop is bounded", async () => {
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      Object.fromEntries(refs.map(nullFor)),
    );
    const cache = new ByteImageCache(loadBytes, okImage);
    cache.request("a");
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(1);

    // 50 more paints asking for the same missing raster: no refetch, no second batch.
    for (let paint = 0; paint < 50; paint += 1) cache.request("a");
    cache.get("a");
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(cache.has("a")).toBe(false);
  });

  it("notifies the visible demand ledger when transport fails so Loading does not remain painted", async () => {
    const changes: { pending: number; failed: number }[] = [];
    const cache = new ByteImageCache(
      async () => {
        throw new Error("Transport failed");
      },
      okImage,
      () => changes.push(cache.status()),
    );
    cache.request("image_a");
    await settle();
    expect(changes).toEqual([{ pending: 0, failed: 1 }]);
    for (let paint = 0; paint < 20; paint++) cache.get("image_a");
    await settle();
    expect(changes).toHaveLength(1);
  });

  it("caches a transport rejection too, and clear() re-arms the retry", async () => {
    const loadBytes = vi.fn(async () => {
      throw new Error("ws down");
    });
    const cache = new ByteImageCache(loadBytes, okImage);
    cache.request("a");
    await settle();
    cache.request("a");
    cache.get("a");
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(1);

    cache.clear(); // reconnect
    cache.request("a");
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it("a decode error cannot resurrect: the failed image is not refetched per paint", async () => {
    const image = new FakeImage();
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      Object.fromEntries(refs.map(bytesFor)),
    );
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, decodesTo(image), onReady);
    cache.request("a");
    await settle();
    expect(cache.has("a")).toBe(false); // bytes received is not decoded-ready
    image.emit("load"); // <img> decoded
    expect(cache.has("a")).toBe(true);

    image.emit("error"); // <img> failed to decode
    expect(cache.has("a")).toBe(false);
    onReady.mockClear();

    for (let paint = 0; paint < 25; paint += 1) {
      cache.request("a");
      expect(cache.get("a")).toBeNull();
    }
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(1); // dead ref stays dead until clear()
    expect(onReady).not.toHaveBeenCalled(); // and the error loop does not keep notifying
  });

  it("drops a stale success after clear(): no repopulate, no notify for the current generation", async () => {
    const load = deferred<Record<string, FigmaBytes | null>>();
    const loadBytes = vi.fn(() => load.promise);
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, okImage, onReady);
    cache.request("a");
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(1);

    cache.clear(); // scope changed mid-flight
    onReady.mockClear();
    load.resolve({ a: imageBytes() });
    await settle();
    expect(onReady).not.toHaveBeenCalled(); // stale settle must not repaint the new scope
    expect(cache.has("a")).toBe(false); // stale bytes must not repopulate the fresh cache

    cache.request("a"); // the new scope asks on its own terms
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it("a stale rejection after clear() cannot mark the new generation failed", async () => {
    const load = deferred<Record<string, FigmaBytes | null>>();
    const loadBytes = vi.fn(() => load.promise);
    const cache = new ByteImageCache(loadBytes, okImage);
    cache.request("a");
    await settle();
    cache.clear();
    load.reject(new Error("gone"));
    await settle();
    // Not failed (the failure belonged to the dead scope), so a fresh ask fetches again…
    expect(cache.get("a")).toBeNull();
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it("singleflights concurrent asks and caps every batch at the wire limit", async () => {
    const seen: string[][] = [];
    const loadBytes = vi.fn(async (refs: readonly string[]) => {
      seen.push([...refs]);
      return Object.fromEntries(refs.map(nullFor));
    });
    const cache = new ByteImageCache(loadBytes, okImage);
    cache.get("a");
    cache.get("a"); // same tick, still loading-queued
    cache.request("a");
    const refs: string[] = [];
    for (let i = 0; i < MAX_REFS_PER_REQUEST + 5; i += 1) refs.push(`r${i}`);
    cache.request(...refs);
    await settle();
    expect(loadBytes.mock.calls.map((call) => (call[0] as string[]).length)).toEqual([
      MAX_REFS_PER_REQUEST,
      6,
    ]);
    expect(seen[0]).toHaveLength(MAX_REFS_PER_REQUEST);
    expect(seen.flat().filter((ref) => ref === "a")).toHaveLength(1);
  });
});

describe("FontCache failed fonts are terminal until clear()", () => {
  const bytes = imageBytes();

  it("repeated paints for a null font fetch once and notify once", async () => {
    const loadFont = vi.fn(async () => null as FigmaBytes | null);
    const register = vi.fn(async () => true);
    const onReady = vi.fn();
    const cache = new FontCache(loadFont, register, onReady);

    for (let paint = 0; paint < 100; paint += 1) {
      expect(cache.fontAvailable("Inter", "Bold")).toBe(false);
    }
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1); // one settle, then silence — no paint feedback loop

    for (let paint = 0; paint < 50; paint += 1) {
      expect(cache.fontAvailable("Inter", "Bold")).toBe(false);
    }
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(1);
  });

  it("a register() false result is cached like a rejection, not retried per paint", async () => {
    const loadFont = vi.fn(async () => bytes);
    const register = vi.fn(async () => false);
    const onReady = vi.fn();
    const cache = new FontCache(loadFont, register, onReady);
    for (let paint = 0; paint < 10; paint += 1)
      expect(cache.fontAvailable("Roboto", "Regular")).toBe(false);
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
    for (let paint = 0; paint < 10; paint += 1)
      expect(cache.fontAvailable("Roboto", "Regular")).toBe(false);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("a throwing load is cached false; clear() is the only retry door", async () => {
    const loadFont = vi.fn(async () => {
      throw new Error("daemon offline");
    });
    const cache = new FontCache(loadFont, async () => true);
    expect(cache.fontAvailable("Lato", "Black")).toBe(false);
    await settle();
    expect(cache.fontAvailable("Lato", "Black")).toBe(false);
    expect(loadFont).toHaveBeenCalledTimes(1);

    cache.clear(); // reconnect: the font may exist now
    expect(cache.fontAvailable("Lato", "Black")).toBe(false);
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(2);
  });

  it("a successful registration is cached true without refetching", async () => {
    const loadFont = vi.fn(async () => bytes);
    const register = vi.fn(async () => true);
    const cache = new FontCache(loadFont, register);
    expect(cache.fontAvailable("Inter", "Medium")).toBe(false);
    await settle();
    for (let paint = 0; paint < 20; paint += 1)
      expect(cache.fontAvailable("Inter", "Medium")).toBe(true);
    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("singleflights concurrent attempts for the same family/style", async () => {
    const load = deferred<FigmaBytes | null>();
    const loadFont = vi.fn(() => load.promise);
    const cache = new FontCache(loadFont, async () => true);
    for (let i = 0; i < 5; i += 1) expect(cache.fontAvailable("Inter", "Bold")).toBe(false);
    load.resolve(bytes);
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(cache.fontAvailable("Inter", "Bold")).toBe(true);
  });

  it("drops a stale settle after clear(): no register, no repopulate, no notify", async () => {
    const load = deferred<FigmaBytes | null>();
    const loadFont = vi.fn(() => load.promise);
    const register = vi.fn(async () => true);
    const onReady = vi.fn();
    const cache = new FontCache(loadFont, register, onReady);
    expect(cache.fontAvailable("Inter", "Bold")).toBe(false);
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(1);

    cache.clear(); // owner unmounted / scope swapped mid-fetch
    onReady.mockClear();
    load.resolve(bytes);
    await settle();
    expect(register).not.toHaveBeenCalled(); // a dead scope must not touch the DOM registrar
    expect(onReady).not.toHaveBeenCalled(); // stale notify would re-enter the paint loop
    // The fresh generation asks on its own terms rather than trusting the stale true:
    expect(cache.fontAvailable("Inter", "Bold")).toBe(false);
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(2);
  });

  it("drops a stale rejection after clear() without poisoning the cache", async () => {
    const load = deferred<FigmaBytes | null>();
    const loadFont = vi.fn(() => load.promise);
    const cache = new FontCache(loadFont, async () => true);
    expect(cache.fontAvailable("Inter", "Bold")).toBe(false);
    await settle();
    cache.clear();
    load.reject(new Error("socket closed"));
    await settle();
    expect(cache.fontAvailable("Inter", "Bold")).toBe(false); // not cached false → retries
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(2);
  });

  it("hands the registrar a live isCurrent predicate that clear() retires", async () => {
    const reg = deferred<boolean>();
    let capturedIsCurrent!: () => boolean;
    const loadFont = vi.fn(async () => bytes);
    const register = vi.fn(async (_f: string, _s: string, _d: string, isCurrent: () => boolean) => {
      capturedIsCurrent = isCurrent;
      return reg.promise;
    });
    const onReady = vi.fn();
    const cache = new FontCache(loadFont, register, onReady);
    cache.fontAvailable("Inter", "Bold");
    await settle(); // register is now in flight (it re-checks the predicate after its own await)
    expect(capturedIsCurrent()).toBe(true);

    cache.clear(); // unmount/scope swap during face.load()
    expect(capturedIsCurrent()).toBe(false); // the registrar's guard sees the dead scope
    reg.resolve(false); // a well-behaved registrar commits nothing
    await settle();
    expect(onReady).not.toHaveBeenCalled(); // and FontCache drops the stale settle regardless

    // Nothing was cached from the stale attempt: a fresh ask re-fetches on the new scope.
    expect(cache.fontAvailable("Inter", "Bold")).toBe(false);
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(2);
  });
});

/** One full synchronous paint: begin, touch what the draw uses, end, drain. */
async function paintOnce(
  cache: { beginDraw(): void; endDraw(): void },
  touch: () => void,
): Promise<void> {
  cache.beginDraw();
  touch();
  cache.endDraw();
  await settle();
}

describe("ByteImageCache paint reconciliation (spec 32.5.1 bounded lifetime)", () => {
  it("retires a decoded image the next draw does not observe; a later ask refetches", async () => {
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      Object.fromEntries(refs.map(bytesFor)),
    );
    const { makeImage, images } = captureImages();
    const cache = new ByteImageCache(loadBytes, makeImage);
    await paintOnce(cache, () => expect(cache.get("a")).toBeNull()); // starts + settles the fetch
    expect(cache.has("a")).toBe(false); // bytes received is not decoded-ready
    images[0]!.emit("load");
    expect(cache.has("a")).toBe(true); // decoded

    await paintOnce(cache, () => undefined); // panned offscreen: nothing observes "a"
    expect(cache.has("a")).toBe(false); // the working set is bounded to the view

    cache.get("a");
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(2); // scrolling back re-fetches (daemon cache serves bytes)
  });

  it("bytes received is not decoded-ready: get stays null and no duplicate fetch while decoding", async () => {
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      Object.fromEntries(refs.map(bytesFor)),
    );
    const { makeImage, images } = captureImages();
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, makeImage, onReady);
    await paintOnce(cache, () => cache.get("a"));
    await settle(); // bytes have arrived; the <img> has not fired load yet
    expect(onReady).not.toHaveBeenCalled(); // no notify for an undecoded image
    expect(cache.has("a")).toBe(false);

    for (let paint = 0; paint < 5; paint += 1) {
      await paintOnce(cache, () => expect(cache.get("a")).toBeNull()); // decode window open
    }
    expect(loadBytes).toHaveBeenCalledTimes(1); // no duplicate fetch while it decodes

    images[0]!.emit("load"); // the decode completes
    expect(onReady).toHaveBeenCalledTimes(1); // only now may the draw be told to repaint
    expect(cache.has("a")).toBe(true);
  });

  it("keys observed across consecutive paints are fetched and settled exactly once", async () => {
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      Object.fromEntries(refs.map(bytesFor)),
    );
    const { makeImage, images } = captureImages();
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, makeImage, onReady);
    for (let frame = 0; frame < 4; frame += 1) {
      await paintOnce(cache, () => cache.get("a")); // still-visible tile every paint
    }
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled(); // decoding: nothing to notify yet
    images[0]!.emit("load");
    expect(onReady).toHaveBeenCalledTimes(1); // one decode notify, then quiet
    expect(cache.has("a")).toBe(true);

    await paintOnce(cache, () => cache.get("a")); // still visible: no refetch, no re-notify
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("a still-visible pending attempt survives its paint and settles on decode", async () => {
    const first = deferred<Record<string, FigmaBytes | null>>();
    const loadBytes = vi.fn(() => first.promise);
    const { makeImage, images } = captureImages();
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, makeImage, onReady);

    await paintOnce(cache, () => cache.get("a")); // observed → survives this draw
    await paintOnce(cache, () => cache.get("a")); // observed again → still singleflighted
    expect(loadBytes).toHaveBeenCalledTimes(1);

    first.resolve({ a: imageBytes() }); // the visible load completes
    await settle();
    expect(onReady).not.toHaveBeenCalled(); // bytes are not readiness
    expect(cache.get("a")).toBeNull(); // the renderer still sees no image

    images[0]!.emit("load"); // decoded
    expect(onReady).toHaveBeenCalled(); // it belongs to the live scope: repaint
    expect(cache.has("a")).toBe(true);
  });

  it("a stale load after retire cannot ready or notify the current draw", async () => {
    const load = deferred<Record<string, FigmaBytes | null>>();
    const loadBytes = vi.fn(() => load.promise);
    const { makeImage, images } = captureImages();
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, makeImage, onReady);
    await paintOnce(cache, () => cache.get("a")); // observed, singleflight started
    load.resolve({ a: imageBytes() });
    await settle(); // bytes land: flush makes the <img>, listeners attached, still decoding
    expect(onReady).not.toHaveBeenCalled(); // bytes received is not readiness
    await paintOnce(cache, () => undefined); // retired BEFORE the decode completes

    images[0]!.emit("load"); // the dead attempt's <img> finally fires load
    expect(onReady).not.toHaveBeenCalled(); // a retired record may not notify the current draw
    expect(cache.has("a")).toBe(false); // …and may not mark itself ready
  });

  it("an unobserved pending attempt cannot resurrect after its late settle", async () => {
    const load = deferred<Record<string, FigmaBytes | null>>();
    const loadBytes = vi.fn(() => load.promise);
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, okImage, onReady);
    await paintOnce(cache, () => cache.get("a")); // starts loading, observed once
    await paintOnce(cache, () => undefined); // retired while still in flight
    onReady.mockClear();

    load.resolve({ a: imageBytes() }); // bytes land after the draw stopped caring
    await settle();
    expect(onReady).not.toHaveBeenCalled(); // dead attempt: no notify for the current draw
    expect(cache.has("a")).toBe(false); // dead attempt: no repopulate

    cache.get("a"); // a fresh ask on the live scope goes through a NEW record
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it("an old attempt's settle cannot clobber a recreated key", async () => {
    const stale = deferred<Record<string, FigmaBytes | null>>();
    const fresh = deferred<Record<string, FigmaBytes | null>>();
    const loads = [stale, fresh];
    let loadIndex = 0;
    const loadBytes = vi.fn(() => loads[loadIndex++]!.promise);
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, okImage, onReady);
    await paintOnce(cache, () => cache.get("a")); // attempt A loading, observed
    await paintOnce(cache, () => undefined); // A retired mid-flight

    cache.get("a"); // attempt B (new record) on the current scope
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(2);

    stale.resolve({ a: imageBytes() }); // A settles onto a map holding B
    await settle();
    expect(onReady).not.toHaveBeenCalled(); // A may not notify…
    expect(cache.has("a")).toBe(false); // …and A's bytes may not pretend to be ready

    fresh.resolve({ a: null }); // B settles failed (no image to decode)
    await settle();
    expect(onReady).toHaveBeenCalledTimes(1); // only the live attempt notifies
    expect(cache.has("a")).toBe(false);
  });

  it("an empty draw clears decoded, failed and pending alike", async () => {
    const pending = deferred<Record<string, FigmaBytes | null>>();
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      refs.includes("p") ? pending.promise : Object.fromEntries(refs.map(deadOrBytes)),
    );
    const { makeImage, images } = captureImages();
    const cache = new ByteImageCache(loadBytes, makeImage);
    await paintOnce(cache, () => cache.request("d", "f")); // one decodable, one failed
    images[0]!.emit("load"); // "d" really decoded — a failed decode stays cached failed too
    await paintOnce(cache, () => cache.get("p")); // one still loading, observed

    await paintOnce(cache, () => undefined); // empty paint: nothing survives

    expect(cache.has("d")).toBe(false); // decoded
    cache.get("f"); // failed and pending re-fetch: they were retired, not cached
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(3); // (d,f), (p), (f) — nothing from retirement is sticky
    pending.resolve({ p: null });
    await settle();
  });

  it("has() is a diagnostic and must not count as observing", async () => {
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      Object.fromEntries(refs.map(bytesFor)),
    );
    const { makeImage, images } = captureImages();
    const cache = new ByteImageCache(loadBytes, makeImage);
    await paintOnce(cache, () => cache.get("a"));
    images[0]!.emit("load");
    expect(cache.has("a")).toBe(true);

    await paintOnce(cache, () => expect(cache.has("a")).toBe(true)); // probe only
    expect(cache.has("a")).toBe(false); // the probe did not keep it alive

    cache.get("a");
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it("duplicate beginDraw keeps the open observation; endDraw without beginDraw is a no-op", async () => {
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      Object.fromEntries(refs.map(bytesFor)),
    );
    const { makeImage, images } = captureImages();
    const cache = new ByteImageCache(loadBytes, makeImage);
    cache.beginDraw();
    cache.get("a");
    cache.beginDraw(); // React re-entry: must not reset the observed set
    cache.endDraw();
    await settle();
    images[0]!.emit("load"); // decode completes on the survived record
    expect(cache.has("a")).toBe(true); // observation survived the duplicate begin

    cache.endDraw(); // no open draw → reconcile is a no-op
    expect(cache.has("a")).toBe(true);
  });
});

describe("FontCache paint reconciliation (spec 32.5.1 bounded lifetime)", () => {
  const bytes = imageBytes();

  it("a font observed on consecutive paints is fetched and registered exactly once", async () => {
    const loadFont = vi.fn(async () => bytes);
    const register = vi.fn(async () => true);
    const onReady = vi.fn();
    const cache = new FontCache(loadFont, register, onReady);
    expect(cache.fontAvailable("Inter", "Bold")).toBe(false); // first paint: not yet loaded
    for (let frame = 0; frame < 4; frame += 1) {
      await paintOnce(cache, () => cache.fontAvailable("Inter", "Bold"));
    }
    expect(cache.fontAvailable("Inter", "Bold")).toBe(true);
    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1); // one settle, no repaint feedback
  });

  it("an unobserved font attempt is retired; its late settle registers nothing and notifies nothing", async () => {
    const load = deferred<FigmaBytes | null>();
    const loadFont = vi.fn(() => load.promise);
    const register = vi.fn(async () => true);
    const onReady = vi.fn();
    const cache = new FontCache(loadFont, register, onReady);
    await paintOnce(cache, () => cache.fontAvailable("Inter", "Bold")); // observed once, fetching
    await paintOnce(cache, () => undefined); // next paint has no text: retired in flight

    load.resolve(bytes);
    await settle();
    expect(register).not.toHaveBeenCalled(); // a retired record never touches the DOM registrar
    expect(onReady).not.toHaveBeenCalled(); // nor notifies the current draw
    expect(cache.fontAvailable("Inter", "Bold")).toBe(false); // fresh ask: not cached → refetch
    await settle();
    expect(loadFont).toHaveBeenCalledTimes(2);
  });

  it("registrar isCurrent includes record liveness, not just the scope generation", async () => {
    const load = deferred<FigmaBytes | null>();
    const loadFont = vi.fn(() => load.promise);
    let capturedIsCurrent!: () => boolean;
    const reg = deferred<boolean>();
    const register = vi.fn(async (_f: string, _s: string, _d: string, isCurrent: () => boolean) => {
      capturedIsCurrent = isCurrent;
      return reg.promise;
    });
    const onReady = vi.fn();
    const cache = new FontCache(loadFont, register, onReady);
    await paintOnce(cache, () => cache.fontAvailable("Inter", "Bold")); // observed → survives
    load.resolve(bytes);
    await settle(); // register now in flight
    expect(capturedIsCurrent()).toBe(true); // the live record's predicate is true

    await paintOnce(cache, () => undefined); // unobserved reconcile retires the record — no clear()
    expect(capturedIsCurrent()).toBe(false); // the registrar sees the death through the record

    reg.resolve(true); // the registrar commits as if still owned
    await settle();
    expect(onReady).not.toHaveBeenCalled(); // FontCache still drops the stale settle
    expect(cache.fontAvailable("Inter", "Bold")).toBe(false); // and nothing was cached
  });
});

describe("rasterRung / rasterNamespace (ADR-0042 resolution lattice)", () => {
  it("ceil-quantizes the device scale to 1..4 and degrades safely", () => {
    expect(rasterRung(0.5)).toBe(1); // overview zoom: never below 1
    expect(rasterRung(1)).toBe(1);
    expect(rasterRung(1.01)).toBe(2); // any oversample need jumps to the next rung
    expect(rasterRung(2)).toBe(2);
    expect(rasterRung(2.7)).toBe(3); // the 332%×DPR2 context would ceil to 7 → clamped 4
    expect(rasterRung(3.9)).toBe(4);
    expect(rasterRung(6.64)).toBe(4); // clamped at the API max — 32 MP cap keeps honesty
    expect(rasterRung(32)).toBe(4);
    expect(rasterRung(Number.NaN)).toBe(2); // unreadable camera falls back to the legacy rung
    expect(rasterRung(0)).toBe(2);
    expect(rasterRung(-1)).toBe(2);
    expect(rasterRung(Number.POSITIVE_INFINITY)).toBe(2); // unreadable camera → safe legacy rung
    // The lattice is finite by construction: one cache per integer rung at most.
    const rungs = new Set([0.1, 0.5, 1, 1.2, 2, 2.1, 3, 3.1, 4, 4.5, 9].map(rasterRung));
    expect([...rungs].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("namespaces separate scale, format, bounds and version — never cross-served", () => {
    const png2 = rasterNamespace(2, "png", "crop", "v1");
    expect(png2).toBe("2@png@crop@v1");
    expect(rasterNamespace(2, "svg", "crop", "v1")).not.toBe(png2); // format isolates SVG
    expect(rasterNamespace(2, "png", "absolute", "v1")).not.toBe(png2); // bounds isolate crop
    expect(rasterNamespace(1, "png", "crop", "v1")).not.toBe(png2); // rung isolates zoom
    expect(rasterNamespace(2, "png", "crop", "v2")).not.toBe(png2); // snapshot isolates version
    expect(rasterNamespace(2, "png", "crop", null)).toBe("2@png@crop@live");
  });
});

describe("ByteImageCache.stateOf (non-observing phase probe)", () => {
  it("tracks the real lifecycle without starting fetches or pinning keys", async () => {
    const loadBytes = vi.fn(async (ids: readonly string[]) => recordsFor(ids, imageBytes()));
    const { makeImage, images } = captureImages();
    const cache = new ByteImageCache(loadBytes, makeImage, () => undefined);

    expect(cache.stateOf("x")).toBeNull(); // never asked: no record, no fetch
    expect(loadBytes).not.toHaveBeenCalled();

    expect(cache.get("x")).toBeNull(); // get() is the observing start
    expect(cache.stateOf("x")).toBe("queued");
    await settle();
    expect(cache.stateOf("x")).toBe("loading");
    images[0]!.emit("load");
    expect(cache.stateOf("x")).toBe("ready");
    expect(cache.get("x")).not.toBeNull();

    const load2 = vi.fn(async (ids: readonly string[]) => recordsFor(ids, null));
    const cache2 = new ByteImageCache(load2, makeImage, () => undefined);
    cache2.get("y");
    await settle();
    expect(cache2.stateOf("y")).toBe("failed"); // bytes-null is a terminal negative cache entry
    // Repeated probes never resurrect or refetch: the failed "y" stays terminal without a
    // second wire ask (the negative cache the draw-owner budgets depend on).
    cache2.stateOf("y");
    cache2.stateOf("y");
    expect(load2).toHaveBeenCalledTimes(1);
    expect(cache2.stateOf("y")).toBe("failed");
  });

  it("stateOf alone during a paint does not save an unobserved key from reconciliation", async () => {
    const cache = new ByteImageCache(
      async (ids) => Object.fromEntries(ids.map((id) => [id, imageBytes()])),
      okImage,
      () => undefined,
    );
    cache.beginDraw();
    cache.get("kept");
    expect(cache.stateOf("probed-only")).toBeNull(); // a miss: stateOf must not enqueue either
    cache.endDraw();
    await settle();
    expect(cache.stateOf("probed-only")).toBeNull();
    expect(cache.stateOf("kept")).not.toBeNull(); // the observed key survived
  });
});

describe("FontCache.unresolved (non-observing per-key ledger)", () => {
  it("lists loading and failed attempts by key, omits successes, and never observes", async () => {
    const okLoad = vi.fn(async () => imageBytes());
    const failLoad = vi.fn(async () => null);
    const cache = new FontCache(
      okLoad,
      async () => true,
      () => undefined,
    );
    await paintOnce(cache, () => cache.fontAvailable("Inter", "Bold"));
    await settle();
    expect(cache.fontAvailable("Inter", "Bold")).toBe(true); // observed again so it survives
    expect(cache.unresolved()).toEqual([]); // a success is not an unresolved attempt

    const failing = new FontCache(
      failLoad,
      async () => false,
      () => undefined,
    );
    failing.beginDraw();
    expect(failing.fontAvailable("SF Pro Text", "Semibold")).toBe(false);
    failing.endDraw();
    await settle();
    expect(failing.unresolved()).toEqual([{ key: "SF Pro Text\u0000Semibold", pending: false }]);
    // The probe does not pin: an empty paint reconciles even while unresolved() keeps reporting.
    failing.beginDraw();
    failing.unresolved();
    failing.endDraw();
    await settle();
    expect(failing.unresolved()).toEqual([]);
  });

  it("an in-flight attempt reports pending until it settles", async () => {
    const load = deferred<FigmaBytes | null>();
    const cache = new FontCache(
      () => load.promise,
      async () => true,
      () => undefined,
    );
    cache.beginDraw();
    cache.fontAvailable("Hiragino Kaku Gothic ProN", "W6");
    cache.endDraw();
    expect(cache.unresolved()).toEqual([
      { key: "Hiragino Kaku Gothic ProN\u0000W6", pending: true },
    ]);
    load.resolve(imageBytes());
    await settle();
    cache.beginDraw();
    cache.fontAvailable("Hiragino Kaku Gothic ProN", "W6");
    cache.endDraw();
    await settle();
    expect(cache.unresolved()).toEqual([]); // settled-ok drops out of the ledger entirely
  });
});
