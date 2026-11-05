import { mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { cachePathFor, FigmaDiskCache, FIGMA_CACHE_MAX_BYTES } from "./cache.js";

// The disk cache is the one place cached Figma JSON and bytes (renders, image fills, fonts) live
// between daemon restarts, under a 2 GB LRU cap (spec 32.3, 32.8). Real filesystem, temp home.

function tempHome(): string {
  return mkdtempSync(path.join(os.tmpdir(), "jad-figma-cache-"));
}

describe("FigmaDiskCache", () => {
  let home: string;
  let clock: { now: number };

  const makeCache = (maxBytes?: number): FigmaDiskCache => {
    clock = { now: 1_000 };
    return new FigmaDiskCache(path.join(home, "figma", "cache"), {
      maxBytes,
      now: () => clock.now,
    });
  };

  beforeEach(() => {
    home = tempHome();
  });

  it("round-trips JSON entries", async () => {
    const cache = makeCache();
    expect(await cache.getJson("file/abc/outline@v1")).toBeNull();
    await cache.putJson("file/abc/outline@v1", { name: "Marketing", pages: [] });
    expect(await cache.getJson("file/abc/outline@v1")).toEqual({ name: "Marketing", pages: [] });
  });

  it("round-trips bytes with the mime type in a sidecar next to the payload", async () => {
    const cache = makeCache();
    await cache.putBytes("render/abc/1:2@2x@png@v1", {
      mimeType: "image/png",
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    const hit = await cache.getBytes("render/abc/1:2@2x@png@v1");
    expect(hit?.mimeType).toBe("image/png");
    expect([...hit!.data]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const dir = path.dirname(
      cachePathFor(path.join(home, "figma", "cache"), "render/abc/1:2@2x@png@v1", ".bin"),
    );
    const files = readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".bin"))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith(".mime"))).toHaveLength(1);
  });

  it("keeps keys that differ only in unsafe characters distinct and filesystem-safe", async () => {
    const cache = makeCache();
    await cache.putJson("node/abc/1:2@v1", { id: "1:2" });
    await cache.putJson("node/abc/1-2-v1", { id: "dash" });
    await cache.putJson("node/abc/1 2", { id: "space" });
    expect(await cache.getJson("node/abc/1:2@v1")).toEqual({ id: "1:2" });
    expect(await cache.getJson("node/abc/1-2-v1")).toEqual({ id: "dash" });
    expect(await cache.getJson("node/abc/1 2")).toEqual({ id: "space" });
    const file = path.basename(
      cachePathFor(path.join(home, "figma", "cache"), "node/abc/1:2@v1", ".json"),
    );
    expect(file).toMatch(/^[A-Za-z0-9._-]+\.json$/);
  });

  it("survives a restart of the cache instance", async () => {
    const first = makeCache();
    await first.putJson("imagefills/abc@v1", { images: { ref1: "https://s3.test/a" } });
    const second = makeCache();
    expect(await second.getJson("imagefills/abc@v1")).toEqual({
      images: { ref1: "https://s3.test/a" },
    });
  });

  it("evicts least-recently-used entries beyond the size cap", async () => {
    const cache = makeCache(1000);
    await cache.putBytes("old", { mimeType: "image/png", data: Buffer.alloc(400) });
    clock.now += 1;
    await cache.putBytes("kept", { mimeType: "image/png", data: Buffer.alloc(400) });
    clock.now += 1;
    // Touching `old` makes `kept` the least-recently-used entry instead.
    await cache.getBytes("old");
    clock.now += 1;
    await cache.putBytes("new", { mimeType: "image/png", data: Buffer.alloc(400) });
    expect(await cache.size()).toBeLessThanOrEqual(1000);
    expect(await cache.getBytes("old")).not.toBeNull();
    expect(await cache.getBytes("new")).not.toBeNull();
    expect(await cache.getBytes("kept")).toBeNull();
  });

  it("drops the mime sidecar together with its payload", async () => {
    const cache = makeCache(600);
    await cache.putBytes("first", { mimeType: "image/png", data: Buffer.alloc(500) });
    clock.now += 1;
    await cache.putBytes("second", { mimeType: "image/jpeg", data: Buffer.alloc(500) });
    expect(await cache.getBytes("first")).toBeNull();
    const dir = path.join(home, "figma", "cache");
    const leftovers = readdirSync(dir).filter((f) => f.startsWith("first"));
    expect(leftovers).toEqual([]);
  });

  it("defaults to the 2 GB product cap", async () => {
    const cache = makeCache();
    expect(await cache.size()).toBe(0);
    clock.now += 1;
    await cache.putJson("small", { a: 1 });
    expect(await cache.size()).toBeLessThanOrEqual(FIGMA_CACHE_MAX_BYTES);
  });
});
