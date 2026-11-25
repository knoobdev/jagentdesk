import http from "node:http";
import type { SimUiElement } from "@jagentdesk/protocol/simulator/rpc-schemas";
import { JpegStreamSplitter, SCREEN_JPEG_QUALITY, SCREEN_MAX_DIM } from "./image.js";

// WebDriverAgent (appium/WebDriverAgent) over a 127.0.0.1 forward. Routes checked against
// WebDriverAgentLib/Commands/*.m @ v16.15.3. Coordinates are points.

export const WDA_VERSION = "16.15.3";
export const WDA_DEVICE_PORT = 8100;
export const WDA_MJPEG_DEVICE_PORT = 9100;

export class WdaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "WdaError";
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// GET /source (XML): XCUIElementType* nodes with type/name/label/value/enabled/visible/x/y/w/h.
export function parseWdaSource(xml: string): SimUiElement[] {
  const elements: SimUiElement[] = [];
  for (const match of xml.matchAll(/<(XCUIElementType\w+)\s([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>();
    for (const attr of match[2].matchAll(/(\w+)="([^"]*)"/g)) {
      attrs.set(attr[1], decodeXmlEntities(attr[2]));
    }
    if (attrs.get("visible") === "false") continue;
    const x = Number(attrs.get("x"));
    const y = Number(attrs.get("y"));
    const width = Number(attrs.get("width"));
    const height = Number(attrs.get("height"));
    if (![x, y, width, height].every(Number.isFinite)) continue;
    elements.push({
      role: match[1].replace(/^XCUIElementType/, ""),
      label: attrs.get("label") || attrs.get("value") || "",
      identifier: attrs.get("name") ?? "",
      x,
      y,
      width,
      height,
      enabled: attrs.get("enabled") !== "false",
    });
  }
  return elements;
}

// iOS hardware button names WDA accepts on /wda/pressButton (XCUIDevice+FBHelpers.m).
export const WDA_BUTTONS = { home: "home", "volume-up": "volumeUp", "volume-down": "volumeDown" };

export class WdaClient {
  private sessionId: string | null = null;

  constructor(private readonly port: number) {}

  private request(method: "GET" | "POST", route: string, body?: unknown): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.port,
          method,
          path: route,
          headers: payload
            ? { "content-type": "application/json", "content-length": payload.length }
            : {},
          timeout: 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = null;
            }
            const value =
              parsed && typeof parsed === "object" && "value" in parsed
                ? (parsed as { value: unknown }).value
                : null;
            const status = res.statusCode ?? 0;
            if (status >= 400) {
              const message =
                value && typeof value === "object" && "message" in value
                  ? String((value as { message: unknown }).message)
                  : text.slice(0, 300);
              reject(new WdaError(status, message));
              return;
            }
            resolve(value);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("WebDriverAgent did not answer")));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async status(): Promise<boolean> {
    return this.request("GET", "/status").then(
      () => true,
      () => false,
    );
  }

  private async session(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const value = (await this.request("POST", "/session", {
      capabilities: { alwaysMatch: {}, firstMatch: [{}] },
    })) as { sessionId?: unknown } | null;
    if (!value || typeof value.sessionId !== "string") {
      throw new Error("WebDriverAgent did not open a session");
    }
    this.sessionId = value.sessionId;
    await this.request("POST", `/session/${this.sessionId}/appium/settings`, {
      settings: {
        mjpegServerFramerate: 15,
        mjpegServerScreenshotQuality: SCREEN_JPEG_QUALITY,
        mjpegScalingFactor: 100,
      },
    });
    return this.sessionId;
  }

  private async sessionCall(method: "GET" | "POST", route: string, body?: unknown) {
    const id = await this.session();
    return this.request(method, `/session/${id}${route}`, body);
  }

  // WDA streams at the screen's pixel size; scale it down so the long edge stays ≤ SCREEN_MAX_DIM.
  async fitMjpeg(frameWidth: number, frameHeight: number): Promise<void> {
    const longEdge = Math.max(frameWidth, frameHeight);
    if (longEdge <= SCREEN_MAX_DIM) return;
    await this.sessionCall("POST", "/appium/settings", {
      settings: { mjpegScalingFactor: Math.floor((SCREEN_MAX_DIM / longEdge) * 100) },
    });
  }

  tap(x: number, y: number): Promise<unknown> {
    return this.sessionCall("POST", "/wda/tap", { x, y });
  }

  drag(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<unknown> {
    return this.sessionCall("POST", "/wda/dragfromtoforduration", {
      fromX: x1,
      fromY: y1,
      toX: x2,
      toY: y2,
      duration: Math.max(0.05, durationMs / 1000),
    });
  }

  type(text: string): Promise<unknown> {
    return this.sessionCall("POST", "/wda/keys", { value: Array.from(text) });
  }

  pressButton(name: string): Promise<unknown> {
    return this.sessionCall("POST", "/wda/pressButton", { name });
  }

  home(): Promise<unknown> {
    return this.request("POST", "/wda/homescreen");
  }

  lock(): Promise<unknown> {
    return this.request("POST", "/wda/lock");
  }

  async locked(): Promise<boolean> {
    return (await this.request("GET", "/wda/locked")) === true;
  }

  async source(): Promise<SimUiElement[]> {
    const xml = await this.sessionCall("GET", "/source?format=xml");
    return typeof xml === "string" ? parseWdaSource(xml) : [];
  }

  async windowSize(): Promise<{ width: number; height: number }> {
    const value = (await this.sessionCall("GET", "/window/size")) as {
      width?: unknown;
      height?: unknown;
    } | null;
    if (!value || typeof value.width !== "number" || typeof value.height !== "number") {
      throw new Error("WebDriverAgent did not report the window size");
    }
    return { width: value.width, height: value.height };
  }

  async screenshotPng(): Promise<Buffer> {
    const value = await this.request("GET", "/screenshot");
    if (typeof value !== "string") throw new Error("WebDriverAgent returned no screenshot");
    return Buffer.from(value, "base64");
  }

  launchApp(bundleId: string): Promise<unknown> {
    return this.sessionCall("POST", "/wda/apps/launch", { bundleId });
  }

  terminateApp(bundleId: string): Promise<unknown> {
    return this.sessionCall("POST", "/wda/apps/terminate", { bundleId });
  }

  openUrl(url: string): Promise<unknown> {
    return this.sessionCall("POST", "/url", { url });
  }
}

export interface MjpegStream {
  close(): void;
}

// WDA's MJPEG server (multipart/x-mixed-replace) — each part is one JPEG, already ≤ the configured
// framerate; the splitter ignores the multipart framing and cuts on JPEG markers.
export function openMjpegStream(options: {
  port: number;
  onFrame: (jpeg: Buffer) => void;
  onEnd: (reason: string) => void;
}): MjpegStream {
  const splitter = new JpegStreamSplitter();
  const req = http.get({ host: "127.0.0.1", port: options.port, path: "/" }, (res) => {
    res.on("data", (chunk: Buffer) => {
      for (const jpeg of splitter.push(chunk)) options.onFrame(jpeg);
    });
    res.on("end", () => options.onEnd("MJPEG stream ended"));
    res.on("error", () => options.onEnd("MJPEG stream failed"));
  });
  req.on("error", () => options.onEnd("MJPEG stream failed"));
  return { close: () => req.destroy() };
}
