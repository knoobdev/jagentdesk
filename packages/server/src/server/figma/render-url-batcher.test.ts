import { afterEach, describe, expect, it, vi } from "vitest";
import { createRenderUrlBatcher } from "./render-url-batcher.js";
afterEach(() => vi.useRealTimers());

describe("preview export batching", () => {
  it("collects staggered cache misses without deferring a viewport beyond one second", async () => {
    vi.useFakeTimers();
    const exports: string[][] = [];
    const load = createRenderUrlBatcher({
      exportIds: async (ids) => {
        exports.push(ids);
        return Object.fromEntries(ids.map((id) => [id, null]));
      },
      onIdle: () => undefined,
    });
    const results = [load(["1:0"])];
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(200);
      results.push(load([`1:${i}`]));
    }
    expect(exports).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(exports).toEqual([["1:0", "1:1", "1:2", "1:3", "1:4"]]);
    await Promise.all(results);
  });
  it("combines overlapping viewer batches and joins an ID whose export is already running", async () => {
    vi.useFakeTimers();
    let finish!: (urls: Record<string, string | null>) => void;
    const exports: string[][] = [];
    let idle = 0;
    const load = createRenderUrlBatcher({
      exportIds: async (ids) => {
        exports.push(ids);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      onIdle: () => {
        idle++;
      },
    });
    const first = load(["1:1", "1:2"]);
    const second = load(["1:2", "1:3"]);
    await vi.advanceTimersByTimeAsync(250);
    expect(exports).toEqual([["1:1", "1:2", "1:3"]]);
    const joined = load(["1:2"]);
    finish({ "1:1": "<image-a>", "1:2": "<image-b>", "1:3": null });
    expect(await first).toEqual({ "1:1": "<image-a>", "1:2": "<image-b>" });
    expect(await second).toEqual({ "1:2": "<image-b>", "1:3": null });
    expect(await joined).toEqual({ "1:2": "<image-b>" });
    expect(exports).toHaveLength(1);
    expect(idle).toBe(1);
  });
  it("bounds a large viewport to 100 IDs per export and two simultaneous exports", async () => {
    vi.useFakeTimers();
    let active = 0;
    let peak = 0;
    const finish: (() => void)[] = [];
    const sizes: number[] = [];
    const load = createRenderUrlBatcher({
      exportIds: async (ids) => {
        active++;
        peak = Math.max(peak, active);
        sizes.push(ids.length);
        await new Promise<void>((resolve) => finish.push(resolve));
        active--;
        return Object.fromEntries(ids.map((id) => [id, null]));
      },
      onIdle: () => undefined,
    });
    const result = load(Array.from({ length: 225 }, (_, i) => `1:${i}`));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sizes).toEqual([100, 100]);
    expect(peak).toBe(2);
    finish[0]!();
    finish[1]!();
    await vi.advanceTimersByTimeAsync(250);
    expect(sizes).toEqual([100, 100, 25]);
    finish[2]!();
    expect(Object.keys(await result)).toHaveLength(225);
  });
  it("propagates an export error without silently retrying it", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const failure = new Error("Export failed");
    const load = createRenderUrlBatcher({
      exportIds: async () => {
        calls++;
        throw failure;
      },
      onIdle: () => undefined,
    });
    const result = load(["1:1"]);
    const assertion = expect(result).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(calls).toBe(1);
  });
});
