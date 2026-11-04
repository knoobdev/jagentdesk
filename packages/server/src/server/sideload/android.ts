import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RunProcess } from "./process.js";
import { extractZip, listZip } from "./zip.js";

/**
 * Android install (26.8): `adb install -r` for an APK, `adb install-multiple -r` for split
 * APKs and `.apks`/`.xapk` bundles, on phones plugged in with a USB cable. No re-signing, no
 * package rename. The daemon never runs `adb pair`, `adb connect` or `adb tcpip` (27.1,
 * ADR-0033 §4); a device someone connected over the network by hand is not listed.
 */

export interface AndroidDevice {
  serial: string;
  state: string;
  model: string;
  osVersion: string;
  connection: "usb";
}

export class AndroidError extends Error {
  constructor(
    readonly code: "adb_missing" | "install_failed" | "invalid_input",
    message: string,
  ) {
    super(message);
    this.name = "AndroidError";
  }
}

export function parseAdbDevices(stdout: string): AndroidDevice[] {
  const devices: AndroidDevice[] = [];
  for (const line of stdout.split(/\r?\n/).slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*")) continue;
    const [serial = "", state = "", ...fields] = trimmed.split(/\s+/);
    const props = Object.fromEntries(
      fields.flatMap((field) => {
        const index = field.indexOf(":");
        return index > 0 ? [[field.slice(0, index), field.slice(index + 1)]] : [];
      }),
    );
    // `<host>:<port>` and `adb-<guid>._adb-tls-connect._tcp` are network connections: cable only.
    if (serial.includes(":") || serial.includes("._adb-tls-connect.")) continue;
    devices.push({
      serial,
      state,
      model: (props.model ?? "").replace(/_/g, " "),
      osVersion: "",
      connection: "usb",
    });
  }
  return devices;
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

export class Adb {
  constructor(
    private readonly binary: () => string | null,
    private readonly run: RunProcess,
  ) {}

  private path(): string {
    const binary = this.binary();
    if (!binary) {
      throw new AndroidError(
        "adb_missing",
        "adb was not found. Install Android platform-tools (Settings → Host tools) or set ANDROID_HOME.",
      );
    }
    return binary;
  }

  available(): boolean {
    return this.binary() !== null;
  }

  async list(): Promise<AndroidDevice[]> {
    const adb = this.path();
    const result = await this.run(adb, ["devices", "-l"], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new AndroidError("install_failed", outputOf(result));
    const devices = parseAdbDevices(result.stdout);
    return Promise.all(
      devices.map(async (device) => {
        if (device.state !== "device") return device;
        const version = await this.run(
          adb,
          ["-s", device.serial, "shell", "getprop", "ro.build.version.release"],
          { timeoutMs: 10_000 },
        );
        device.osVersion = version.code === 0 ? version.stdout.trim() : "";
        return device;
      }),
    );
  }

  /** One APK, several split APKs of one app, or one `.apks` / `.xapk` bundle. */
  async install(serial: string, paths: readonly string[]): Promise<string> {
    const adb = this.path();
    const bundles = paths.filter((file) => /\.(apks|xapk)$/i.test(file));
    if (bundles.length > 0 && paths.length > 1) {
      throw new AndroidError("invalid_input", "Install one .apks/.xapk bundle at a time.");
    }
    if (paths.some((file) => !/\.(apk|apks|xapk)$/i.test(file))) {
      throw new AndroidError("invalid_input", "Only .apk, .apks and .xapk files can be installed.");
    }
    if (bundles[0]) return this.installBundle(adb, serial, bundles[0]);
    const args =
      paths.length === 1
        ? ["-s", serial, "install", "-r", paths[0]!]
        : ["-s", serial, "install-multiple", "-r", ...paths];
    return this.runInstall(adb, args);
  }

  private async installBundle(adb: string, serial: string, bundle: string): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "jad-apks-"));
    try {
      const splits = (await listZip(bundle))
        .filter((entry) => !entry.isDirectory && entry.name.toLowerCase().endsWith(".apk"))
        .map((entry) => entry.name);
      if (splits.length === 0) {
        throw new AndroidError("invalid_input", `${path.basename(bundle)} holds no APK files`);
      }
      await extractZip(bundle, dir, (entry) => splits.includes(entry.name));
      const files = splits.map((name) => path.join(dir, name));
      return await this.runInstall(adb, ["-s", serial, "install-multiple", "-r", ...files]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async runInstall(adb: string, args: string[]): Promise<string> {
    const result = await this.run(adb, args, { timeoutMs: 15 * 60_000 });
    const output = outputOf(result);
    // adb exits 0 on some failures; "Success" is the contract.
    if (result.code !== 0 || !/\bSuccess\b/.test(output)) {
      throw new AndroidError("install_failed", output.slice(-1200) || "adb install failed");
    }
    return output;
  }
}
