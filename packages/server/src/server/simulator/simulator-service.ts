import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import { execCommand } from "../../utils/spawn.js";
import type {
  SimAction,
  SimAvailability,
  SimButton,
  SimDevice,
  SimDeviceType,
  SimRuntime,
  SimScreenshotFormat,
  SimUiElement,
} from "@jagentdesk/protocol/simulator/rpc-schemas";
import { slim, unslim } from "./simulator-slim.js";
import { MaestroBackend, probeMaestro } from "./simulator-maestro.js";

export interface SimScreenshot {
  base64: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

// Pixel size from the encoded header: PNG IHDR, or the JPEG start-of-frame marker.
export function imageSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = bytes[i + 1];
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

export interface SimSnapshot {
  availability: SimAvailability;
  devices: SimDevice[];
}

function stderrMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { stderr?: unknown; message?: unknown };
    const s = typeof e.stderr === "string" ? e.stderr.trim() : "";
    if (s) return s;
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

// Map our neutral button ids to idb's HID button names.
const IDB_BUTTON: Record<SimButton, string> = {
  home: "HOME",
  lock: "LOCK",
  "side-button": "SIDE_BUTTON",
  siri: "SIRI",
  "apple-pay": "APPLE_PAY",
};

// "com.apple.CoreSimulator.SimRuntime.iOS-18-5" → "iOS 18.5"
function runtimeLabel(runtimeKey: string): string {
  const tail = runtimeKey.split(".").pop() ?? runtimeKey;
  const m = /^([A-Za-z]+)-([0-9-]+)$/.exec(tail);
  if (!m) return tail;
  return `${m[1]} ${m[2].replace(/-/g, ".")}`;
}

// "com.apple.CoreSimulator.SimDeviceType.iPhone-15-Pro" → "iPhone 15 Pro"
function deviceTypeLabel(identifier: string | undefined): string {
  if (!identifier) return "";
  const tail = identifier.split(".").pop() ?? identifier;
  return tail.replace(/-/g, " ");
}

// Thin wrapper over the host `xcrun simctl` + `idb` CLIs backing SimFleet. macOS-only; every
// method degrades or reports unavailable instead of throwing on non-mac / missing tooling.
export class SimulatorService {
  private cachedAvailability: SimAvailability | null = null;
  private maestro: MaestroBackend | null = null;
  private typeNames: Map<string, string> | null = null;
  private detachEnsured = false;

  private maestroBackend(): MaestroBackend {
    this.maestro ??= new MaestroBackend();
    return this.maestro;
  }

  async availability(): Promise<SimAvailability> {
    if (this.cachedAvailability) return this.cachedAvailability;
    const availability: SimAvailability = {
      simctl: false,
      idb: false,
      maestro: false,
      xcode: false,
    };
    if (process.platform !== "darwin") {
      this.cachedAvailability = availability;
      return availability;
    }
    availability.simctl = await this.probe("xcrun", ["simctl", "help"]);
    // `idb list-targets` exits 0 only when the idb CLI *and* its idb_companion are functional
    // (`idb --version` is not a valid flag; `idb --help` passes even without a working companion).
    availability.idb = await this.probe("idb", ["list-targets"]);
    availability.maestro = await probeMaestro();
    try {
      const result = await execCommand("xcode-select", ["-p"], { timeout: 10_000 });
      availability.xcode = (result.stdout ?? "").includes("Xcode.app");
    } catch {
      availability.xcode = false;
    }
    this.cachedAvailability = availability;
    return availability;
  }

  // HID (tap/swipe/type + element tree) comes from idb when present, else Maestro. Throws a clear
  // error when neither backend is available.
  private async hidMode(): Promise<"idb" | "maestro"> {
    const a = await this.availability();
    if (a.idb) return "idb";
    if (a.maestro) return "maestro";
    throw new Error(
      "No simulator input backend: install idb (idb_companion) or Maestro to tap/swipe/type",
    );
  }

