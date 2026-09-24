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
  SimUiElement,
} from "@jagentdesk/protocol/simulator/rpc-schemas";
import { readSlimState, slim, unslim } from "./simulator-slim.js";
import { MaestroBackend, probeMaestro } from "./simulator-maestro.js";

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
      devices = parseDevices(result.stdout ?? "");
    } catch {
      return { availability, devices: [] };
    }
    // Slim state is only readable on a booted device; read it just for those (usually few).
    await Promise.all(
      devices.map(async (device) => {
        if (device.isBooted) device.slimState = await readSlimState(device.udid, true);
      }),
    );
    return { availability, devices };
  }

  async bootAndWait(udid: string): Promise<void> {
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

  async screenshot(udid: string): Promise<string> {
    const availability = await this.availability();
    const file = join(tmpdir(), `simfleet-${randomUUID()}.png`);
    try {
      if (availability.idb) {
        await this.idb(["screenshot", "--udid", udid, file]);
      } else {
        await execCommand("xcrun", ["simctl", "io", udid, "screenshot", file], {
          timeout: 30_000,
        });
      }
      const bytes = await readFile(file);
      return bytes.toString("base64");
    } finally {
      await unlink(file).catch(() => {});
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

export function parseDevices(json: string): SimDevice[] {
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
        deviceType: deviceTypeLabel(raw.deviceTypeIdentifier),
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
