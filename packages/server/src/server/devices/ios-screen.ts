import type { SimReadiness } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type { JpegFrame } from "./image.js";

// Spec 27.5 "Nguồn hình iOS": with WebDriverAgent running the screen is WDA's MJPEG (≥ 8 fps);
// without it, frames come from the device's instruments screenshot service over the cable
// (go-ios), which needs neither WDA nor an Apple account. The polled source reports itself as
// "screencap" on the wire (SimScreenSource): the same kind of polled capture Android falls back to.

export type IosScreenSource = "wda-mjpeg" | "screenshot";

export interface IosScreenPlan {
  source: IosScreenSource;
  // WDA is installed and in date but not running: show screenshots now and switch to MJPEG once
  // it is up, instead of holding the first frame for WDA's start (up to 45 s).
  startWdaInBackground: boolean;
}

export function iosScreenPlan(input: {
  wdaRunning: boolean;
  readiness: SimReadiness;
}): IosScreenPlan {
  if (input.wdaRunning) return { source: "wda-mjpeg", startWdaInBackground: false };
  return { source: "screenshot", startWdaInBackground: input.readiness === "ready" };
}

// Readiness values that still let the screen be viewed (SimDevice.screenAvailable). On iOS only
// touch needs WDA; Android needs an authorised adb transport for everything.
export function screenAvailable(platform: "ios" | "android", readiness: SimReadiness): boolean {
  if (readiness === "ready") return true;
  return platform === "ios" && (readiness === "needs_wda" || readiness === "wda_expired");
}

// One screenshot round trip (go-ios process, DTX handshake, PNG over USB, JPEG encode) takes
// about half a second to a second; two captures in flight, staggered, roughly double the rate.
export const SCREENSHOT_WORKERS = 2;
export const SCREENSHOT_MAX_FPS = 6;
export const SCREENSHOT_MAX_FAILURES = 3;

export interface PolledScreenOptions {
  capture(): Promise<Buffer>;
  encode(image: Buffer): Promise<JpegFrame>;
  onFrame(frame: JpegFrame): void;
  onEnd(reason: string): void;
  workers?: number;
  maxFps?: number;
  maxFailures?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Captures with a few requests in flight and emits frames in capture order: a capture that
// finishes after a newer one is dropped, so the picture never steps back in time. A run of
// failures ends the source (the hub restarts it while someone watches).
export class PolledScreen {
  private stopped = false;
  private started = 0;
  private lastEmitted = 0;
  private failures = 0;
  private ended = false;
  private readonly workers: number;
  private readonly spacingMs: number;
  private readonly maxFailures: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: PolledScreenOptions) {
    this.workers = Math.max(1, options.workers ?? SCREENSHOT_WORKERS);
    // Each worker waits workers × (1 / maxFps) between its own captures: the sum stays ≤ maxFps.
    this.spacingMs = (1000 / (options.maxFps ?? SCREENSHOT_MAX_FPS)) * this.workers;
    this.maxFailures = options.maxFailures ?? SCREENSHOT_MAX_FAILURES;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  start(): void {
    for (let index = 0; index < this.workers; index += 1) {
      void this.worker((this.spacingMs / this.workers) * index);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  private async worker(offsetMs: number): Promise<void> {
    if (offsetMs > 0) await this.sleep(offsetMs);
    while (!this.stopped) {
      const begin = this.now();
      this.started += 1;
      const seq = this.started;
      try {
        const frame = await this.options.encode(await this.options.capture());
        this.failures = 0;
        if (!this.stopped && seq > this.lastEmitted) {
          this.lastEmitted = seq;
          this.options.onFrame(frame);
        }
      } catch (error) {
        this.failures += 1;
        if (this.failures >= this.maxFailures) {
          this.end(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      if (this.stopped) return;
      await this.sleep(Math.max(0, this.spacingMs - (this.now() - begin)));
    }
  }

  private end(reason: string): void {
    if (this.ended || this.stopped) return;
    this.ended = true;
    this.stopped = true;
    this.options.onEnd(reason);
  }
}
