import { describe, expect, it } from "vitest";
import { chunkIds, LruCache, MAX_IDS_PER_REQUEST } from "./batching";

describe("chunkIds", () => {
  it("splits at the wire limit of 50 ids per request", () => {
    expect(MAX_IDS_PER_REQUEST).toBe(50);
    const ids = Array.from({ length: 120 }, (_, index) => `1:${index}`);
    const batches = chunkIds(ids);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(batches.flat()).toEqual(ids);
  });

  it("keeps batches at or below the max", () => {
    for (const size of [0, 1, 50, 51, 100, 501]) {
      const ids = Array.from({ length: size }, (_, index) => `id-${index}`);
      for (const batch of chunkIds(ids)) expect(batch.length).toBeLessThanOrEqual(50);
    }
  });

  it("preserves order and handles exact multiples", () => {
    const ids = Array.from({ length: 100 }, (_, index) => `id-${index}`);
    expect(chunkIds(ids, 25)).toEqual([
      ids.slice(0, 25),
      ids.slice(25, 50),
      ids.slice(50, 75),
      ids.slice(75, 100),
    ]);
    expect(chunkIds([], 10)).toEqual([]);
  });

  it("rejects a batch size below one", () => {
    expect(() => chunkIds(["1"], 0)).toThrow(/≥ 1/);
  });
});

describe("LruCache", () => {
  it("evicts the oldest entry past capacity", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.has("a")).toBe(false);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("refreshes recency on read", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // a is now the newest
    cache.set("c", 3);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("a")).toBe(true);
  });

  it("re-setting a key updates the value, and the write refreshes recency", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 10);
    cache.set("c", 3);
    expect(cache.get("a")).toBe(10);
    expect(cache.has("b")).toBe(false); // b was the oldest once a was rewritten
    expect(cache.has("c")).toBe(true);
  });

  it("exposes keys oldest first", () => {
    const cache = new LruCache<number>(3);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.keys()).toEqual(["a", "b", "c"]);
    cache.get("a");
    expect(cache.keys()).toEqual(["b", "c", "a"]);
  });

  it("distinguishes a cached null from a missing key", () => {
    const cache = new LruCache<number | null>(2);
    cache.set("gone", null);
    expect(cache.has("gone")).toBe(true);
    expect(cache.get("gone")).toBeNull();
    expect(cache.get("never")).toBeUndefined();
  });

  it("clears everything", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.keys()).toEqual([]);
  });
});
