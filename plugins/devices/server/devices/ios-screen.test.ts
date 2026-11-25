import { describe, expect, it } from "vitest";
import { developerImageMounted } from "./go-ios.js";
import type { JpegFrame } from "./image.js";
import { PolledScreen, iosScreenPlan, screenAvailable } from "./ios-screen.js";

function frame(tag: number): JpegFrame {
  return { jpeg: Buffer.from([tag]), width: 390, height: 844 };
}

// A manual clock: sleep() resolves at once, so workers run back to back in microtasks.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe("iOS screen source (spec 27.5)", () => {
  it("uses WDA MJPEG only while WDA runs", () => {
    expect(iosScreenPlan({ wdaRunning: true, readiness: "ready" })).toEqual({
      source: "wda-mjpeg",
      startWdaInBackground: false,
    });
  });

  it("shows screenshots at once without WDA and starts an installed WDA alongside", () => {
    expect(iosScreenPlan({ wdaRunning: false, readiness: "ready" })).toEqual({
      source: "screenshot",
      startWdaInBackground: true,
    });
  });

  it("needs no WDA and no Apple account to view an iPhone", () => {
    for (const readiness of ["needs_wda", "wda_expired"] as const) {
      expect(iosScreenPlan({ wdaRunning: false, readiness })).toEqual({
        source: "screenshot",
        startWdaInBackground: false,
      });
      expect(screenAvailable("ios", readiness)).toBe(true);
    }
  });

  it("keeps the screen off for trust, Developer Mode and Android without adb", () => {
    expect(screenAvailable("ios", "needs_trust")).toBe(false);
    expect(screenAvailable("ios", "needs_developer_mode")).toBe(false);
    expect(screenAvailable("android", "needs_wda")).toBe(false);
    expect(screenAvailable("android", "needs_usb_debugging")).toBe(false);
    expect(screenAvailable("android", "ready")).toBe(true);
  });

  it("reads `ios image auto` success from its log lines", () => {
    expect(
      developerImageMounted(
        '{"level":"INFO","msg":"success mounting image","image":"<path>","udid":"<udid>"}',
      ),
    ).toBe(true);
    expect(
      developerImageMounted('{"level":"ERROR","msg":"failed downloading image","err":"404"}'),
    ).toBe(false);
  });
});

describe("PolledScreen", () => {
  it("keeps two captures in flight and never emits an older frame after a newer one", async () => {
    const captures: Array<ReturnType<typeof deferred<Buffer>>> = [];
    const emitted: number[] = [];
    const screen = new PolledScreen({
      capture: () => {
        const next = deferred<Buffer>();
        captures.push(next);
        return next.promise;
      },
      encode: async (image) => frame(image[0]),
      onFrame: (value) => emitted.push(value.jpeg[0]),
      onEnd: () => {},
      workers: 2,
      maxFps: 1000,
      sleep: async () => {},
    });
    screen.start();
    await flush();
    expect(captures).toHaveLength(2);
    // The second capture finishes first; the first one, older, is then dropped.
    captures[1].resolve(Buffer.from([2]));
    await flush();
    captures[0].resolve(Buffer.from([1]));
    await flush();
    expect(emitted).toEqual([2]);
    screen.stop();
    for (const capture of captures) capture.resolve(Buffer.from([9]));
    await flush();
    expect(emitted).toEqual([2]);
  });

  it("ends after a run of failures and reports why", async () => {
    let ended: string | null = null;
    const screen = new PolledScreen({
      capture: async () => {
        throw new Error("Unlock the device.");
      },
      encode: async (image) => frame(image[0]),
      onFrame: () => {},
      onEnd: (reason) => {
        ended = reason;
      },
      workers: 1,
      maxFailures: 3,
      sleep: async () => {},
    });
    screen.start();
    await flush();
    expect(ended).toBe("Unlock the device.");
    expect(screen.isStopped).toBe(true);
  });

  it("forgives a failure followed by a frame", async () => {
    let calls = 0;
    const emitted: number[] = [];
    let ended = false;
    const screen = new PolledScreen({
      capture: async () => {
        calls += 1;
        if (calls % 2 === 1) throw new Error("transient");
        if (calls >= 8) screen.stop();
        return Buffer.from([calls]);
      },
      encode: async (image) => frame(image[0]),
      onFrame: (value) => emitted.push(value.jpeg[0]),
      onEnd: () => {
        ended = true;
      },
      workers: 1,
      maxFailures: 2,
      sleep: async () => {},
    });
    screen.start();
    await flush();
    await flush();
    expect(ended).toBe(false);
    expect(emitted).toEqual([2, 4, 6]);
  });

  it("spaces captures so the total stays at maxFps", async () => {
    const sleeps: number[] = [];
    let now = 0;
    let calls = 0;
    const screen = new PolledScreen({
      capture: async () => {
        calls += 1;
        if (calls >= 3) screen.stop();
        now += 100;
        return Buffer.from([calls]);
      },
      encode: async (image) => frame(image[0]),
      onFrame: () => {},
      onEnd: () => {},
      workers: 1,
      maxFps: 4,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    screen.start();
    await flush();
    // 4 fps with one worker: 250 ms per capture, 100 ms of it spent capturing.
    expect(sleeps.slice(0, 2)).toEqual([150, 150]);
  });
});
