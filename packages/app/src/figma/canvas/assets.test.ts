import { describe, expect, it, vi } from "vitest";
import type { FigmaBytes } from "@jagentdesk/protocol/figma/rpc-schemas";
import { ByteImageCache, FontCache, MAX_REFS_PER_REQUEST, type MakeImage } from "./assets";

// The draw calls get()/request()/fontAvailable() every paint, and every settle notifies (which
// repaints). These regressions pin the feedback loop: a failure is attempted once per scope, and
// a clear() (reconnect, unmount, scope swap) is the ONLY thing that retries or retires a settle.

function imageBytes(): FigmaBytes {
  return { mimeType: "image/png", dataBase64: "AA==" };
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
    expect(cache.has("a")).toBe(true); // images holds the (still) decoded entry

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
    const cache = new ByteImageCache(loadBytes, okImage);
    await paintOnce(cache, () => expect(cache.get("a")).toBeNull()); // starts + settles the fetch
    expect(cache.has("a")).toBe(true);

    await paintOnce(cache, () => undefined); // panned offscreen: nothing observes "a"
    expect(cache.has("a")).toBe(false); // the working set is bounded to the view

    cache.get("a");
    await settle();
    expect(loadBytes).toHaveBeenCalledTimes(2); // scrolling back re-fetches (daemon cache serves bytes)
  });

  it("keys observed across consecutive paints are fetched exactly once", async () => {
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      Object.fromEntries(refs.map(bytesFor)),
    );
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, okImage, onReady);
    for (let frame = 0; frame < 4; frame += 1) {
      await paintOnce(cache, () => cache.get("a")); // still-visible tile every paint
    }
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledTimes(1); // one settle notify, then quiet
    expect(cache.has("a")).toBe(true);
  });

  it("a still-visible pending attempt survives its paint and settles", async () => {
    const first = deferred<Record<string, FigmaBytes | null>>();
    const loadBytes = vi.fn(() => first.promise);
    const onReady = vi.fn();
    const cache = new ByteImageCache(loadBytes, okImage, onReady);

    await paintOnce(cache, () => cache.get("a")); // observed → survives this draw
    await paintOnce(cache, () => cache.get("a")); // observed again → still singleflighted
    expect(loadBytes).toHaveBeenCalledTimes(1);

    first.resolve({ a: imageBytes() }); // the visible load completes
    await settle();
    expect(onReady).toHaveBeenCalled(); // it belongs to the live scope: repaint
    expect(cache.has("a")).toBe(true);
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

    fresh.resolve({ a: null }); // B settles failed
    await settle();
    expect(onReady).toHaveBeenCalledTimes(1); // only the live attempt notifies
    expect(cache.has("a")).toBe(false);
  });

  it("an empty draw clears decoded, failed and pending alike", async () => {
    const pending = deferred<Record<string, FigmaBytes | null>>();
    const loadBytes = vi.fn(async (refs: readonly string[]) =>
      refs.includes("p") ? pending.promise : Object.fromEntries(refs.map(deadOrBytes)),
    );
    const cache = new ByteImageCache(loadBytes, okImage);
    await paintOnce(cache, () => cache.request("d", "f")); // one ready, one failed
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
    const cache = new ByteImageCache(loadBytes, okImage);
    await paintOnce(cache, () => cache.get("a"));
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
    const cache = new ByteImageCache(loadBytes, okImage);
    cache.beginDraw();
    cache.get("a");
    cache.beginDraw(); // React re-entry: must not reset the observed set
    cache.endDraw();
    await settle();
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