  private async probe(command: string, args: string[]): Promise<boolean> {
    try {
      await execCommand(command, args, { timeout: 10_000 });
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<SimSnapshot> {
    const availability = await this.availability();
    if (!availability.simctl) return { availability, devices: [] };
    let devices: SimDevice[];
    try {
      const result = await execCommand("xcrun", ["simctl", "list", "devices", "--json"], {
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      devices = parseDevices(result.stdout ?? "", await this.deviceTypeNames());
    } catch {
      return { availability, devices: [] };
    }
    // slimState stays "unknown" here: reading it spawns `launchctl` per booted device, and this
    // runs on every fleet sweep. sim_slim / sim_unslim report the state they leave behind.
    return { availability, devices };
  }

  // identifier → Apple's display name ("…SimDeviceType.iPhone-SE-3rd-generation" → "iPhone SE (3rd
  // generation)"). The identifier alone loses the parentheses the device classifier relies on, and
  // a device's own `name` is user-chosen, so the fleet reports the real type name.
  private async deviceTypeNames(): Promise<Map<string, string>> {
    if (this.typeNames) return this.typeNames;
    const names = new Map<string, string>();
    try {
      const result = await execCommand("xcrun", ["simctl", "list", "devicetypes", "--json"], {
        timeout: 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const parsed = JSON.parse(result.stdout ?? "") as { devicetypes?: RawDeviceType[] };
      for (const t of parsed.devicetypes ?? []) {
        if (t.identifier && t.name) names.set(t.identifier, t.name);
      }
    } catch {
      return names; // not cached — retried on the next list
    }
    this.typeNames = names;
    return names;
  }

  // Every (runtime → creatable device types) pair on this Mac, iOS only.
  async catalog(): Promise<SimRuntime[]> {
    const result = await execCommand("xcrun", ["simctl", "list", "runtimes", "--json"], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseRuntimes(result.stdout ?? "");
  }

  // `simctl create` prints the new UDID. Booting is headless (see bootAndWait).
  async create(
    name: string,
    deviceTypeId: string,
    runtimeId: string,
    boot: boolean,
  ): Promise<string> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Simulator name is required");
    const result = await execCommand(
      "xcrun",
      ["simctl", "create", trimmed, deviceTypeId, runtimeId],
      { timeout: 60_000 },
    );
    const udid = (result.stdout ?? "").trim();
    if (!udid) throw new Error("simctl create returned no UDID");
    if (boot) await this.bootAndWait(udid);
    return udid;
  }

  // `simctl boot` is headless: it never opens Simulator.app. But a Simulator.app the user already
  // has open attaches a window to every booted device in the default set, and by default quitting
  // it (or closing that window) SHUTS the device down — killing a sim an agent is driving. These two
  // Simulator.app preferences make quit/close only detach the window, so fleet devices keep running.
  // (A private `simctl --set` would hide devices from Simulator.app entirely, but Maestro — the HID
  // backend where idb can't install — only sees the default set.)
  private async ensureDetachedFromSimulatorApp(): Promise<void> {
    if (this.detachEnsured) return;
    this.detachEnsured = true;
    for (const key of ["DetachOnAppQuit", "DetachOnWindowClose"]) {
      await execCommand("defaults", ["write", "com.apple.iphonesimulator", key, "-bool", "YES"], {
        timeout: 10_000,
      }).catch(() => {});
    }
  }

  async bootAndWait(udid: string): Promise<void> {
    await this.ensureDetachedFromSimulatorApp();
    await execCommand("xcrun", ["simctl", "boot", udid], { timeout: 120_000 }).catch((error) => {
      // "current state: Booted" is not a failure.
      if (!/already booted|current state: Booted/i.test(stderrMessage(error))) throw error;
    });
    await execCommand("xcrun", ["simctl", "bootstatus", udid, "-b"], { timeout: 180_000 }).catch(
      () => {},
    );
  }

  async action(udid: string, action: SimAction): Promise<void> {
    if (action === "boot") {
      await this.bootAndWait(udid);
      return;
    }
    if (action === "shutdown") {
      await execCommand("xcrun", ["simctl", "shutdown", udid], { timeout: 60_000 });
      return;
    }
    // erase / delete require the device shut down first.
    await execCommand("xcrun", ["simctl", "shutdown", udid], { timeout: 60_000 }).catch(() => {});
    await execCommand("xcrun", ["simctl", action, udid], { timeout: 60_000 });
  }

  private async idb(args: string[], timeout = 30_000): Promise<string> {
    const availability = await this.availability();
    if (!availability.idb) {
      throw new Error("idb is not installed — run `brew install idb-companion` for HID control");
    }
    const result = await execCommand("idb", args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return result.stdout ?? "";
  }

  async tap(udid: string, x: number, y: number): Promise<void> {
    if ((await this.hidMode()) === "maestro") return this.maestroBackend().tap(udid, x, y);
    await this.idb(["ui", "tap", "--udid", udid, String(Math.round(x)), String(Math.round(y))]);
  }

  async swipe(
    udid: string,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    durationMs?: number,
  ): Promise<void> {
    if ((await this.hidMode()) === "maestro") {
      return this.maestroBackend().swipe(udid, x1, y1, x2, y2, durationMs);
    }
    const args = [
      "ui",
      "swipe",
      "--udid",
      udid,
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
    ];
    if (durationMs && durationMs > 0) args.push("--duration", String(durationMs / 1000));
    await this.idb(args);
  }

  async inputText(udid: string, text: string): Promise<void> {
    if ((await this.hidMode()) === "maestro") return this.maestroBackend().inputText(udid, text);
    await this.idb(["ui", "text", "--udid", udid, text]);
  }

  async button(udid: string, button: SimButton): Promise<void> {
    // Hardware buttons need idb; Maestro has no reliable iOS hardware-button command.
    const a = await this.availability();
    if (!a.idb) throw new Error("Hardware buttons require idb (idb_companion)");
    await this.idb(["ui", "button", "--udid", udid, IDB_BUTTON[button]]);
  }

  async describeUi(udid: string): Promise<SimUiElement[]> {
    if ((await this.hidMode()) === "maestro") return this.maestroBackend().describeUi(udid);
    const out = await this.idb(["ui", "describe-all", "--udid", udid, "--json"]);
    return parseUiElements(out);
  }

  // Capture the screen. `simctl io screenshot --type` encodes PNG or JPEG natively; idb always
  // writes PNG. `maxDim` downsamples (macOS `sips`) only when the frame is larger than asked.
  async screenshot(
    udid: string,
    opts: { format?: SimScreenshotFormat; maxDim?: number } = {},
  ): Promise<SimScreenshot> {
    const availability = await this.availability();
    const format = opts.format ?? "png";
    const nativeFormat = availability.idb ? "png" : format;
    const raw = join(
      tmpdir(),
      `simfleet-${randomUUID()}.${nativeFormat === "jpeg" ? "jpg" : "png"}`,
    );
    const out = join(tmpdir(), `simfleet-${randomUUID()}.${format === "jpeg" ? "jpg" : "png"}`);
    try {
      if (availability.idb) {
        await this.idb(["screenshot", "--udid", udid, raw]);
      } else {
        await execCommand("xcrun", ["simctl", "io", udid, "screenshot", `--type=${format}`, raw], {
          timeout: 30_000,
        });
      }
      let bytes = await readFile(raw);
      let dims = imageSize(bytes);
      const oversize =
        opts.maxDim !== undefined && dims && Math.max(dims.width, dims.height) > opts.maxDim;
      if (oversize || nativeFormat !== format) {
        const args = ["-s", "format", format];
        if (format === "jpeg") args.push("-s", "formatOptions", "80");
        if (oversize && opts.maxDim !== undefined) args.push("-Z", String(opts.maxDim));
        await execCommand("sips", [...args, raw, "--out", out], { timeout: 30_000 });
        bytes = await readFile(out);
        dims = imageSize(bytes);
      }
      return {
        base64: bytes.toString("base64"),
        mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
        width: dims?.width ?? 0,
        height: dims?.height ?? 0,
      };
    } finally {
      await unlink(raw).catch(() => {});
      await unlink(out).catch(() => {});
    }
  }

  async installApp(udid: string, appPath: string): Promise<void> {
    await execCommand("xcrun", ["simctl", "install", udid, appPath], { timeout: 120_000 });
  }

  async launchApp(udid: string, bundleId: string, terminateExisting?: boolean): Promise<void> {
    const args = ["simctl", "launch"];
    if (terminateExisting) args.push("--terminate-running-process");
    args.push(udid, bundleId);
    await execCommand("xcrun", args, { timeout: 60_000 });
  }

  async terminateApp(udid: string, bundleId: string): Promise<void> {
    await execCommand("xcrun", ["simctl", "terminate", udid, bundleId], { timeout: 30_000 });
  }

  async openUrl(udid: string, url: string): Promise<void> {
    await execCommand("xcrun", ["simctl", "openurl", udid, url], { timeout: 30_000 });
  }

  async slim(udid: string, reboot: boolean) {
    return slim(udid, reboot, (id) => this.bootAndWait(id));
  }

  async unslim(udid: string) {
    return unslim(udid);
  }
}

interface RawDevice {
  udid?: string;
  name?: string;
  state?: string;
  isAvailable?: boolean;
  deviceTypeIdentifier?: string;
}

interface RawDeviceType {
  identifier?: string;
  name?: string;
  productFamily?: string;
}

interface RawRuntime {
  identifier?: string;
  name?: string;
  platform?: string;
  isAvailable?: boolean;
  supportedDeviceTypes?: RawDeviceType[];
}

export function parseRuntimes(json: string): SimRuntime[] {
  let parsed: { runtimes?: RawRuntime[] };
  try {
    parsed = JSON.parse(json) as { runtimes?: RawRuntime[] };
  } catch {
    return [];
  }
  const out: SimRuntime[] = [];
  for (const r of parsed.runtimes ?? []) {
    if (r.isAvailable === false || !r.identifier || !r.identifier.includes("iOS")) continue;
    const deviceTypes: SimDeviceType[] = [];
    for (const t of r.supportedDeviceTypes ?? []) {
      if (!t.identifier || !t.name) continue;
      deviceTypes.push({
        identifier: t.identifier,
        name: t.name,
        productFamily: t.productFamily ?? "",
      });
    }
    out.push({ identifier: r.identifier, name: r.name ?? runtimeLabel(r.identifier), deviceTypes });
  }
  // Newest runtime first — the sensible default in a picker ("iOS 17.10" sorts after "iOS 17.5").
  return out.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
}

export function parseDevices(json: string, typeNames?: Map<string, string>): SimDevice[] {
  let parsed: { devices?: Record<string, RawDevice[]> };
  try {
    parsed = JSON.parse(json) as { devices?: Record<string, RawDevice[]> };
  } catch {
    return [];
  }
  const out: SimDevice[] = [];
  for (const [runtimeKey, list] of Object.entries(parsed.devices ?? {})) {
    if (!runtimeKey.includes("iOS")) continue; // SimFleet targets iOS simulators
    for (const raw of list ?? []) {
      if (raw.isAvailable === false || !raw.udid) continue;
      const state = raw.state ?? "Shutdown";
      out.push({
        udid: raw.udid,
        name: raw.name ?? "",
        state,
        isBooted: state === "Booted",
        runtime: runtimeLabel(runtimeKey),
        deviceType:
          (raw.deviceTypeIdentifier && typeNames?.get(raw.deviceTypeIdentifier)) ||
          deviceTypeLabel(raw.deviceTypeIdentifier),
        slimState: "unknown",
      });
    }
  }
  return out.sort(
    (a, b) => Number(b.isBooted) - Number(a.isBooted) || a.name.localeCompare(b.name),
  );
}

interface RawUiElement {
  AXFrame?: string;
  frame?: { x?: number; y?: number; width?: number; height?: number };
  AXLabel?: string;
  AXUniqueId?: string;
  role?: string;
  type?: string;
  role_description?: string;
  enabled?: boolean;
  AXValue?: string;
}

// idb prints one JSON object per line (or a JSON array) describing the accessibility tree.
export function parseUiElements(out: string): SimUiElement[] {
  const trimmed = out.trim();
  if (!trimmed) return [];
  let raws: RawUiElement[] = [];
  try {
    const asArray = JSON.parse(trimmed) as RawUiElement[] | RawUiElement;
    raws = Array.isArray(asArray) ? asArray : [asArray];
  } catch {
    raws = trimmed
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RawUiElement];
        } catch {
          return [];
        }
      });
  }
  return raws.flatMap((raw) => {
    const frame = parseFrame(raw);
    if (!frame) return [];
    return [
      {
        role: raw.type ?? raw.role ?? raw.role_description ?? "",
        label: raw.AXLabel ?? raw.AXValue ?? "",
        identifier: raw.AXUniqueId ?? "",
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        enabled: raw.enabled !== false,
      },
    ];
  });
}

function parseFrame(
  raw: RawUiElement,
): { x: number; y: number; width: number; height: number } | null {
  if (raw.frame && typeof raw.frame.x === "number") {
    return {
      x: raw.frame.x ?? 0,
      y: raw.frame.y ?? 0,
      width: raw.frame.width ?? 0,
      height: raw.frame.height ?? 0,
    };
  }
  // AXFrame is a CGRect-ish string: "{{x, y}, {w, h}}"
  if (typeof raw.AXFrame === "string") {
    const nums = raw.AXFrame.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
    if (nums && nums.length >= 4) {
      return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
    }
  }
  return null;
}
