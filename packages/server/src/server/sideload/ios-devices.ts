import type { RunProcess } from "./process.js";

/**
 * Physical iPhone/iPad discovery and app install through go-ios (MIT, a separate process)
 * over the host's usbmuxd: USB, and Wi-Fi for devices paired once and set to sync over
 * Wi-Fi (26.7). Shared with real-device control (spec 27). go-ios prints JSON on stdout and
 * JSON log lines on stderr.
 */

export interface IosDevice {
  udid: string;
  name: string;
  /** ProductType, e.g. iPhone14,2. */
  model: string;
  osVersion: string;
  connection: "usb" | "wifi";
  /** False when lockdown refused: the device has not trusted this computer yet. */
  paired: boolean;
}

export interface InstalledIosApp {
  bundleId: string;
  name: string;
  version: string;
}

export class IosDeviceError extends Error {
  constructor(
    readonly code: "go_ios_missing" | "device_not_found" | "install_failed" | "device_error",
    message: string,
  ) {
    super(message);
    this.name = "IosDeviceError";
  }
}

interface DetailsEntry {
  Udid?: unknown;
  ProductType?: unknown;
  ProductVersion?: unknown;
  ConnectionType?: unknown;
}

function lastJsonObject(text: string): Record<string, unknown> | null {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith("{"));
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index]!);
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      continue;
    }
  }
  return null;
}

/** The error go-ios logged (`{"level":"ERROR","msg":…,"err":…}`), else the raw tail. */
export function goIosError(stderr: string): string {
  for (const line of stderr.split(/\r?\n/).toReversed()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const entry = JSON.parse(line) as { level?: string; msg?: string; err?: string };
      if (entry.level === "ERROR") return [entry.msg, entry.err].filter(Boolean).join(": ");
    } catch {
      continue;
    }
  }
  return stderr.trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 400);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parseDetailedList(stdout: string): IosDevice[] {
  const json = lastJsonObject(stdout);
  const list = Array.isArray(json?.deviceList) ? (json.deviceList as unknown[]) : [];
  const byUdid = new Map<string, IosDevice>();
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as DetailsEntry;
    const udid = asText(entry.Udid);
    if (!udid) continue;
    const connection = asText(entry.ConnectionType) === "Network" ? "wifi" : "usb";
    const device: IosDevice = {
      udid,
      name: "",
      model: asText(entry.ProductType),
      osVersion: asText(entry.ProductVersion),
      connection,
      paired: true,
    };
    // A device on both cable and Wi-Fi is listed twice: keep the USB entry.
    const existing = byUdid.get(udid);
    if (!existing || (existing.connection === "wifi" && connection === "usb")) {
      byUdid.set(udid, device);
    }
  }
  return [...byUdid.values()];
}

export function parsePlainList(stdout: string): string[] {
  const json = lastJsonObject(stdout);
  const list = Array.isArray(json?.deviceList) ? (json.deviceList as unknown[]) : [];
  return [...new Set(list.filter((item): item is string => typeof item === "string"))];
}

export class GoIos {
  constructor(
    private readonly binary: () => string | null,
    private readonly run: RunProcess,
  ) {}

  private path(): string {
    const binary = this.binary();
    if (!binary) {
      throw new IosDeviceError(
        "go_ios_missing",
        "go-ios is not installed. Install it from Settings → Host tools.",
      );
    }
    return binary;
  }

  available(): boolean {
    return this.binary() !== null;
  }

  async list(): Promise<IosDevice[]> {
    const binary = this.path();
    const detailed = await this.run(binary, ["list", "--details"], { timeoutMs: 20_000 });
    let devices: IosDevice[];
    if (detailed.code === 0) {
      devices = parseDetailedList(detailed.stdout);
    } else {
      // One untrusted device fails the detailed listing; list ids and mark them unpaired.
      const plain = await this.run(binary, ["list"], { timeoutMs: 20_000 });
      if (plain.code !== 0) throw new IosDeviceError("device_error", goIosError(plain.stderr));
      devices = parsePlainList(plain.stdout).map((udid) => ({
        udid,
        name: "",
        model: "",
        osVersion: "",
        connection: "usb" as const,
        paired: false,
      }));
    }
    return Promise.all(devices.map((device) => this.withName(binary, device)));
  }

  private async withName(binary: string, device: IosDevice): Promise<IosDevice> {
    const result = await this.run(binary, ["devicename", `--udid=${device.udid}`], {
      timeoutMs: 10_000,
    });
    const json = lastJsonObject(result.stdout);
    const name = asText(json?.devicename) || result.stdout.trim().replace(/^"|"$/g, "");
    if (result.code !== 0) return { ...device, name: device.model || "iOS device", paired: false };
    return { ...device, name: name || device.model || "iOS device" };
  }

  /** Installs an IPA or .app; `onPercent` gets installation_proxy progress. */
  async install(input: {
    udid: string;
    path: string;
    onPercent?: (percent: number, status: string) => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const result = await this.run(
      this.path(),
      ["install", `--path=${input.path}`, `--udid=${input.udid}`],
      {
        timeoutMs: 20 * 60_000,
        signal: input.signal,
        onStderrLine: (line) => {
          if (!input.onPercent || !line.includes("percentComplete")) return;
          try {
            const entry = JSON.parse(line) as { percentComplete?: number; status?: string };
            if (typeof entry.percentComplete === "number") {
              input.onPercent(entry.percentComplete, entry.status ?? "");
            }
          } catch {
            return;
          }
        },
      },
    );
    if (result.code !== 0) throw new IosDeviceError("install_failed", goIosError(result.stderr));
  }

  async uninstall(udid: string, bundleId: string): Promise<void> {
    const result = await this.run(this.path(), ["uninstall", bundleId, `--udid=${udid}`], {
      timeoutMs: 120_000,
    });
    if (result.code !== 0) throw new IosDeviceError("device_error", goIosError(result.stderr));
  }

  async apps(udid: string): Promise<InstalledIosApp[]> {
    const result = await this.run(this.path(), ["apps", "--list", `--udid=${udid}`], {
      timeoutMs: 60_000,
    });
    if (result.code !== 0) throw new IosDeviceError("device_error", goIosError(result.stderr));
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("{"))
      .map((line) => {
        const [bundleId = "", ...rest] = line.split(" ");
        const version = rest.length > 1 ? (rest.pop() ?? "") : "";
        return { bundleId, name: rest.join(" "), version };
      });
  }
}
