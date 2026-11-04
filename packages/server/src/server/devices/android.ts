import type { ChildProcess } from "node:child_process";
import type { SimButton, SimUiElement } from "@jagentdesk/protocol/simulator/rpc-schemas";
import type { Adb } from "./adb.js";
import { parseGetprop } from "./adb.js";
import { DeviceError } from "./errors.js";

// Android over the host's adb (spec 24.6 table, 27.1). Coordinates are device pixels.

// android.view.KeyEvent constants.
export const ANDROID_KEYCODES: Partial<Record<SimButton, number>> = {
  home: 3,
  back: 4,
  "volume-up": 24,
  "volume-down": 25,
  power: 26,
  "app-switch": 187,
  lock: 223, // KEYCODE_SLEEP: screen off without toggling it back on
};

export interface AndroidInfo {
  name: string;
  model: string;
  osVersion: string;
  isEmulator: boolean;
}

export function androidInfoFromProps(props: Map<string, string>, deviceName: string): AndroidInfo {
  const manufacturer = props.get("ro.product.manufacturer") ?? "";
  const model = props.get("ro.product.model") ?? "";
  const fullModel =
    manufacturer && model && !model.toLowerCase().startsWith(manufacturer.toLowerCase())
      ? `${manufacturer} ${model}`
      : model || manufacturer;
  const isEmulator = props.get("ro.kernel.qemu") === "1" || props.get("ro.boot.qemu") === "1";
  return {
    name: deviceName.trim() || fullModel || "Android device",
    model: fullModel,
    osVersion: props.get("ro.build.version.release") ?? "",
    isEmulator,
  };
}

// `wm size`: "Physical size: 1080x2400" and, when set, "Override size: 720x1600" (which wins).
export function parseWmSize(stdout: string): { width: number; height: number } | null {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(stdout);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(stdout);
  const match = override ?? physical;
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

// `uiautomator dump` XML: one <node … bounds="[x1,y1][x2,y2]"> per view.
export function parseUiautomatorDump(xml: string): SimUiElement[] {
  const elements: SimUiElement[] = [];
  for (const match of xml.matchAll(/<node\s([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>();
    for (const attr of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs.set(attr[1], decodeXmlEntities(attr[2]));
    }
    const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attrs.get("bounds") ?? "");
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    const className = attrs.get("class") ?? "";
    elements.push({
      role: className.split(".").pop() ?? className,
      label: attrs.get("text") || attrs.get("content-desc") || "",
      identifier: attrs.get("resource-id") ?? "",
      x: x1,
      y: y1,
      width: x2 - x1,
      height: y2 - y1,
      enabled: attrs.get("enabled") !== "false",
    });
  }
  return elements;
}

// `input text` treats %s as a space and splits on whitespace.
export function inputTextArg(text: string): string {
  return text.replace(/%/g, "\\%").replace(/ /g, "%s");
}

const UI_DUMP_PATH = "/data/local/tmp/jagentdesk-ui.xml";

export class AndroidDevice {
  private infoCache: AndroidInfo | null = null;
  private naturalSize: { width: number; height: number } | null = null;

  constructor(
    private readonly adb: Adb,
    readonly serial: string,
  ) {}

  async info(): Promise<AndroidInfo> {
    if (this.infoCache) return this.infoCache;
    const props = parseGetprop(await this.adb.run(["-s", this.serial, "shell", "getprop"], 10_000));
    const deviceName = await this.adb
      .shell(this.serial, ["settings", "get", "global", "device_name"], 10_000)
      .then((out) => (out.trim() === "null" ? "" : out))
      .catch(() => "");
    this.infoCache = androidInfoFromProps(props, deviceName);
    return this.infoCache;
  }

  screencapPng(): Promise<Buffer> {
    return this.adb.runBuffer(["-s", this.serial, "exec-out", "screencap", "-p"], 30_000);
  }

  // Natural (portrait) display size in pixels.
  async displaySize(): Promise<{ width: number; height: number }> {
    if (this.naturalSize) return this.naturalSize;
    const size = parseWmSize(await this.adb.shell(this.serial, ["wm", "size"], 10_000));
    if (!size) throw new Error("Could not read the display size (wm size)");
    this.naturalSize = size;
    return size;
  }

  async tap(x: number, y: number): Promise<void> {
    await this.adb.shell(this.serial, [
      "input",
      "tap",
      String(Math.round(x)),
      String(Math.round(y)),
    ]);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void> {
    await this.adb.shell(this.serial, [
      "input",
      "swipe",
      ...[x1, y1, x2, y2].map((value) => String(Math.round(value))),
      String(Math.max(1, Math.round(durationMs))),
    ]);
  }

  async text(value: string): Promise<void> {
    await this.adb.shell(this.serial, ["input", "text", inputTextArg(value)]);
  }

  async key(keycode: number): Promise<void> {
    await this.adb.shell(this.serial, ["input", "keyevent", String(keycode)]);
  }

  async rotate(): Promise<void> {
    const current = Number.parseInt(
      (await this.adb.shell(this.serial, ["settings", "get", "system", "user_rotation"])).trim(),
      10,
    );
    const next = Number.isFinite(current) ? (current + 1) % 4 : 1;
    await this.adb.shell(this.serial, ["settings", "put", "system", "accelerometer_rotation", "0"]);
    await this.adb.shell(this.serial, ["settings", "put", "system", "user_rotation", String(next)]);
  }

  async describeUi(): Promise<SimUiElement[]> {
    await this.adb.shell(this.serial, ["uiautomator", "dump", UI_DUMP_PATH], 30_000);
    const xml = await this.adb.runBuffer(["-s", this.serial, "exec-out", "cat", UI_DUMP_PATH]);
    return parseUiautomatorDump(xml.toString("utf8"));
  }

  async installApp(apkPath: string): Promise<void> {
    if (!apkPath.toLowerCase().endsWith(".apk")) {
      throw new DeviceError("unsupported_on_platform", "Android devices install .apk files");
    }
    await this.adb.run(["-s", this.serial, "install", "-r", "-g", apkPath], 300_000);
  }

  async launchApp(packageName: string, terminateExisting: boolean): Promise<void> {
    if (terminateExisting) await this.terminateApp(packageName);
    const out = await this.adb.shell(this.serial, [
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1",
    ]);
    if (/monkey aborted|No activities found/i.test(out)) {
      throw new Error(`No launchable activity in ${packageName}`);
    }
  }

  async terminateApp(packageName: string): Promise<void> {
    await this.adb.shell(this.serial, ["am", "force-stop", packageName]);
  }

  async openUrl(url: string): Promise<void> {
    await this.adb.shell(this.serial, [
      "am",
      "start",
      "-a",
      "android.intent.action.VIEW",
      "-d",
      url,
    ]);
  }

  recentLogs(lines: number): Promise<string> {
    return this.adb.run([
      "-s",
      this.serial,
      "logcat",
      "-d",
      "-v",
      "threadtime",
      "-t",
      String(lines),
    ]);
  }

  streamLogs(): ChildProcess {
    return this.adb.spawn(["-s", this.serial, "logcat", "-v", "threadtime", "-T", "200"]);
  }
}
